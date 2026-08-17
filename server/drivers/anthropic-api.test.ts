// Anthropic API driver contract tests — mocked fetch, no network, no keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { AnthropicApiDriver, costFor } from "./anthropic-api.ts";

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const happyStream = sse([
  { type: "message_start", message: { usage: { input_tokens: 100 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
  { type: "message_stop" },
]);

describe("AnthropicApiDriver.decodeConfig", () => {
  it("defaults to the public API with ANTHROPIC_API_KEY", () => {
    expect(AnthropicApiDriver.decodeConfig({})).toEqual({
      url: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(AnthropicApiDriver.decodeConfig(undefined).apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });
});

describe("costFor", () => {
  it("computes usage × published prices", () => {
    // opus 5: $5/M in, $25/M out
    expect(costFor("claude-opus-5", { input: 100, output: 50 })).toBeCloseTo(0.00175, 10);
    expect(costFor("claude-haiku-4-5", { input: 1_000_000, output: 0 })).toBeCloseTo(1, 10);
  });
  it("returns null for unknown models", () => {
    expect(costFor("mystery-model", { input: 10, output: 10 })).toBeNull();
  });
});

describe("AnthropicApiDriver turns (mocked fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedKey: string | undefined;

  const create = async (opts: { key?: string } = { key: "sk-ant-test" }) => {
    instance = await AnthropicApiDriver.create({
      instanceId: "anthropic-test",
      displayName: "Claude (API)",
      environment: opts.key ? { ANTHROPIC_API_KEY: opts.key } : {},
      enabled: true,
      config: AnthropicApiDriver.defaultConfig(),
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    // the driver falls back to process.env — a real key on the dev machine
    // must never leak into (or rescue) these tests
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    vi.unstubAllGlobals();
    recorder?.stop();
    await instance?.dispose();
  });

  it("is unavailable without a key and available with one", async () => {
    await create({});
    expect((await instance.snapshot()).state).toBe("unavailable");
    await instance.dispose();
    await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("refuses a turn without a key", async () => {
    await create({});
    await expect(instance.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/no Anthropic key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends system + transcript + user and streams a full turn with cost", async () => {
    await create();
    fetchMock.mockResolvedValue(new Response(happyStream, { status: 200 }));

    await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "and now?",
      system: "You are Testy.",
      transcript: [
        { role: "user", text: "earlier question" },
        { role: "assistant", text: "earlier answer" },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");

    // request shape
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-opus-5");
    expect(body.system).toBe("You are Testy.");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "and now?" },
    ]);

    // event emission
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
    const completedText = recorder.events.find((e) => e.type === "item.completed") as any;
    expect(completedText.text).toBe("Hello world");
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated") as any;
    expect(usage).toMatchObject({ input: 100, output: 50 });
    const done = recorder.events.find((e) => e.type === "turn.completed") as any;
    expect(done.ok).toBe(true);
    expect(done.stopReason).toBe("end_turn");
    // 100/1M × $5 + 50/1M × $25
    expect(done.cost).toBeCloseTo(0.00175, 10);
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("surfaces HTTP errors as runtime.error + failed turn, never a crash", async () => {
    await create();
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));

    await instance.adapter.sendTurn({ threadId: "t-err", text: "hi" });
    const done = (await recorder.until((e) => e.type === "turn.completed")) as any;

    expect(done.ok).toBe(false);
    expect(done.stopReason).toBe("error");
    expect(done.cost).toBeNull();
    const err = recorder.events.find((e) => e.type === "runtime.error") as any;
    expect(err.message).toMatch(/Anthropic HTTP 401/);
    expect(instance.adapter.hasSession("t-err")).toBe(false);
  });
});
