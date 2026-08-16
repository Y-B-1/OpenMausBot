// Atrium server entrypoint.
import { createRelay } from "./relay.ts";

const relay = createRelay();
const port = await relay.listen();
console.log(`atrium relay listening on http://localhost:${port}`);
