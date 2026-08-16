// T6: real driver via @anthropic-ai/sdk. Constructed only when ANTHROPIC_API_KEY
// is set; never exercised in tests (tests use the mock driver, no network).
import Anthropic from "@anthropic-ai/sdk";
import type { AgentDriver, DriverCallbacks, DriverInput } from "./driver.ts";

const FALLBACK_TEXT =
  "I can't help with that request, but I'm happy to assist with something else.";

/** Returns null when no API key is configured. */
export function createAnthropicDriver(): AgentDriver | null {
  if (!process.env["ANTHROPIC_API_KEY"]) return null;
  const client = new Anthropic();
  return new AnthropicDriver(client);
}

export class AnthropicDriver implements AgentDriver {
  private readonly client: Anthropic;

  constructor(client: Anthropic) {
    this.client = client;
  }

  async runTurn(input: DriverInput, callbacks: DriverCallbacks): Promise<{ text: string }> {
    const model = input.agent.modelPolicy.model || "claude-haiku-4-5";
    const maxTokens = input.agent.modelPolicy.maxTokens || 1024;

    const system = [input.agent.persona, ...input.contextBlocks]
      .filter((s) => s.trim() !== "")
      .join("\n\n");

    const tools: Anthropic.Tool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const transcriptText = input.transcript
      .map((t) => `${t.author}: ${t.text}`)
      .join("\n");
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: transcriptText || "(empty channel)" },
    ];

    let finalText = "";
    // Simple tool-use loop (non-streaming is acceptable for the prototype).
    for (;;) {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools,
        messages,
      });

      if (response.stop_reason === "refusal") {
        callbacks.onDelta(FALLBACK_TEXT);
        return { text: FALLBACK_TEXT };
      }

      for (const block of response.content) {
        if (block.type === "text") {
          callbacks.onDelta(block.text);
          finalText += block.text;
        }
      }

      if (response.stop_reason !== "tool_use") break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await callbacks.onToolCall(
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.output,
          is_error: !result.ok,
        });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    return { text: finalText };
  }
}
