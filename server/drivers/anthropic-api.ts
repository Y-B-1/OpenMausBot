// Anthropic API driver — Claude over the Messages API with SSE streaming,
// no Claude Code CLI required. Like grok.ts this is transcript-replay: the
// server hands it the folded thread history each turn and it emits
// token-level content.delta events. Cost is computed from usage tokens ×
// published prices and reported on turn.completed (P8 costs / P2 spend
// guardrails consume it). Key-gated: ANTHROPIC_API_KEY.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "anthropicApi";
const DEFAULT_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 32_000;

const MODELS = {
  default: "claude-opus-5",
  options: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

// Published USD per million tokens [input, output] — cost math for the
// spend ledger. Unknown models report cost: null rather than a guess.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export function costFor(model: string, usage: { input: number; output: number }): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (usage.input / 1_000_000) * price[0] + (usage.output / 1_000_000) * price[1];
}

export interface AnthropicApiConfig {
  url: string;
  /** resolved at create-time from instance environment / process env */
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): AnthropicApiConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "ANTHROPIC_API_KEY",
  };
}

export const AnthropicApiDriver: ProviderDriver<AnthropicApiConfig> = {
  driverKind: DRIVER_KIND,
  // "(API)" distinguishes this key-billed driver from claudeAgent, the CLI one
  metadata: { displayName: "Claude (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AnthropicApiConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      body: { model: string; system?: string; messages: Array<{ role: string; content: string }> },
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number }; stopReason: string | null }> => {
      const res = await fetch(`${config.url}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ max_tokens: MAX_TOKENS, stream: opts.stream, ...body }),
        signal: opts.signal ?? AbortSignal.timeout(600_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Anthropic HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: (json.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join(""),
          usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
          stopReason: json.stop_reason ?? null,
        };
      }
      let text = "";
      let stopReason: string | null = null;
      const usage = { input: 0, output: 0 };
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          let event: any;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (event.type === "message_start") {
            usage.input = event.message?.usage?.input_tokens ?? 0;
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            text += event.delta.text;
            opts.onDelta?.(event.delta.text);
          } else if (event.type === "message_delta") {
            if (typeof event.usage?.output_tokens === "number") usage.output = event.usage.output_tokens;
            if (typeof event.usage?.input_tokens === "number") usage.input = event.usage.input_tokens;
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          }
        }
      }
      return { text, usage, stopReason };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no Anthropic key — set ${config.apiKeyEnv}`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const model = turn.model || MODELS.default;
      const body = {
        model,
        ...(turn.system ? { system: turn.system } : {}),
        messages: [
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: turn.text },
        ],
      };
      appendNative(threadId, { dir: "out", source: "anthropic.messages", msg: body });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      void (async () => {
        try {
          const { text, usage, stopReason } = await complete(body, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: "anthropic.messages", msg: { text, usage, stopReason } });
          if (text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          }
          emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          active.delete(threadId);
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason,
            cost: costFor(model, usage),
          });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no Anthropic API key — set ${config.apiKeyEnv} in the environment`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => {
          throw new Error("anthropic API driver has no pending asks");
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      // cheap one-shot slot (titles, thread names) rides the small model
      generateText: async (prompt: string) => {
        const { text } = await complete(
          { model: "claude-haiku-4-5", messages: [{ role: "user", content: prompt }] },
          { stream: false },
        );
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
