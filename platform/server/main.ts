// Atrium server entrypoint.
import { createRelay } from "./relay.ts";
import { createDispatcher } from "./agents/dispatcher.ts";
import { createEngines } from "./agents/engines.ts";
import { createAnthropicDriver } from "./agents/anthropic.ts";
import { MockDriver } from "./agents/mock.ts";

const relay = createRelay();

// Wave 2: agent dispatcher registered via the relay onEvent hook.
const mock = new MockDriver();
const anthropic = createAnthropicDriver(); // null unless ANTHROPIC_API_KEY is set
const dispatcher = createDispatcher(relay, {
  driverFor: (agent) => (agent.driver === "anthropic" && anthropic ? anthropic : mock),
});

// Wave 6: goal + pipeline engines react to GoalCreated / PipelineStarted events.
createEngines(relay, dispatcher);

const port = await relay.listen();
console.log(`atrium relay listening on http://localhost:${port}`);
