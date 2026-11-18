/**
 * K06b：thinking_blocks 在 Agent 历史里的闭环。
 *
 * 写入历史 → 下一轮请求带回 → 会话落盘/恢复后仍在。
 * 签名留在内部消息；不得进入公开 AgentEvent / 不得拆掉 tool 配对。
 * 假 chatStream，不依赖网络，不把本片绿说成生产 Anthropic 已发布。
 * 不新增 Matrix 事件，seq 仍走既有 H4。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent, type AgentEvent, type AgentIO } from "../../../src/core/agent.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";
import type { Message, StreamResult, ThinkingBlock, ToolCall } from "../../../src/core/llm.ts";
import { createSession, loadSession, saveSession } from "../../../src/core/session.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-thinking-agent-"));
  dirs.push(d);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeCfg(): Config {
  const cwd = sandbox();
  const models = { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  const tiers = ["default", "deep_reasoning", "balanced", "fast"] as const satisfies readonly ModelTier[];
  const routes = {} as Config["routes"];
  for (const t of tiers) routes[t] = route;
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m",
    providers: [
      {
        name: "p1",
        type: "openai",
        baseUrl: "http://localhost:0",
        apiKey: "k",
        models,
        maxTokens: 100,
        temperature: 0.3,
        contextWindow: 100_000,
      },
    ],
    routes,
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
    cwd,
    modelFallback: [],
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off",
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
  };
}

function quietIO(): AgentIO {
  const noop = (): void => {};
  return new Proxy(
    { width: 100, confirm: async () => true },
    { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : noop) },
  ) as unknown as AgentIO;
}

const T1: ThinkingBlock = { type: "thinking", thinking: "先查一下", signature: "SIG1" };
const T2: ThinkingBlock = { type: "thinking", thinking: "得出结论", signature: "SIG2" };
const CALL: ToolCall = {
  id: "call_1",
  type: "function",
  function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
};

describe("K06b thinking_blocks 在 Agent 里的闭环", () => {
  test("带工具调用的轮次与最终回答都把思考块写进 assistant 消息，下一轮请求原样带回；公开事件不含签名", async () => {
    const seen: Message[][] = [];
    const events: AgentEvent[] = [];
    let call = 0;
    const fn = (_cfg: Config, messages: Message[]): Promise<StreamResult> => {
      seen.push(messages.map((m) => ({ ...m })));
      call += 1;
      const base = {
        content: "",
        reasoning: "",
        toolCalls: [] as ToolCall[],
        finishReason: "stop" as const,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        raw: null,
      };
      return Promise.resolve(
        call === 1
          ? { ...base, toolCalls: [CALL], finishReason: "tool_calls", thinkingBlocks: [T1] }
          : { ...base, content: "完成", thinkingBlocks: [T2] },
      );
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: quietIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      nonInteractive: true,
      chatStream: fn,
      onEvent: (e) => events.push(e),
    });
    await agent.send("看看目录");

    const asst = agent.messages.filter((m) => m.role === "assistant");
    expect(asst[0]!.thinking_blocks).toEqual([T1]);
    expect(asst[0]!.tool_calls?.[0]?.id).toBe("call_1");
    expect(asst[1]!.thinking_blocks).toEqual([T2]);

    const tools = agent.messages.filter((m) => m.role === "tool");
    expect(tools[0]!.tool_call_id).toBe("call_1");

    const second = seen[1]!.find((m) => m.role === "assistant");
    expect(second?.thinking_blocks).toEqual([T1]);
    expect(second?.tool_calls?.[0]?.id).toBe("call_1");

    const dumped = JSON.stringify(events);
    expect(dumped).not.toContain("SIG1");
    expect(dumped).not.toContain("SIG2");
    expect(dumped).not.toContain("thinking_blocks");
    expect(events.some((e) => e.type === "text" || e.type === "tool_start")).toBe(true);
  });

  test("没有思考块（OpenAI 路径 / 无 thinking 的模型）：消息上不出现该字段", async () => {
    const fn = (): Promise<StreamResult> =>
      Promise.resolve({
        content: "好",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        raw: null,
      });
    const agent = new Agent({
      cfg: makeCfg(),
      console: quietIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      nonInteractive: true,
      chatStream: fn,
    });
    await agent.send("hi");
    const a = agent.messages.find((m) => m.role === "assistant")!;
    expect("thinking_blocks" in a).toBe(false);
  });

  test("会话落盘并恢复后思考块仍在（resume 后继续多轮工具对话不丢签名）", () => {
    process.env["NEO_SESSIONS_DIR"] = mkdtempSync(join(tmpdir(), "neo-sess-"));
    dirs.push(process.env["NEO_SESSIONS_DIR"]!);
    const { meta } = createSession("m", sandbox());
    const msgs: Message[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: "y", thinking_blocks: [T1], tool_calls: [CALL] },
    ];
    saveSession(msgs, meta);
    const back = loadSession(meta.id)!;
    expect(back.messages[1]!.thinking_blocks).toEqual([T1]);
    expect(back.messages[1]!.tool_calls?.[0]?.id).toBe("call_1");
    delete process.env["NEO_SESSIONS_DIR"];
  });
});
