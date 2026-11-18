/**
 * K06a：选中 anthropic 必须在 chat/chatStream 入口明确拒绝，不得静默按 OpenAI 协议发。
 * 纯 wire 转换（body / tool id / 流解析）另组断言。不把 wire 绿说成生产 Anthropic 已发布。
 * 不改 protocol.lock，不把 IMPLEMENTED_PROVIDER_TYPES 扩成 anthropic。
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  buildAnthropicBody,
  isRetryableAnthropicError,
  mapStopReason,
  mapUsage,
  parseAnthropicMessage,
  sanitizeToolId,
  toAnthropicMessages,
  AnthropicStreamAccumulator,
} from "../../../src/core/anthropicWire.ts";
import { chat, chatStream, LLMError, type Message, type ToolSpec } from "../../../src/core/llm.ts";
import type { Config } from "../../../src/core/config.ts";
import { IMPLEMENTED_PROVIDER_TYPES } from "../../../src/core/config.ts";

const servers: Array<{ stop: (f?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function cfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "p1",
    providerType: "anthropic",
    apiKey: "K",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "claude",
    maxTokens: 128,
    temperature: 0.5,
    retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 2000, streamIdleTimeoutMs: 2000 },
    ...over,
  } as unknown as Config;
}

const tools: ToolSpec[] = [
  { type: "function", function: { name: "calc", description: "d", parameters: { type: "object", properties: { e: { type: "string" } } } } },
];

const U: Message[] = [{ role: "user", content: "hi" }];

describe("K06a：chat/chatStream 选中 anthropic 必须明确拒绝", () => {
  test("IMPLEMENTED_PROVIDER_TYPES 仍只有 openai（本片不宣称生产已发布）", () => {
    expect(IMPLEMENTED_PROVIDER_TYPES).toEqual(["openai"]);
  });

  test("chatStream 选中 anthropic 抛出明确拒绝，且不向端点发任何请求", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response("should-not-be-called", { status: 200 });
      },
    });
    servers.push(server);
    const err = await chatStream(cfg({ baseUrl: `http://127.0.0.1:${server.port}/v1` }), U, []).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(String(err.message)).toMatch(/anthropic/i);
    expect(String(err.message)).toMatch(/未接入|未实现|不支持/);
    expect(hits).toBe(0);
  });

  test("非流式 chat 同样明确拒绝，不按 OpenAI /chat/completions 发送", async () => {
    let paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(new URL(req.url).pathname);
        return Response.json({ choices: [{ message: { content: "leaked" }, finish_reason: "stop" }] });
      },
    });
    servers.push(server);
    const err = await chat(cfg({ baseUrl: `http://127.0.0.1:${server.port}/v1` }), U).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(String(err.message)).toMatch(/anthropic/i);
    expect(paths).toEqual([]);
  });
});


/* ------------------------------------------------------------------ */
/* 纯 wire 转换（不把这些绿说成生产 Anthropic 已发布）                 */
/* ------------------------------------------------------------------ */

describe("toAnthropicMessages", () => {
  test("开头 system 合并成顶层字段；中途 system 降级为 user 文本且不丢", () => {
    const msgs: Message[] = [
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "system", content: "中途提示" },
      { role: "user", content: "再来" },
    ];
    const r = toAnthropicMessages(msgs);
    expect(r.system).toBe("S1\n\nS2");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = r.messages[2]!.content.map((b) => b["text"]).join("|");
    expect(last).toContain("中途提示");
    expect(last).toContain("再来");
  });

  test("tool_calls → tool_use；连续 tool 结果合并进同一条 user，且 tool_result 排在最前", () => {
    const msgs: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "好",
        tool_calls: [
          { id: "a", type: "function", function: { name: "calc", arguments: '{"e":"1"}' } },
          { id: "b", type: "function", function: { name: "calc", arguments: "{坏json" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "" },
      { role: "user", content: "继续" },
    ];
    const r = toAnthropicMessages(msgs).messages;
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const asst = r[1]!.content;
    expect(asst[0]).toEqual({ type: "text", text: "好" });
    expect(asst[1]).toMatchObject({ type: "tool_use", id: "a", input: { e: "1" } });
    expect(asst[2]).toMatchObject({ type: "tool_use", id: "b", input: {} });
    const u = r[2]!.content;
    expect(u.map((b) => b["type"])).toEqual(["tool_result", "tool_result", "text"]);
    expect(u[1]).toMatchObject({ tool_use_id: "b", content: "(无输出)" });
  });

  test("空助手消息给占位，保证交替且不被服务端拒收", () => {
    const r = toAnthropicMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "" },
      { role: "user", content: "b" },
    ]).messages;
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r[1]!.content.length).toBe(1);
  });

  test("图片 data URL → base64 source；http URL → url source", () => {
    const r = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]).messages[0]!.content;
    expect(r[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(r[2]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
  });

  test("其他协议生成的 tool id 含非法字符时被清洗，且 use/result 两侧一致", () => {
    expect(sanitizeToolId("call:1/x")).toBe("call_1_x");
    const r = toAnthropicMessages([
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "c:1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c:1", content: "ok" },
    ]).messages;
    expect(r[1]!.content[0]!["id"]).toBe("c_1");
    expect(r[2]!.content[0]!["tool_use_id"]).toBe("c_1");
  });
});

