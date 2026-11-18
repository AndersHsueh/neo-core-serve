/**
 * K04 N：输出预算 / 错误降级（对标 neo-cli tests/max-tokens-safety.test.ts 的 B/C，
 * 以及 anthropic-provider.test.ts 里 parseMaxTokensLimit 的分类用例）。
 *
 * 先测 chat / chatStream 真实入口上的行为差：不透明 400 有界降级、
 * 可解析上限夹紧重发、limit 与 overflow / auth 分叉。假 HTTP，不连真实模型。
 * 未引入 auditMaxTokens（属配置启动告警，不在本片）或 settings.example.json 模板说明。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendMaxTokensHint,
  chat,
  chatStream,
  LLMError,
  OPAQUE_400_DOWNGRADE_FLOOR,
  parseMaxTokensLimit,
  resetLearnedMaxTokens,
  shouldDowngradeForOpaque400,
  type Message,
  type ToolSpec,
} from "../../../src/core/llm.ts";
import type { Config } from "../../../src/core/config.ts";

const servers: Array<{ stop: (f?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function sseOk(): Response {
  const body =
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

interface OpaqueGW {
  url: string;
  sent: number[];
}

/**
 * 不透明 400 假网关：`rejectAll` 时对每个请求都回无法解析上限的原文案，
 * 否则只拒 max_tokens > threshold 的请求。
 */
function opaqueGateway(threshold: number, opts: { rejectAll?: boolean; status?: number } = {}): OpaqueGW {
  const sent: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const mt = body["max_tokens"] as number;
      sent.push(mt);
      if (opts.rejectAll || mt > threshold) {
        return Response.json(
          { error: { message: "request was rejected by an internal MaaS component" } },
          { status: opts.status ?? 400 },
        );
      }
      return body["stream"]
        ? sseOk()
        : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, sent };
}

function limitGateway(limit: number): OpaqueGW {
  const sent: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const mt = body["max_tokens"] as number;
      sent.push(mt);
      if (mt > limit) {
        return Response.json(
          { error: { message: `does not support max tokens > ${limit}` } },
          { status: 400 },
        );
      }
      return body["stream"]
        ? sseOk()
        : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, sent };
}

function cfgFor(url: string, maxTokens: number): Config {
  return {
    providerName: "gw",
    providerType: "openai",
    apiKey: "K",
    baseUrl: url,
    model: "m",
    maxTokens,
    temperature: 0.5,
    providers: [],
    retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
  } as unknown as Config;
}

const U: Message[] = [{ role: "user", content: "hi" }];

beforeAll(() => resetLearnedMaxTokens());
afterAll(() => resetLearnedMaxTokens());

describe("shouldDowngradeForOpaque400（K04 N 判定）", () => {
  const opaque = (m = "request was rejected by an internal MaaS component") => new LLMError(m, 400);

  test("不透明 400 且当前值 > 8192 → 降级", () => {
    expect(shouldDowngradeForOpaque400(opaque(), 512000)).toBe(true);
  });

  test("只降不升：当前值 ≤ 8192 → 不降级", () => {
    expect(shouldDowngradeForOpaque400(opaque(), 8192)).toBe(false);
    expect(shouldDowngradeForOpaque400(opaque(), 4096)).toBe(false);
  });

  test("非 400 不降级：401/403/404/422/500", () => {
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 401), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 403), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 404), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 422), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 500), 512000)).toBe(false);
  });

  test("上下文超长文案不降级（overflow 恢复的领地）", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("prompt is too long: 250000 tokens > 200000 maximum", 400), 512000),
    ).toBe(false);
    expect(
      shouldDowngradeForOpaque400(new LLMError("This model's maximum context length is 128000 tokens", 400), 512000),
    ).toBe(false);
  });

  test("鉴权文案的 400 不降级", () => {
    expect(shouldDowngradeForOpaque400(new LLMError("invalid api key", 400), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("unauthorized", 400), 512000)).toBe(false);
  });

  test("能解析出上限的 400 不走降级（学习夹紧的领地）", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("does not support max tokens > 196608", 400), 512000),
    ).toBe(false);
  });

  test("parallel_tool_calls 拒绝不降级", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("unknown field: parallel_tool_calls", 400), 512000),
    ).toBe(false);
  });

  test("非 LLMError 不降级", () => {
    expect(shouldDowngradeForOpaque400(new Error("x"), 512000)).toBe(false);
  });
});

