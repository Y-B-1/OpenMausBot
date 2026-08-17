// OpenAI-compatible driver — any chat-completions endpoint (DeepSeek, Grok
// API, local llama.cpp/ollama/vLLM, …) over the standard wire format with
// SSE streaming. Transcript-replay like grok.ts. Key-gated via
// OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY (+ optional
// OPENAI_COMPAT_MODEL). Pricing varies per endpoint, so cost is reported
// null — same as the grok driver.
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

const DRIVER_KIND = "openaiCompat";

// The real catalog is per-instance (whatever model the endpoint serves,
// named via OPENAI_COMPAT_MODEL); this static one is the driver-level
// placeholder the registry falls back to for shadows.
const MODELS = { default: "", options: [] as Array<{ id: string; label: string }> };

export interface OpenAICompatConfig {
  /** literal base URL; falls back to the env var below */
  url?: string;
  /** literal model id; falls back to the env var below */
  model?: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  modelEnv: string;
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : undefined,
    model: typeof o.model === "string" ? o.model : undefined,
    baseUrlEnv: typeof o.baseUrlEnv === "string" ? o.baseUrlEnv : "OPENAI_COMPAT_BASE_URL",
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    modelEnv: typeof o.modelEnv === "string" ? o.modelEnv : "OPENAI_COMPAT_MODEL",
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenAI-compatible (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const env = (name: string) => input.environment[name] ?? process.env[name] ?? "";
    const baseUrl = (config.url ?? env(config.baseUrlEnv)).replace(/\/+$/, "");
    const apiKey = env(config.apiKeyEnv);
    const model = config.model ?? env(config.modelEnv);
    const models = model
      ? { default: model, options: [{ id: model, label: model }] }
      : MODELS;

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
      messages: Array<{ role: string; content: string }>,
      turnModel: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: turnModel,
          messages,
          stream: opts.stream,
          ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: opts.signal ?? AbortSignal.timeout(600_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenAI-compat HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      }
      let text = "";
      let usage: { input: number; output: number } | null = null;
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
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          }
        }
      }
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!baseUrl || !apiKey) {
        throw new Error(`endpoint not configured — set ${config.baseUrlEnv} and ${config.apiKeyEnv}`);
      }
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const turnModel = turn.model || models.default;
      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, { dir: "out", source: "openai.chat.completions", msg: { model: turnModel, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turnModel });

      void (async () => {
        try {
          const { text, usage } = await complete(messages, turnModel, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: "openai.chat.completions", msg: { text, usage } });
          if (text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          }
          if (usage) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          active.delete(threadId);
          // pricing varies per endpoint — no published price table to apply
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
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
      if (!baseUrl || !apiKey) {
        return {
          state: "unavailable",
          reason: `no endpoint configured — set ${config.baseUrlEnv} + ${config.apiKeyEnv} (optional ${config.modelEnv})`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => {
          throw new Error("openai-compat driver has no pending asks");
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
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], models.default, { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
