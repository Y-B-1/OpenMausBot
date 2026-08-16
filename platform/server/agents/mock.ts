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

    // W6-A: inbox + blocking questions.
    if (/notify me|send.*inbox/i.test(lastText)) {
      const result = await callbacks.onToolCall("inbox_send", { text: `Status: working on "${lastText}"` });
      const text = result.ok ? "Posted a status update to your inbox." : `Inbox send failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }
    if (/ask me|which option/i.test(lastText)) {
      const result = await callbacks.onToolCall("ask_user", {
        prompt: "Which option should I take?",
        options: ["Option A", "Option B"],
      });
      const text = result.ok ? `You chose: ${result.output}. Proceeding.` : `Question failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    // W6-D: egress + files.
    const fetchMatch = /fetch (https?:\/\/\S+)/i.exec(lastText);
    if (fetchMatch) {
      const result = await callbacks.onToolCall("http_fetch", { url: fetchMatch[1] });
      const text = result.ok ? result.output : `Fetch blocked: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }
    const saveMatch = /save file ([^\s:]+):?\s*(.*)/i.exec(lastText);
    if (saveMatch) {
      const result = await callbacks.onToolCall("files_write", { name: saveMatch[1], content: saveMatch[2] || "empty" });
      const text = result.ok ? `Saved ${saveMatch[1]}.` : `File write failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    // W7 (E4): recall from org memory.
    const recallMatch = /recall (.+)/i.exec(lastText);
    if (recallMatch) {
      const result = await callbacks.onToolCall("memory_search", { query: recallMatch[1] });
      const text = result.ok ? `From memory:\n${result.output}` : `Memory search failed: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    // E6 self-review: after GoalCompleted the orchestrator asks for a lesson.
    const reviewMatch = /review the finished goal '([^']+)'/i.exec(lastText);
    if (reviewMatch) {
      const goalName = reviewMatch[1]!;
      const lesson = `Lesson from goal "${goalName}": define tighter success criteria up front.`;
      const result = await callbacks.onToolCall("memory_propose", {
        scope: "space",
        kind: "lesson",
        content: lesson,
      });
      const text = result.ok
        ? `Reviewed goal "${goalName}" — proposed a lesson to memory.`
        : `Review failed to propose memory: ${result.output}`;
      callbacks.onDelta(text);
      return { text };
    }

    // W6-B: goal sessions — the orchestrator asks the agent to work one criterion.
    if (/work on criterion/i.test(lastText)) {
      const text = /impossible/i.test(lastText) ? "BLOCKED: cannot satisfy this criterion." : "DONE: criterion satisfied.";
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