describe("parseMaxTokensLimit（K04 N 分类，与 overflow/auth 分叉）", () => {
  const e = (m: string, status = 400) => new LLMError(m, status);

  test("从常见文案解析上限", () => {
    expect(parseMaxTokensLimit(e("invalid params, model[X] does not support max tokens > 196608 (2013)"), 512000)).toBe(196608);
    expect(parseMaxTokensLimit(e("max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens"), 100000)).toBe(64000);
    expect(parseMaxTokensLimit(e("max_tokens is too large: 100000. This model supports at most 4096 completion tokens"), 100000)).toBe(4096);
  });

  test("上下文超长 / 鉴权 / 非 400 / 上限不小于 sent / 非 LLMError → null", () => {
    expect(parseMaxTokensLimit(e("This model's maximum context length is 128000 tokens"), 512000)).toBeNull();
    expect(parseMaxTokensLimit(e("prompt is too long: 250000 tokens > 200000 maximum"), 512000)).toBeNull();
    expect(parseMaxTokensLimit(e("bad api key", 401), 512000)).toBeNull();
    expect(parseMaxTokensLimit(e("does not support max tokens > 196608", 500), 512000)).toBeNull();
    expect(parseMaxTokensLimit(e("does not support max tokens > 196608"), 100000)).toBeNull();
    expect(parseMaxTokensLimit(new Error("x"), 1)).toBeNull();
  });
});

describe("appendMaxTokensHint（K04 N）", () => {
  test("400 且文案不含 max_tokens → 追加提示行，原始文案保留在第一行", () => {
    const err = new LLMError("request was rejected by an internal MaaS component", 400);
    appendMaxTokensHint(err);
    expect(err.message.split("\n")[0]).toBe("request was rejected by an internal MaaS component");
    expect(err.message).toContain("max_tokens");
  });

  test("文案已含 max_tokens 语义 → 不追加", () => {
    const err = new LLMError("does not support max tokens > 196608", 400);
    appendMaxTokensHint(err);
    expect(err.message).not.toContain("提示：");
  });

  test("401/403/404/500 不追加", () => {
    for (const st of [401, 403, 404, 500]) {
      const err = new LLMError("boom", st);
      appendMaxTokensHint(err);
      expect(err.message).not.toContain("提示：");
    }
  });

  test("鉴权文案的 400 不追加", () => {
    const err = new LLMError("invalid api key", 400);
    appendMaxTokensHint(err);
    expect(err.message).not.toContain("提示：");
  });

  test("parallel_tool_calls 拒绝不追加", () => {
    const err = new LLMError("unknown field: parallel_tool_calls", 400);
    appendMaxTokensHint(err);
    expect(err.message).not.toContain("提示：");
  });
});


