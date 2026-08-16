// Wave 5 (T18): deterministic plan-then-execute mini engine over a bundled
// demo dataset. No SQL engine — a keyword parser derives a visible plan
// (filter → group → aggregate), executes it over plain arrays, and renders a
// sql_like string so the whole query is inspectable (PromptQL principle).
import type { DataRow } from "../../shared/contracts.ts";

export type DatasetRow = { month: string; product: string; revenue: number; expenses: number };

/** Bundled demo data: monthly revenue/expenses per product line (2026 H1+Q3). */
export const DATASET: DatasetRow[] = [
  { month: "2026-01", product: "Relay", revenue: 42000, expenses: 31000 },
  { month: "2026-01", product: "Atlas", revenue: 18500, expenses: 12200 },
  { month: "2026-02", product: "Relay", revenue: 44500, expenses: 30500 },
  { month: "2026-02", product: "Atlas", revenue: 19800, expenses: 12900 },
  { month: "2026-03", product: "Relay", revenue: 47200, expenses: 32100 },
  { month: "2026-03", product: "Atlas", revenue: 21400, expenses: 13400 },
  { month: "2026-03", product: "Beacon", revenue: 5200, expenses: 8900 },
  { month: "2026-04", product: "Relay", revenue: 49800, expenses: 33000 },
  { month: "2026-04", product: "Atlas", revenue: 23100, expenses: 13800 },
  { month: "2026-04", product: "Beacon", revenue: 7600, expenses: 9100 },
  { month: "2026-05", product: "Relay", revenue: 51500, expenses: 33800 },
  { month: "2026-05", product: "Atlas", revenue: 24900, expenses: 14100 },
  { month: "2026-05", product: "Beacon", revenue: 9400, expenses: 9300 },
  { month: "2026-06", product: "Relay", revenue: 53200, expenses: 34500 },
  { month: "2026-06", product: "Atlas", revenue: 26200, expenses: 14600 },
  { month: "2026-06", product: "Beacon", revenue: 11800, expenses: 9600 },
  { month: "2026-07", product: "Relay", revenue: 55600, expenses: 35200 },
  { month: "2026-07", product: "Atlas", revenue: 27800, expenses: 15000 },
  { month: "2026-07", product: "Beacon", revenue: 14100, expenses: 9800 },
  { month: "2026-08", product: "Relay", revenue: 57900, expenses: 35900 },
  { month: "2026-08", product: "Atlas", revenue: 29500, expenses: 15400 },
  { month: "2026-08", product: "Beacon", revenue: 16700, expenses: 10100 },
  { month: "2026-09", product: "Relay", revenue: 60300, expenses: 36600 },
  { month: "2026-09", product: "Atlas", revenue: 31200, expenses: 15900 },
  { month: "2026-09", product: "Beacon", revenue: 19400, expenses: 10300 },
];

export type DataQueryResult = {
  plan: string[];
  result: DataRow[];
  sql_like: string;
  summary: string;
};

const QUARTERS: Record<string, string[]> = {
  q1: ["2026-01", "2026-02", "2026-03"],
  q2: ["2026-04", "2026-05", "2026-06"],
  q3: ["2026-07", "2026-08", "2026-09"],
};

/** Deterministic keyword-parsed plan-then-execute over DATASET. */
export function runDataQuery(question: string): DataQueryResult {
  const q = question.toLowerCase();
  const plan: string[] = [];
  const where: string[] = [];
  let rows: DatasetRow[] = [...DATASET];

  // 1. filter — quarter and/or product line keywords.
  const quarter = (["q1", "q2", "q3"] as const).find((k) => q.includes(k));
  if (quarter) {
    const months = QUARTERS[quarter]!;
    rows = rows.filter((r) => months.includes(r.month));
    plan.push(`1. filter: month in ${quarter.toUpperCase()} (${months.join(", ")})`);
    where.push(`month IN (${months.map((m) => `'${m}'`).join(", ")})`);
  }
  const products = [...new Set(DATASET.map((r) => r.product))];
  const product = products.find((p) => q.includes(p.toLowerCase()));
  if (product) {
    rows = rows.filter((r) => r.product === product);
    plan.push(`${plan.length + 1}. filter: product = ${product}`);
    where.push(`product = '${product}'`);
  }
  if (plan.length === 0) plan.push("1. filter: none (full dataset)");

  // 2. measure — revenue unless expenses is asked for explicitly.
  const measure: "revenue" | "expenses" = /expens|cost|spend/.test(q) ? "expenses" : "revenue";

  // 3. group — by month when asked, else by product line.
  const groupBy: "month" | "product" = /\b(month|monthly|trend|over time)\b/.test(q) ? "month" : "product";
  plan.push(`${plan.length + 1}. group by: ${groupBy}`);
  plan.push(`${plan.length + 1}. aggregate: SUM(${measure})`);

  const groups = new Map<string, number>();
  for (const r of rows) {
    const key = r[groupBy];
    groups.set(key, (groups.get(key) ?? 0) + r[measure]);
  }
  const result: DataRow[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, total]) => ({ [groupBy]: key, [`total_${measure}`]: total }));

  const sql_like =
    `SELECT ${groupBy}, SUM(${measure}) AS total_${measure} FROM finance` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` GROUP BY ${groupBy} ORDER BY ${groupBy}`;

  const grand = [...groups.values()].reduce((a, b) => a + b, 0);
  const scope = [quarter?.toUpperCase(), product].filter(Boolean).join(" ");
  const summary =
    `Total ${scope ? scope + " " : ""}${measure}: $${grand.toLocaleString("en-US")} across ` +
    `${groups.size} ${groupBy === "product" ? "product line" : "month"}${groups.size === 1 ? "" : "s"}. Query plan attached.`;

  return { plan, result, sql_like, summary };
}
