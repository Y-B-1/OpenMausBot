// W7 (E5): model-provider registry. Detects which credentials are present in
// the server environment and reports which drivers that lights up. Keys live
// in the server process env (platform/.env or shell), never in the client.
export type ProviderStatus = {
  id: "anthropic" | "foundry" | "openai_compat";
  label: string;
  /** Env vars this provider needs. */
  requires: string[];
  /** Which of the required vars are set (names only — values never leave the server). */
  present: string[];
  ready: boolean;
  /** What having this provider enables, in owner language. */
  enables: string;
};

export function providerStatuses(env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  const check = (names: string[]) => names.filter((n) => !!env[n] && env[n]!.trim() !== "");
  const defs: Array<Omit<ProviderStatus, "present" | "ready">> = [
    {
      id: "anthropic",
      label: "Anthropic (Claude API)",
      requires: ["ANTHROPIC_API_KEY"],
      enables: "Real Claude chat agents, Claude Managed Agents (rented engine room), Claude Agent SDK work agents.",
    },
    {
      id: "foundry",
      label: "Microsoft Foundry",
      requires: ["FOUNDRY_API_KEY", "FOUNDRY_RESOURCE"],
      enables: "Claude billed through Azure — enterprise billing/compliance path. No Managed Agents on this route.",
    },
    {
      id: "openai_compat",
      label: "OpenAI-compatible (Grok, DeepSeek, …)",
      requires: ["OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY"],
      enables: "Other-model chat/worker agents through one generic driver.",
    },
  ];
  return defs.map((d) => {
    const present = check(d.requires);
    return { ...d, present, ready: present.length === d.requires.length };
  });
}

/** Which provider each agent driver needs ("mock" needs none). */
export const DRIVER_PROVIDER: Record<string, ProviderStatus["id"] | null> = {
  mock: null,
  anthropic: "anthropic",
  managed: "anthropic",
  foundry: "foundry",
  openai_compat: "openai_compat",
};

export function driverReady(driver: string, statuses: ProviderStatus[] = providerStatuses()): boolean {
  const needed = DRIVER_PROVIDER[driver];
  if (needed === null || needed === undefined) return driver === "mock";
  return statuses.find((s) => s.id === needed)?.ready ?? false;
}
