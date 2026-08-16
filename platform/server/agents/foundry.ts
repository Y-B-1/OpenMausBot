// E5: Microsoft Foundry driver — Claude billed through Azure. Foundry exposes
// the same Messages surface as the Claude API, so this is the AnthropicDriver
// pointed at the Foundry resource endpoint. Key-gated; no network in tests.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicDriver } from "./anthropic.ts";
import type { AgentDriver } from "./driver.ts";

/** Returns null unless FOUNDRY_API_KEY and FOUNDRY_RESOURCE are both set. */
export function createFoundryDriver(env: NodeJS.ProcessEnv = process.env): AgentDriver | null {
  const apiKey = env["FOUNDRY_API_KEY"];
  const resource = env["FOUNDRY_RESOURCE"];
  if (!apiKey || !resource) return null;
  const client = new Anthropic({
    apiKey,
    baseURL: `https://${resource}.services.ai.azure.com/anthropic/v1`,
  });
  return new AnthropicDriver(client);
}
