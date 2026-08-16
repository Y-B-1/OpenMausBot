// T5: deterministic mock driver — no timers, no randomness, no network.
import type { AgentDriver, DriverCallbacks, DriverInput } from "./driver.ts";

/** Derive a memory fact from a "remember ..." message. */
function factFrom(text: string): string {
  const m = /remember[:,]?\s*(.*)/i.exec(text);
  const rest = m?.[1]?.trim() ?? "";
  return rest !== "" ? rest : text.trim();
}

export class MockDriver implements AgentDriver {
  async runTurn(input: DriverInput, callbacks: DriverCallbacks): Promise<{ text: string }> {
    const last = [...input.transcript].reverse().find((t) => t.text.trim() !== "");
    const lastText = last?.text ?? "";

    // T18: finance-analyst agents (data_query allowed) answer revenue/numbers
    // questions through the plan-then-execute engine.
    if (input.agent.allowTools.includes("data_query") && /revenue|numbers/i.test(lastText)) {
      const result = await callbacks.onToolCall("data_query", { question: lastText });
      const text = result.ok ? result.output : `Data query failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    if (/compute/i.test(lastText)) {
      const result = await callbacks.onToolCall("sandbox_exec", {
        argv: ["node", "-e", "console.log(6*7)"],
      });
      const text = result.ok
        ? `Computed: ${result.output.trim()}`
        : `Tool call failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    if (/remember/i.test(lastText)) {
      const fact = factFrom(lastText);
      const result = await callbacks.onToolCall("memory_propose", {
        scope: "space",
        kind: "fact",
        content: fact,
      });
      const text = result.ok
        ? `Proposed memory: "${fact}"`
        : `Memory proposal failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    const text = `You said: "${lastText}"`;
    // Two deterministic deltas to exercise streaming fan-out.
    callbacks.onDelta("You said: ");
    callbacks.onDelta(`"${lastText}"`);
    return { text };
  }
}
