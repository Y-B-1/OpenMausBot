// Atrium server entrypoint.
import fs from "node:fs";
import path from "node:path";
import { createRelay } from "./relay.ts";

// Minimal .env loader (platform/.env) — existing env always wins.
const envFile = path.join(import.meta.dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
import { createDispatcher } from "./agents/dispatcher.ts";
import { createEngines } from "./agents/engines.ts";
import { createManagedDriver } from "./agents/managed.ts";
import { createAnthropicDriver } from "./agents/anthropic.ts";
import { createFoundryDriver } from "./agents/foundry.ts";
import { createOpenAICompatDriver } from "./agents/openai-compat.ts";
import { MockDriver } from "./agents/mock.ts";

const relay = createRelay();

// Wave 2: agent dispatcher registered via the relay onEvent hook.
const mock = new MockDriver();
const anthropic = createAnthropicDriver(); // null unless ANTHROPIC_API_KEY is set
const managed = createManagedDriver(); // null unless ANTHROPIC_API_KEY is set
const foundry = createFoundryDriver(); // null unless FOUNDRY_API_KEY + FOUNDRY_RESOURCE
const openaiCompat = createOpenAICompatDriver(); // null unless OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY
const dispatcher = createDispatcher(relay, {
  driverFor: (agent) => {
    if (agent.driver === "anthropic" && anthropic) return anthropic;
    if (agent.driver === "managed" && managed) return managed;
    if (agent.driver === "foundry" && foundry) return foundry;
    if (agent.driver === "openai_compat" && openaiCompat) return openaiCompat;
    return mock; // missing keys degrade to mock, never crash
  },
});

// Wave 6: goal + pipeline engines react to GoalCreated / PipelineStarted events.
createEngines(relay, dispatcher);

const port = await relay.listen();
console.log(`atrium relay listening on http://localhost:${port}`);
