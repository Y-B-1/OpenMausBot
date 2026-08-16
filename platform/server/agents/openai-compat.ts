// E5: generic OpenAI-compatible driver (Grok, DeepSeek, …) over the
// chat-completions wire format with global fetch. Key-gated; no network at
// construction time, defensive parsing, hard 10-turn tool-loop cap.
import type { AgentDriver, DriverCallbacks, DriverInput } from "./driver.ts";

const MAX_TURNS = 10;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** Returns null unless OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY are set. */
export function createOpenAICompatDriver(env: NodeJS.ProcessEnv = process.env): AgentDriver | null {
  const baseUrl = env["OPENAI_COMPAT_BASE_URL"];
  const apiKey = env["OPENAI_COMPAT_API_KEY"];
  if (!baseUrl || !apiKey) return null;
  return new OpenAICompatDriver(baseUrl.replace(/\/+$/, ""), apiKey);
}

export class OpenAICompatDriver implements AgentDriver {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async runTurn(input: DriverInput, callbacks: DriverCallbacks): Promise<{ text: string }> {
    const system = [input.agent.persona, ...input.contextBlocks]
      .filter((s) => s.trim() !== "")
      .join("\n\n");
    const transcriptText = input.transcript.map((t) => `${t.author}: ${t.text}`).join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: transcriptText || "(empty channel)" },
    ];
    const tools = input.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: input.agent.modelPolicy.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
      if (!res.ok) {
        const text = `Model provider error (${res.status}).`;
        callbacks.onDelta(text);
        return { text };
      }
      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: ChatMessage }>;
      } | null;
      const reply = data?.choices?.[0]?.message;
      if (!reply) {
        const text = "Model provider returned an unreadable reply.";
        callbacks.onDelta(text);
        return { text };
      }

      const toolCalls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      if (toolCalls.length === 0) {
        const text = typeof reply.content === "string" ? reply.content : "";
        callbacks.onDelta(text);
        return { text };
      }

      messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function?.arguments || "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch {
          // Malformed arguments degrade to an empty object; the tool reports its own error.
        }
        const result = await callbacks.onToolCall(call.function?.name ?? "", args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.ok ? result.output : `ERROR: ${result.output}`,
        });
      }
    }

    const text = "Stopped: tool-call loop exceeded the 10-turn cap.";
    callbacks.onDelta(text);
    return { text };
  }
}