describe("buildAnthropicBody", () => {
  const base = { model: "m", maxTokens: 4096, temperature: 0.6, parallel: true };
  test("tools / tool_choice / system / parallel", () => {
    const b = buildAnthropicBody(base, [{ role: "system", content: "S" }, { role: "user", content: "u" }], tools, true);
    expect(b["system"]).toBe("S");
    expect(b["stream"]).toBe(true);
    expect((b["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "calc", input_schema: tools[0]!.function.parameters });
    expect(b["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: false });
    const off = buildAnthropicBody({ ...base, parallel: false }, [{ role: "user", content: "u" }], tools, false);
    expect(off["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect("parallel_tool_calls" in off).toBe(false);
  });
  test("无工具不下发 tool_choice；thinking 开关与预算", () => {
    const b = buildAnthropicBody({ ...base, thinking: { type: "enabled" } }, [{ role: "user", content: "u" }], [], false);
    expect("tool_choice" in b).toBe(false);
    expect(b["thinking"]).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(buildAnthropicBody({ ...base, thinking: { type: "disabled" } }, [], [], false)["thinking"]).toEqual({ type: "disabled" });
    // max_tokens 太小放不下最小预算：不下发（宁可不思考也不发必被拒的请求）
    expect("thinking" in buildAnthropicBody({ ...base, maxTokens: 1000, thinking: { type: "enabled" } }, [], [], false)).toBe(false);
  });
});

describe("映射", () => {
  test("stop_reason → finish_reason", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason(null)).toBeNull();
  });
  test("usage：输入含缓存读写；thinking 计入 reasoning", () => {
    const u = mapUsage({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } });
    expect(u).toMatchObject({ prompt_tokens: 115, completion_tokens: 7, total_tokens: 122, completion_tokens_details: { reasoning_tokens: 3 } });
  });
  test("非流式响应解析", () => {
    const r = parseAnthropicMessage({
      content: [
        { type: "thinking", thinking: "想" },
        { type: "text", text: "答" },
        { type: "tool_use", id: "t1", name: "calc", input: { e: "1" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(r).toMatchObject({ content: "答", reasoning: "想", finishReason: "tool_calls" });
    expect(r.toolCalls[0]).toMatchObject({ id: "t1", function: { name: "calc", arguments: '{"e":"1"}' } });
  });
});

describe("AnthropicStreamAccumulator", () => {
  test("文本 + 工具参数分片 + 用量累计（message_start 的 0 占位不覆盖 delta）", () => {
    const got = { c: "", r: "", t: [] as string[] };
    const a = new AnthropicStreamAccumulator({
      onContent: (d) => (got.c += d),
      onReasoning: (d) => (got.r += d),
      onToolCallDelta: (i, n, d) => got.t.push(`${i}:${n}:${d}`),
    });
    const ev = (o: unknown) => a.feed(o as Record<string, unknown>);
    ev({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } });
    ev({ type: "ping" });
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } });
    ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "calc", input: {} } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"e":' } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"1"}' } });
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 50, output_tokens: 9 } });
    ev({ type: "message_stop" });
    const r = a.result();
    expect(got).toEqual({ c: "你好", r: "想", t: ["0:calc:{\"e\":", "0:calc:\"1\"}"] });
    expect(r.toolCalls[0]).toMatchObject({ id: "t1", function: { name: "calc", arguments: '{"e":"1"}' } });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 9 });
    expect(a.sawStop).toBe(true);
  });

  test("无参数工具：input 保持 {}；error 事件被记录", () => {
    const a = new AnthropicStreamAccumulator({});
    a.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: "noop", input: {} } });
    expect(a.result().toolCalls[0]!.function.arguments).toBe("{}");
    a.feed({ type: "error", error: { type: "overloaded_error", message: "忙" } });
    expect(a.error).toEqual({ type: "overloaded_error", message: "忙" });
  });
});

describe("thinking 块：保存、回带、不泄漏到 OpenAI", () => {
  test("流式：thinking + signature 分片累积成带签名的块；无签名的块不保留", () => {
    const a = new AnthropicStreamAccumulator({});
    const ev = (o: unknown) => a.feed(o as Record<string, unknown>);
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "好了" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } });
    ev({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "没签名" } });
    ev({ type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "ENC" } });
    expect(a.result().thinkingBlocks).toEqual([
      { type: "thinking", thinking: "想好了", signature: "SIG" },
      { type: "redacted_thinking", data: "ENC" },
    ]);
  });

  test("非流式响应同样保留带签名的 thinking 块", () => {
    const r = parseAnthropicMessage({
      content: [{ type: "thinking", thinking: "t", signature: "S" }, { type: "text", text: "x" }],
      stop_reason: "end_turn",
    });
    expect(r.thinkingBlocks).toEqual([{ type: "thinking", thinking: "t", signature: "S" }]);
    expect(parseAnthropicMessage({ content: [{ type: "text", text: "x" }] }).thinkingBlocks).toBeUndefined();
  });

  test("回带：thinking 块原样排在 text / tool_use 之前", () => {
    const msgs: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "好",
        thinking_blocks: [{ type: "thinking", thinking: "想", signature: "S" }],
        tool_calls: [{ id: "a", type: "function", function: { name: "calc", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "a", content: "1" },
    ];
    const asst = toAnthropicMessages(msgs).messages[1]!.content;
    expect(asst.map((b) => b["type"])).toEqual(["thinking", "text", "tool_use"]);
    expect(asst[0]).toEqual({ type: "thinking", thinking: "想", signature: "S" });
  });

  test("OpenAI 请求体里不出现 thinking_blocks", async () => {
    let body: Record<string, unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = (await req.json()) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    });
    servers.push(server);
    const msgs: Message[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", thinking_blocks: [{ type: "thinking", thinking: "t", signature: "S" }] },
      { role: "user", content: "c" },
    ];
    await chat(cfg({ providerType: "openai", baseUrl: `http://127.0.0.1:${server.port}/v1` }), msgs);
    expect(JSON.stringify(body)).not.toContain("thinking_blocks");
    expect(msgs[1]!.thinking_blocks).toBeDefined();
  });
});

