// W6-B/W6-C: goal loops + pipeline runs. Both engines are event-driven:
// the relay's HTTP routes only emit events (GoalCreated, PipelineStarted, …);
// the engines react to those events and drive work through the SAME dispatch
// pipeline humans use — a synthetic "orchestrator" human posts @mention
// messages and awaits the channel drain. Guardrails are hard stops.
import type { GoalRecord, PipelineRun, TurnCost, User } from "../../shared/contracts.ts";
import { EventKind } from "../../shared/contracts.ts";
import { onEvent, type Relay } from "../relay.ts";
import type { Dispatcher } from "./dispatcher.ts";

const ORCHESTRATOR: User = { id: "orchestrator", name: "Orchestrator", kind: "human" };

export type Engines = {
  dispose: () => void;
  /** Test seam: resolves when no goal or pipeline loop is mid-flight. */
  settled: () => Promise<void>;
};

export function createEngines(relay: Relay, dispatcher: Dispatcher): Engines {
  const { projections } = relay;
  let active = 0;
  const settleWaiters: Array<() => void> = [];
  /** Pipeline runs paused on an approval gate, keyed by run id. */
  const gatedRuns = new Set<string>();

  const track = async (work: () => Promise<void>): Promise<void> => {
    active += 1;
    try {
      await work();
    } finally {
      active -= 1;
      if (active === 0) {
        while (settleWaiters.length > 0) settleWaiters.shift()!();
      }
    }
  };

  const ensureOrchestrator = (): void => {
    if (!projections.users.has(ORCHESTRATOR.id)) {
      relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.MemberAdded, userId: ORCHESTRATOR.id, user: ORCHESTRATOR });
    }
  };

  const lastAgentReply = (channelId: string, agentId: string): string => {
    const items = projections.transcripts.get(channelId) ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "message" && item.authorId === agentId) return item.text;
    }
    return "";
  };

  const costsSince = (mark: number): number =>
    projections.costs.slice(mark).reduce((sum: number, c: TurnCost) => sum + c.estUsd, 0);

  // ---- W6-B: goal loop ----

  const guardrailBreach = (goal: GoalRecord, stuck: number): string | null => {
    const g = goal.guardrails;
    if (goal.sessions >= g.maxSessions) return `session cap reached (${g.maxSessions})`;
    if (goal.spentUsd >= g.spendCapUsd) return `spend cap reached ($${g.spendCapUsd})`;
    if (Date.now() - goal.startedAt >= g.wallClockMinutes * 60_000) return `wall clock exceeded (${g.wallClockMinutes}m)`;
    if (stuck >= g.stuckThreshold) return `stuck: ${stuck} sessions without progress`;
    return null;
  };

  const runGoal = async (goalId: string): Promise<void> => {
    ensureOrchestrator();
    let stuck = 0;
    for (;;) {
      const goal = projections.goals.get(goalId);
      if (!goal || goal.status !== "running") return;
      const breach = guardrailBreach(goal, stuck);
      if (breach) {
        relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.GoalHalted, goalId, reason: breach }, goal.channelId);
        return;
      }
      const open = goal.criteria.find((c) => !c.done);
      if (!open) {
        relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.GoalCompleted, goalId }, goal.channelId);
        return;
      }
      const agent = projections.agents.get(goal.agentId);
      if (!agent) {
        relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.GoalHalted, goalId, reason: "agent missing" }, goal.channelId);
        return;
      }
      const session = goal.sessions + 1;
      const costMark = projections.costs.length;
      relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.GoalSessionStarted, goalId, session }, goal.channelId);
      relay.emitEvent(
        ORCHESTRATOR.id,
        {
          kind: EventKind.Message,
          text: `@${agent.name} work on criterion [${open.id}]: ${open.text}. Reply starting with DONE if satisfied, BLOCKED if not.`,
        },
        goal.channelId,
      );
      await dispatcher.idle(goal.channelId);
      const reply = lastAgentReply(goal.channelId, agent.id);
      if (/^done/i.test(reply.trim())) {
        stuck = 0;
        relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.GoalCriterionChecked, goalId, criterionId: open.id }, goal.channelId);
      } else {
        stuck += 1;
      }
      relay.emitEvent(
        ORCHESTRATOR.id,
        { kind: EventKind.GoalSessionCompleted, goalId, session, spentUsd: goal.spentUsd + costsSince(costMark) },
        goal.channelId,
      );
    }
  };

  // ---- W6-C: pipeline runs ----

  const runPipeline = async (runId: string, fromStep: number): Promise<void> => {
    ensureOrchestrator();
    for (let i = fromStep; ; i++) {
      const run = projections.pipelines.get(runId);
      const template = run ? projections.templates.get(run.templateId) : undefined;
      if (!run || !template || run.status !== "running") return;
      if (i >= template.steps.length) {
        relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.PipelineCompleted, runId }, run.channelId);
        return;
      }
      const step = template.steps[i]!;
      const agent = projections.agents.get(step.agentId);
      relay.emitEvent(ORCHESTRATOR.id, { kind: EventKind.PipelineStepStarted, runId, stepIndex: i }, run.channelId);
      if (agent) {
        relay.emitEvent(
          ORCHESTRATOR.id,
          { kind: EventKind.Message, text: `@${agent.name} [${step.title}] ${step.prompt} Input: ${run.input}` },
          run.channelId,
        );
        await dispatcher.idle(run.channelId);
      }
      relay.emitEvent(
        ORCHESTRATOR.id,
        { kind: EventKind.PipelineStepCompleted, runId, stepIndex: i, gated: step.requiresApproval },
        run.channelId,
      );
      if (step.requiresApproval) {
        gatedRuns.add(runId); // parked until a human advance re-emits step-completed
        return;
      }
    }
  };

  const unsubscribe = onEvent((ev) => {
    const body = ev.body;
    if (body.kind === EventKind.GoalCreated && projections.goals.has(body.goal.id)) {
      void track(() => runGoal(body.goal.id));
      return;
    }
    if (body.kind === EventKind.PipelineStarted && projections.pipelines.has(body.run.id)) {
      void track(() => runPipeline(body.run.id, 0));
      return;
    }
    // Human approval of a gated step: the relay re-emits kind-103 with gated:false.
    if (body.kind === EventKind.PipelineStepCompleted && !body.gated && gatedRuns.has(body.runId)) {
      gatedRuns.delete(body.runId);
      void track(() => runPipeline(body.runId, body.stepIndex + 1));
    }
  });

  return {
    dispose: unsubscribe,
    settled: async () => {
      // Give freshly-emitted events one microtask to reach the hooks first.
      await new Promise((r) => setTimeout(r, 10));
      if (active === 0) return;
      await new Promise<void>((resolve) => settleWaiters.push(resolve));
    },
  };
}
