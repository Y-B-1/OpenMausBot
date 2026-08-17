// Client mirror of the server's cost ledger records (server/costs.ts).

export type CostSource = "chat" | "goal" | "pipeline" | "routine";

export interface CostEntry {
  id: string;
  ts: number;
  botId: string | null;
  threadId: string;
  costUsd: number;
  model?: string;
  source: CostSource;
}

export interface CostSummary {
  totals: { todayUsd: number; last7DaysUsd: number; allTimeUsd: number; turns: number };
  byBot: Array<{ botId: string; costUsd: number; turns: number }>;
  bySource: Record<CostSource, number>;
  byDay: Array<{ day: string; costUsd: number; turns: number }>;
  recent: CostEntry[];
}
