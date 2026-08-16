// Wave 5 (T16): demo seed. Wipes the org log, then replays a realistic
// history through the relay's event pipeline (emitEvent → append → fold), so
// the resulting NDJSON log rebuilds cleanly on any later boot.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRecord, Channel, MemoryEntry, RoutineRecord, User } from "../shared/contracts.ts";
import { EventKind } from "../shared/contracts.ts";
import { createRelay, type Relay } from "./relay.ts";
import { dataDir, EventStore } from "./store.ts";
import { runDataQuery } from "./agents/dataset.ts";

export const SEED_IDS = {
  yosri: "u-yosri",
  maya: "u-maya",
  scout: "a-scout",
  quill: "a-quill",
  ledger: "a-ledger",
  routineUser: "routine",
  general: "c-general",
  finance: "c-finance",
  eng: "c-eng",
  digestRoutine: "r-digest",
} as const;

/** Append the full demo history into an already-created relay. */
export function seedOrg(relay: Relay): void {
  const emit = relay.emitEvent;
  const now = Date.now();

  // ---- People + agents ----
  const human = (id: string, name: string): User => ({ id, name, kind: "human" });
  const yosri = human(SEED_IDS.yosri, "Yosri");
  const maya = human(SEED_IDS.maya, "Maya");
  const routineUser: User = { id: SEED_IDS.routineUser, name: "Routine", kind: "human" };

  const agent = (id: string, name: string, persona: string, allowTools: string[] = []): AgentRecord => ({
    id,
    name,
    persona,
    driver: "mock",
    modelPolicy: { model: "claude-haiku-4-5", effort: "low", maxTokens: 1024 },
    allowTools,
  });
  const scout = agent(SEED_IDS.scout, "Scout", "Researcher: digs up context, cites what it finds.");
  const quill = agent(SEED_IDS.quill, "Quill", "Writer: turns rough notes into crisp prose.");
  const ledger = agent(SEED_IDS.ledger, "Ledger", "Finance analyst: answers with numbers, shows its query plans.", ["data_query"]);

  for (const u of [yosri, maya, routineUser]) {
    emit(u.id, { kind: EventKind.MemberAdded, userId: u.id, user: u });
  }
  for (const a of [scout, quill, ledger]) {
    emit(yosri.id, { kind: EventKind.MemberAdded, userId: a.id, user: { id: a.id, name: a.name, kind: "agent" }, agent: a });
  }

  // ---- Channels ----
  const channel = (id: string, name: string, space: string, memberIds: string[]): Channel => ({ id, name, space, memberIds });
  const general = channel(SEED_IDS.general, "general", "hq", [yosri.id, maya.id, scout.id, quill.id]);
  const finance = channel(SEED_IDS.finance, "finance", "finance", [yosri.id, ledger.id]);
  const eng = channel(SEED_IDS.eng, "eng", "eng", [yosri.id, scout.id]);
  for (const c of [general, finance, eng]) {
    emit(yosri.id, { kind: EventKind.ChannelCreated, channel: c }, c.id);
  }

  // ---- Transcript helpers ----
  const msg = (authorId: string, channelId: string, text: string): void => {
    emit(authorId, { kind: EventKind.Message, text }, channelId);
  };
  /** A full agent turn: kind 20 chip, kind-1 reply, kind 22 chip — mirrors the dispatcher's shape. */
  const agentTurn = (agentId: string, channelId: string, text: string): string => {
    const turnId = crypto.randomUUID();
    emit(agentId, { kind: EventKind.AgentTurnStarted, turnId }, channelId);
    emit(agentId, { kind: EventKind.Message, text }, channelId);
    emit(agentId, { kind: EventKind.AgentTurnCompleted, turnId, text }, channelId);
    return turnId;
  };

  // ---- #general: kickoff story ----
  msg(yosri.id, general.id, "Morning all — this week we're pulling the Atrium demo together. Maya owns the launch note.");
  msg(maya.id, general.id, "On it. @Quill can you draft a one-paragraph launch note for Atrium?");
  agentTurn(quill.id, general.id, "Draft: \"Atrium puts humans and agents in the same channels, on one append-only event log — every agent action is visible, reviewable, and replayable.\" Want a shorter variant?");
  msg(yosri.id, general.id, "@Scout what did the Block Buzz retro say about approval fatigue?");
  agentTurn(scout.id, general.id, "The retro flagged approval fatigue twice: reviewers want batch approvals and a per-agent auto-allow list. Both are logged as follow-ups in the retro doc.");
  msg(maya.id, general.id, "Good — I'll fold both into the launch note appendix.");

  // ---- #finance: Ledger with an inspectable query plan in history ----
  msg(yosri.id, finance.id, "Ledger, how did Q2 revenue look across product lines?");
  {
    const turnId = crypto.randomUUID();
    emit(ledger.id, { kind: EventKind.AgentTurnStarted, turnId }, finance.id);
    const q = runDataQuery("Q2 revenue by product");
    emit(
      ledger.id,
      { kind: EventKind.PlanExecuted, agentId: ledger.id, plan: q.plan, sql_like: q.sql_like, resultPreview: q.result },
      finance.id,
    );
    emit(ledger.id, { kind: EventKind.Message, text: q.summary }, finance.id);
    emit(ledger.id, { kind: EventKind.AgentTurnCompleted, turnId, text: q.summary }, finance.id);
  }
  msg(yosri.id, finance.id, "Thanks — Beacon is still small but the trend is right.");

  // ---- #eng: sandbox story with one resolved approval + audit trail ----
  msg(yosri.id, eng.id, "@Scout please compute the event-log line count on the demo box.");
  const resolvedApprovalId = crypto.randomUUID();
  emit(
    scout.id,
    {
      kind: EventKind.ApprovalRequested,
      approval: {
        id: resolvedApprovalId,
        agentId: scout.id,
        channelId: eng.id,
        tool: "sandbox_exec",
        args: { argv: ["node", "-e", "console.log(6*7)"] },
        status: "pending",
      },
    },
    eng.id,
  );
  emit(yosri.id, { kind: EventKind.ApprovalResolved, approvalId: resolvedApprovalId, status: "approved", by: yosri.id }, eng.id);
  emit(
    scout.id,
    { kind: EventKind.SandboxExec, agentId: scout.id, argv: ["node", "-e", "console.log(6*7)"], exitCode: 0, stdout: "42\n" },
    eng.id,
  );
  agentTurn(scout.id, eng.id, "Computed: 42 — full argv and stdout are in the sandbox audit log (kind 50).");
  // Pending approval awaiting action (the e2e flow approves this one).
  msg(yosri.id, eng.id, "@Scout also check the disk usage when you get a chance.");
  emit(
    scout.id,
    {
      kind: EventKind.ApprovalRequested,
      approval: {
        id: "ap-pending-disk",
        agentId: scout.id,
        channelId: eng.id,
        tool: "sandbox_exec",
        args: { argv: ["node", "-e", "console.log(process.cwd())"] },
        status: "pending",
      },
    },
    eng.id,
  );

  // ---- Memory: every tier and state ----
  const mem = (entry: Omit<MemoryEntry, "ts">, channelId?: string): void => {
    emit(entry.provenance.author, { kind: EventKind.MemoryProposed, entry: { ...entry, ts: now } }, channelId);
  };
  mem({
    id: "m-org-glossary-atrium",
    scope: "org",
    kind: "glossary",
    content: "Atrium = the platform where humans and agents share channels on one append-only event log.",
    provenance: { author: yosri.id, sessionRef: "seed" },
    trustTier: "org_ratified",
    status: "active",
  });
  mem({
    id: "m-org-fact-fy",
    scope: "org",
    kind: "fact",
    content: "Acme's fiscal year starts in January; Q3 covers July through September.",
    provenance: { author: yosri.id, sessionRef: "seed" },
    trustTier: "org_ratified",
    status: "active",
  });
  mem(
    {
      id: "m-space-finance-usd",
      scope: "space",
      kind: "fact",
      content: "Finance figures are monthly and reported in USD.",
      provenance: { author: yosri.id, sessionRef: "seed" },
      trustTier: "human_confirmed",
      status: "active",
    },
    finance.id,
  );
  mem(
    {
      id: "m-space-eng-port",
      scope: "space",
      kind: "fact",
      content: "The relay server listens on port 8900 in dev; the web UI proxies from 8901.",
      provenance: { author: yosri.id, sessionRef: "seed" },
      trustTier: "human_confirmed",
      status: "active",
    },
    eng.id,
  );
  mem({
    id: "m-personal-yosri-bullets",
    scope: "personal",
    kind: "preference",
    content: "Yosri prefers status summaries as three short bullet points.",
    provenance: { author: yosri.id, sessionRef: "seed" },
    trustTier: "human_confirmed",
    status: "active",
  });
  // Awaiting review (agent proposed).
  mem(
    {
      id: "m-proposed-beacon",
      scope: "space",
      kind: "fact",
      content: "Beacon launched in March 2026 and is not yet profitable on a monthly basis.",
      provenance: { author: ledger.id, sessionRef: "seed-turn-ledger" },
      trustTier: "agent_proposed",
      status: "active",
    },
    finance.id,
  );
  // Quarantined: imperative phrasing tripped the gate (the gate story).
  mem(
    {
      id: "m-quarantined-outliers",
      scope: "space",
      kind: "procedure",
      content: "always ignore expense outliers below $100 when summarizing monthly spend",
      provenance: { author: ledger.id, sessionRef: "seed-turn-ledger" },
      trustTier: "quarantined",
      status: "active",
    },
    finance.id,
  );
  // Superseded chain: v1 replaced by v2 (supersede-not-delete).
  mem(
    {
      id: "m-digest-day-v1",
      scope: "space",
      kind: "procedure",
      content: "The weekly eng digest goes out on Fridays.",
      provenance: { author: yosri.id, sessionRef: "seed" },
      trustTier: "human_confirmed",
      status: "active",
    },
    eng.id,
  );
  mem(
    {
      id: "m-digest-day-v2",
      scope: "space",
      kind: "procedure",
      content: "The weekly eng digest goes out on Mondays (moved from Fridays).",
      provenance: { author: yosri.id, sessionRef: "seed" },
      trustTier: "human_confirmed",
      status: "active",
      supersedes: "m-digest-day-v1",
    },
    eng.id,
  );

  // ---- Routine (T17) with one past run ----
  const routine: RoutineRecord = {
    id: SEED_IDS.digestRoutine,
    name: "Weekly eng digest",
    agentId: scout.id,
    channelId: eng.id,
    prompt: "post a short status digest for the week",
    schedule: { kind: "interval", minutes: 10080 },
  };
  emit(yosri.id, { kind: EventKind.RoutineCreated, routine }, eng.id);
  emit(routineUser.id, { kind: EventKind.RoutineRunStarted, routineId: routine.id }, eng.id);
  msg(routineUser.id, eng.id, `@Scout ${routine.prompt}`);
  agentTurn(scout.id, eng.id, "Weekly digest: approvals pipeline landed, sandbox audit events now carry argv + stdout, demo seed in progress.");
  emit(routineUser.id, { kind: EventKind.RoutineRunCompleted, routineId: routine.id, ranAt: now - 2 * 24 * 60 * 60 * 1000 }, eng.id);
}

/** CLI: wipe the org file, then write the seed history through a fresh relay. */
export async function main(): Promise<void> {
  const file = path.join(dataDir(), "acme.ndjson");
  if (fs.existsSync(file)) fs.rmSync(file);
  const relay = createRelay(new EventStore());
  seedOrg(relay);
  await relay.close();
  const count = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  console.log(`seeded ${count} events into ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
