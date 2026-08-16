// Atrium server entrypoint.
import { createRelay } from "./relay.ts";
import { createDispatcher } from "./agents/dispatcher.ts";
import { createAnthropicDriver } from "./agents/anthropic.ts";
import { MockDriver } from "./agents/mock.ts";

const relay = createRelay();

// Wave 2: agent dispatcher registered via the relay onEvent hook.
const mock = new MockDriver();
const anthropic = createAnthropicDriver(); // null unless ANTHROPIC_API_KEY is set
createDispatcher(relay, {
  driverFor: (agent) => (agent.driver === "anthropic" && anthropic ? anthropic : mock),
});

const port = await relay.listen();
console.log(`atrium relay listening on http://localhost:${port}`);
