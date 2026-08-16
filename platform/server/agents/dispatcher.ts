// T7: agent dispatcher — @mention/DM routing, per-channel FIFO queue with
// single-in-flight turns and QUEUE policy (batch ≤10), D10 context assembly.
// Also owns tool routing: memory_propose (T8 gates) and sandbox_exec (T9
// approvals + audit).
import crypto from "node:crypto";
import type { AgentRecord, Approval, Channel } from "../../shared/contracts.ts";
import { EventKind } from "../../shared/contracts.ts";
import { onEvent, type Relay } from "../relay.ts";
import type { AgentDriver, ToolDef, ToolResult } from "./driver.ts";
import { MockDriver } from "./mock.ts";
import { runDataQuery } from "./dataset.ts";
import { buildProposal, injectableMemory, wrapDataBlock } from "./memory-gates.ts";
import { LocalSandboxProvider, type SandboxProvider } from "./sandbox.ts";

const MAX_BATCH = 10;
const TRANSCRIPT_WINDOW = 30;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "sandbox_exec",
    description: "Run an allowlisted command in the agent's sandbox.",
    inputSchema: {
      type: "object",
      properties: { argv: { type: "array", items: { type: "string" } } },
      required: ["argv"],
    },
  },
  {
    name: "memory_propose",
    description: "Propose a memory entry for human review.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["org", "space", "personal"] },
        kind: { type: "string" },
        content: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "data_query",
    description: "Plan-then-execute a question over the bundled finance dataset; the plan is audited.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

type QueueItem = { agent: AgentRecord; authorId: string; text: string };

export type Dispatcher = {
  dispose: () => void;
  /** Test seam: resolves once the channel's queue is fully drained. */
  idle: (channelId: string) => Promise<void>;
};

export type DispatcherOptions = {
  driverFor?: (agent: AgentRecord) => AgentDriver;
  sandboxProvider?: SandboxProvider;
};

/** Longest-match-wins @mention resolution among the channel's agent members. */
export function resolveMentions(text: string, agents: AgentRecord[]): AgentRecord[] {
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  const hits: AgentRecord[] = [];
  let remaining = text;
  for (const agent of sorted) {
    const needle = `@${agent.name}`;
    if (remaining.includes(needle)) {
      hits.push(agent);
      remaining = remaining.split(needle).join("\u0000");
    }
  }
  return hits;
}

export function createDispatcher(relay: Relay, options: DispatcherOptions = {}): Dispatcher {
  const mock = new MockDriver();
  const driverFor = options.driverFor ?? (() => mock);
  const sandboxes = options.sandboxProvider ?? new LocalSandboxProvider();
  const { projections } = relay;

  const queues = new Map<string, QueueItem[]>();
  const inFlight = new Set<string>();
  const drainWaiters = new Map<string, Array<() => void>>();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();

  const resolveTargets = (channel: Channel, text: string): AgentRecord[] => {
    const agentMembers = channel.memberIds
      .map((id) => projections.agents.get(id))
      .filter((a): a is AgentRecord => !!a);
    if (agentMembers.length === 0) return [];
    const mentioned = resolveMentions(text, agentMembers);
    if (mentioned.length > 0) return mentioned;
    // DM-style channel: 2 members, exactly one of them an agent.
    if (channel.memberIds.length === 2 && agentMembers.length === 1) return agentMembers;
    return [];
  };

  const runSandboxExec = async (
    agent: AgentRecord,
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const argv = Array.isArray(args["argv"]) ? (args["argv"] as string[]) : [];
    if (!agent.allowTools.includes("sandbox_exec")) {
      const approval: Approval = {
        id: crypto.randomUUID(),
        agentId: agent.id,
        channelId,
        tool: "sandbox_exec",
        args,
        status: "pending",
      };
      const decision = new Promise<boolean>((resolve) => {
        pendingApprovals.set(approval.id, resolve);
      });
      relay.emitEvent(agent.id, { kind: EventKind.ApprovalRequested, approval }, channelId);
      const approved = await decision; // BLOCK until kind-31 resolution
      if (!approved) return { ok: false, output: "tool call denied by approval" };
    }
    try {
      const result = await sandboxes.create(agent.id).exec(argv);
      relay.emitEvent(
        agent.id,
        { kind: EventKind.SandboxExec, agentId: agent.id, argv, exitCode: result.code, stdout: result.stdout },
        channelId,
      );
      return { ok: result.code === 0, output: result.stdout || result.stderr };
    } catch (err) {
      relay.emitEvent(
        agent.id,
        { kind: EventKind.SandboxExec, agentId: agent.id, argv, exitCode: -1, stdout: String(err) },
        channelId,
      );
      return { ok: false, output: String(err) };
    }
  };

  const runTurn = async (channelId: string, agent: AgentRecord, batch: QueueItem[]): Promise<void> => {
    const channel = projections.channels.get(channelId);
    if (!channel) return;
    const turnId = crypto.randomUUID();
    relay.emitEvent(agent.id, { kind: EventKind.AgentTurnStarted, turnId }, channelId);

    // Context assembly — memory wrapped as a D10 data block, never raw.
    const lastAuthor = batch[batch.length - 1]?.authorId ?? "";
    const memory = injectableMemory(projections, channel, lastAuthor);
    const contextBlocks = memory.length > 0 ? [wrapDataBlock(memory)] : [];
    const transcript = (projections.transcripts.get(channelId) ?? [])
      .filter((t) => t.type === "message")
      .slice(-TRANSCRIPT_WINDOW)
      .map((t) => ({
        author: projections.users.get(t.authorId)?.name ?? t.authorId,
        text: t.text,
      }));

    try {
      const { text } = await driverFor(agent).runTurn(
        { agent, contextBlocks, transcript, tools: TOOL_DEFS },
        {
          onDelta: (delta) => {
            relay.emitEvent(
              agent.id,
              { kind: EventKind.AgentStreamDelta, turnId, delta },
              channelId,
              { ephemeral: true },
            );
          },
          onToolCall: async (tool, args): Promise<ToolResult> => {
            if (tool === "memory_propose") {
              const entry = buildProposal({
                scope: args["scope"],
                kind: args["kind"],
                content: String(args["content"] ?? ""),
                author: agent.id,
                sessionRef: turnId,
              });
              relay.emitEvent(agent.id, { kind: EventKind.MemoryProposed, entry }, channelId);
              return { ok: true, output: entry.id };
            }
            if (tool === "data_query") {
              const q = runDataQuery(String(args["question"] ?? ""));
              relay.emitEvent(
                agent.id,
                {
                  kind: EventKind.PlanExecuted,
                  agentId: agent.id,
                  plan: q.plan,
                  sql_like: q.sql_like,
                  resultPreview: q.result.slice(0, 10),
                },
                channelId,
              );
              return { ok: true, output: q.summary };
            }
            if (tool === "sandbox_exec") return runSandboxExec(agent, channelId, args);
            return { ok: false, output: `unknown tool: ${tool}` };
          },
        },
      );
      // Agent-authored message: emitted through the pipeline, but never re-dispatched.
      relay.emitEvent(agent.id, { kind: EventKind.Message, text }, channelId);
      relay.emitEvent(agent.id, { kind: EventKind.AgentTurnCompleted, turnId, text }, channelId);
    } catch (err) {
      relay.emitEvent(
        agent.id,
        { kind: EventKind.AgentTurnCompleted, turnId, text: `turn failed: ${String(err)}` },
        channelId,
      );
    }
  };

  const drain = async (channelId: string): Promise<void> => {
    if (inFlight.has(channelId)) return; // single in-flight turn per channel
    inFlight.add(channelId);
    try {
      for (;;) {
        const queue = queues.get(channelId) ?? [];
        if (queue.length === 0) break;
        // QUEUE policy: batch consecutive queued messages for the same agent
        // (up to 10) into one turn — deliberate vs Buzz's Drop default.
        const agent = queue[0]!.agent;
        const batch: QueueItem[] = [];
        while (queue.length > 0 && queue[0]!.agent.id === agent.id && batch.length < MAX_BATCH) {
          batch.push(queue.shift()!);
        }
        await runTurn(channelId, agent, batch);
      }
    } finally {
      inFlight.delete(channelId);
      const waiters = drainWaiters.get(channelId) ?? [];
      drainWaiters.delete(channelId);
      for (const w of waiters) w();
    }
  };

  const unsubscribe = onEvent((ev) => {
    // Guard: only react to events belonging to this relay's projections
    // (the hook registry is module-global; tests boot several relays).
    if (ev.body.kind === EventKind.ApprovalResolved) {
      const resolve = pendingApprovals.get(ev.body.approvalId);
      if (resolve) {
        pendingApprovals.delete(ev.body.approvalId);
        resolve(ev.body.status === "approved");
      }
      return;
    }
    if (ev.body.kind !== EventKind.Message || !ev.channelId) return;
    const channel = projections.channels.get(ev.channelId);
    if (!channel) return;
    // Agent-authored messages NEVER trigger dispatch (no loops).
    const author = projections.users.get(ev.authorId);
    if (!author || author.kind === "agent") return;

    const targets = resolveTargets(channel, ev.body.text);
    if (targets.length === 0) return;
    const queue = queues.get(ev.channelId) ?? [];
    for (const agent of targets) {
      queue.push({ agent, authorId: ev.authorId, text: ev.body.text });
    }
    queues.set(ev.channelId, queue);
    void drain(ev.channelId);
  });

  return {
    dispose: unsubscribe,
    idle: async (channelId: string) => {
      // Poll-based drain wait (test seam): waiters also wake on drain completion.
      for (;;) {
        if (!inFlight.has(channelId) && (queues.get(channelId) ?? []).length === 0) return;
        await new Promise<void>((resolve) => {
          if (inFlight.has(channelId)) {
            const waiters = drainWaiters.get(channelId) ?? [];
            waiters.push(resolve);
            drainWaiters.set(channelId, waiters);
          } else {
            setTimeout(resolve, 5);
          }
        });
      }
    },
  };
}
