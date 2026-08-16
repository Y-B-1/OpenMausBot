// W7 (E5): Claude Managed Agents driver — the "rented engine room".
// One CMA agent per Atrium agent (created lazily, cached), one CMA session
// per turn, seeded via initial_events and drained by polling the event list
// until the session idles. Constructed only when ANTHROPIC_API_KEY is set;
// never exercised in tests (no network). Typed structurally so the scaffold
// compiles independent of the installed SDK's beta surface.
import Anthropic from "@anthropic-ai/sdk";
import type { AgentDriver, DriverCallbacks, DriverInput } from "./driver.ts";

type ManagedEvent = {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: { type: string };
};

type ManagedBeta = {
  environments: { create(body: { name: string; config: { type: string; networking: { type: string } } }): Promise<{ id: string }> };
  agents: {
    create(body: { name: string; model: string; system?: string; tools: Array<Record<string, unknown>> }): Promise<{ id: string; version: number }>;
  };
  sessions: {
    create(body: Record<string, unknown>): Promise<{ id: string; status: string }>;
    retrieve(id: string): Promise<{ id: string; status: string }>;
    events: { list(sessionId: string): Promise<{ data: ManagedEvent[] }> };
  };
};

const POLL_MS = 1500;
const MAX_WAIT_MS = 10 * 60_000;

export function createManagedDriver(env: NodeJS.ProcessEnv = process.env): AgentDriver | null {
  if (!env["ANTHROPIC_API_KEY"]) return null;
  return new ManagedDriver(new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"] }));
}

export class ManagedDriver implements AgentDriver {
  private readonly beta: ManagedBeta;
  private environmentId: string | null = null;
  /** Atrium agent id → CMA agent id. Create once, reference by ID (never per turn). */
  private readonly cmaAgents = new Map<string, string>();

  constructor(client: Anthropic) {
    this.beta = client.beta as unknown as ManagedBeta;
  }

  private async ensureEnvironment(): Promise<string> {
    if (this.environmentId) return this.environmentId;
    const environment = await this.beta.environments.create({
      name: `atrium-${Date.now()}`,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    this.environmentId = environment.id;
    return environment.id;
  }

  private async ensureAgent(input: DriverInput): Promise<string> {
    const cached = this.cmaAgents.get(input.agent.id);
    if (cached) return cached;
    const created = await this.beta.agents.create({
      name: input.agent.name,
      model: input.agent.modelPolicy.model || "claude-opus-5",
      system: input.agent.persona || undefined,
      tools: [{ type: "agent_toolset_20260401" }],
    });
    this.cmaAgents.set(input.agent.id, created.id);
    return created.id;
  }

  async runTurn(input: DriverInput, callbacks: DriverCallbacks): Promise<{ text: string }> {
    const [environmentId, agentId] = await Promise.all([this.ensureEnvironment(), this.ensureAgent(input)]);
    const context = input.contextBlocks.join("\n\n");
    const transcript = input.transcript.map((t) => `${t.author}: ${t.text}`).join("\n");
    const prompt = [context, transcript].filter(Boolean).join("\n\n") || "(empty channel)";

    const session = await this.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      // Hard dollar cap per turn-session — our guardrail, platform-enforced.
      budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } }, // $5.00 (minor units)
    });

    // Poll the event list until the session idles; surface agent text as deltas.
    const seen = new Set<string>();
    let text = "";
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const { data } = await this.beta.sessions.events.list(session.id);
      for (const ev of data) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (ev.type === "agent.message") {
          for (const block of ev.content ?? []) {
            if (block.type === "text" && block.text) {
              callbacks.onDelta(block.text);
              text += block.text;
            }
          }
        }
      }
      const status = await this.beta.sessions.retrieve(session.id);
      if (status.status !== "running" && status.status !== "rescheduling") break;
      if (Date.now() > deadline) {
        text += "\n[managed session timed out after 10 minutes]";
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return { text: text || "(managed session produced no text)" };
  }
}