describe("不透明 400 安全降级（K04 N 端到端 / chatStream）", () => {
  test("降级一次成功：512000 被拒 → 8192 重发成功", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const notices: string[] = [];
    const cfg = cfgFor(g.url, 512000);
    const r = await chatStream(cfg, U, [], { onNotice: (m) => notices.push(m) });
    expect(r.content).toBe("ok");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
    expect(notices.some((n) => n.includes("512,000") && n.includes("8,192"))).toBe(true);
    // 不改写用户配置
    expect(cfg.maxTokens).toBe(512000);
  });

  test("降级后仍失败：透传原始文案，只发两次不循环", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    const cfg = cfgFor(g.url, 512000);
    const err = await chatStream(cfg, U, []).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("request was rejected by an internal MaaS component");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });

  test("不许循环：恒 400 时 sent 恰好 2 次", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    await chatStream(cfgFor(g.url, 512000), U, []).catch(() => {});
    expect(g.sent.length).toBe(2);
  });

  test("401 不降级：只发一次", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        return Response.json({ error: { message: "bad api key" } }, { status: 401 });
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    await expect(chatStream(cfgFor(url, 512000), U, [])).rejects.toMatchObject({ status: 401 });
    expect(sent).toEqual([512000]);
  });

  test("上下文超长 400 不降级：只发一次，交给 overflow 恢复", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        return Response.json(
          { error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } },
          { status: 400 },
        );
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    await expect(chatStream(cfgFor(url, 512000), U, [])).rejects.toMatchObject({ status: 400 });
    expect(sent).toEqual([512000]);
  });

  test("鉴权文案的 400 不降级：只发一次", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        return Response.json({ error: { message: "invalid api key" } }, { status: 400 });
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    await expect(chatStream(cfgFor(url, 512000), U, [])).rejects.toMatchObject({ status: 400 });
    expect(sent).toEqual([512000]);
  });

  test("只降不升：当前值 ≤8192 时不降级原样透传", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    await expect(chatStream(cfgFor(g.url, 4096), U, [])).rejects.toMatchObject({ status: 400 });
    expect(g.sent).toEqual([4096]);
  });

  test("降级不记忆：第二次请求仍按配置原值发（单次观察不固化）", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const cfg = cfgFor(g.url, 512000);
    await chatStream(cfg, U, []);
    await chatStream(cfg, U, []);
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR, 512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });

  test("非流式 chat 同样降级", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const r = await chat(cfgFor(g.url, 512000), U);
    expect(r.content).toBe("ok");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });
});

describe("可解析输出上限夹紧（K04 N：与 overflow/auth 分叉，不走 8192 地板）", () => {
  test("文案给出上限时夹到该上限重发，而不是降到 8192", async () => {
    const g = limitGateway(196608);
    const notices: string[] = [];
    const cfg = cfgFor(g.url, 512000);
    const r = await chatStream(cfg, U, [], { onNotice: (m) => notices.push(m) });
    expect(r.content).toBe("ok");
    expect(g.sent).toEqual([512000, 196608]);
    expect(notices.some((n) => n.includes("196,608"))).toBe(true);
    expect(cfg.maxTokens).toBe(512000);
  });

  test("学到的上限对后续请求生效；不把 overflow 文案当成输出上限", async () => {
    const g = limitGateway(196608);
    const cfg = cfgFor(g.url, 512000);
    await chatStream(cfg, U, []);
    await chatStream(cfg, U, []);
    // 第一次 512000→196608，第二次直接按已学上限发 196608
    expect(g.sent).toEqual([512000, 196608, 196608]);
  });

  test("上下文超长文案即使含数字也不夹紧 max_tokens", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        return Response.json(
          { error: { message: "This model's maximum context length is 128000 tokens" } },
          { status: 400 },
        );
      },
    });
    servers.push(server);
    await expect(chatStream(cfgFor(`http://127.0.0.1:${server.port}`, 512000), U, [])).rejects.toMatchObject({
      status: 400,
    });
    expect(sent).toEqual([512000]);
  });
});

describe("opaque 降级不抢更具体的信号", () => {
  test("parallel_tool_calls 拒绝时不改 max_tokens（C 默认下发 false，字段拒绝不得触发 8192 降级）", async () => {
    const sent: Array<{ mt: number; parallel: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push({ mt: body["max_tokens"] as number, parallel: body["parallel_tool_calls"] });
        if (body["tools"] && "parallel_tool_calls" in body) {
          return Response.json({ error: { message: "unknown field: parallel_tool_calls" } }, { status: 400 });
        }
        return sseOk();
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    const tools: ToolSpec[] = [
      { type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } },
    ];
    const err = await chatStream(cfgFor(url, 512000), U, tools, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("parallel_tool_calls");
    // 不得因 opaque 路径把 max_tokens 降到 8192
    expect(sent.every((s) => s.mt === 512000)).toBe(true);
    expect(sent.length).toBe(1);
  });
});
