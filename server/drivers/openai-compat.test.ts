// OpenAI-compat driver contract tests — mocked fetch, no network, no keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

const happyStream = sse([
  { choices: [{ delta: { content: "Deep " } }] },
  { choices: [{ delta: { content: "thought" } }] },
  { choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7 } },
]);

const ENV_VARS = ["OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_MODEL"] as const;

describe("OpenAICompatDriver.decodeConfig", () => {
  it("defaults to the OPENAI_COMPAT_* env triplet", () => {
    expect(OpenAICompatDriver.decodeConfig({})).toEqual({
      url: undefined,
      model: undefined,
      baseUrlEnv: "OPENAI_COMPAT_BASE_URL",
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
      modelEnv: "OPENAI_COMPAT_MODEL",
    });
  });
});

describe("OpenAICompatDriver turns (mocked fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let fetchMock: ReturnType<typeof vi.fn>;
  const saved: Record<string, string | undefined> = {};

  const create = async (
    environment: Record<string, string> = {
      OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_COMPAT_API_KEY: "sk-compat-test",
      OPENAI_COMPAT_MODEL: "deepseek-chat",
    },
  ) => {
    instance = await OpenAICompatDriver.create({
      instanceId: "compat-test",
      displayName: "OpenAI-compatible (API)",
      environment,
      enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    for (const v of ENV_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    for (const v of ENV_VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
    }
    vi.unstubAllGlobals();
    recorder?.stop();
    await instance?.dispose();
  });

  it("is unavailable until BOTH base URL and key exist", async () => {
    await create({});
    expect((await instance.snapshot()).state).toBe("unavailable");
    await instance.dispose();
    await create({ OPENAI_COMPAT_BASE_URL: "https://x.example/v1" });
    expect((await instance.snapshot()).state).toBe("unavailable");
    await instance.dispose();
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("exposes the configured model as the instance catalog", async () => {
    await create();
    expect(instance.models).toEqual({
      default: "deepseek-chat",
      options: [{ id: "deepseek-chat", label: "deepseek-chat" }],
    });
  });

  it("refuses a turn when unconfigured", async () => {
    await create({});
    await expect(instance.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(
      /endpoint not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends system + transcript + user and streams a full turn (cost null)", async () => {
    await create();
    fetchMock.mockResolvedValue(new Response(happyStream, { status: 200 }));

    await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "and now?",
      system: "You are Testy.",
      transcript: [{ role: "assistant", text: "earlier answer" }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-compat-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "You are Testy." },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "and now?" },
    ]);

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect((recorder.events.find((e) => e.type === "item.completed") as any).text).toBe("Deep thought");
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 42,
      output: 7,
    });
    const done = recorder.events.find((e) => e.type === "turn.completed") as any;
    expect(done.ok).toBe(true);
    expect(done.cost).toBeNull();
  });

  it("surfaces HTTP errors as runtime.error + failed turn", async () => {
    await create();
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    await instance.adapter.sendTurn({ threadId: "t-err", text: "hi" });
    const done = (await recorder.until((e) => e.type === "turn.completed")) as any;

    expect(done.ok).toBe(false);
    expect(done.stopReason).toBe("error");
    const err = recorder.events.find((e) => e.type === "runtime.error") as any;
    expect(err.message).toMatch(/OpenAI-compat HTTP 500/);
    expect(instance.adapter.hasSession("t-err")).toBe(false);
  });
});
