/**
 * K14：压缩切点、尾部保真、from 边界、fake summarizer。
 *
 * 对照 neo-cli a7b237e 的 agent-policy / compact-ctx（不含 rewind F4、不含斜杠命令解析）。
 * 不得为了造红拆掉已有 compactNow / trimOldToolOutputs 路径。
 * 不迁 rewind；不把 PreCompact 拒绝当成 ordinary compact 失败。
 */
import { describe, expect, test } from "bun:test";

import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, type AgentIO } from "../../../src/core/agent.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";
import { contentText, type Message, type StreamResult, type ToolCall } from "../../../src/core/llm.ts";
import { applyCompaction, planCompaction } from "../../../src/core/agent/compact.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";

function silentIo(): AgentIO {
  return {
    line() {},
    blank() {},
    info() {},
    warn() {},
    error() {},
    toolHeader() {},
    toolResult() {},
    indent(body) { return body; },
    startSpinner() {},
    updateSpinner() {},
    stopSpinner() {},
    beginStream() {},
    writeStream() {},
    endStream() {},
    ensureStreamClosed() {},
    async confirm() { return false; },
    width: 80,
  };
}

function makeCfg(over: Partial<Config> = {}): Config {
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  const tiers = ["default", "deep_reasoning", "balanced", "fast"] as const satisfies readonly ModelTier[];
  const routes = {} as Config["routes"];
  for (const t of tiers) routes[t] = route;
  const cwd = join(tmpdir(), "neo-core-k14");
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m1",
    providers: [
      {
        name: "p1",
        type: "openai",
        baseUrl: "http://localhost:0",
        apiKey: "k",
        models: { default: "m1", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" },
        maxTokens: 100,
        temperature: 0,
        contextWindow: 100_000,
      },
    ],
    routes,
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0,
    contextWindow: 100_000,
    contextWindowSource: "config",
    globalDefaults: { maxTokens: 100, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 10,
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
    ...over,
  };
}

function fakeStream(replies: Array<() => Partial<StreamResult>>) {
  const inputs: Message[][] = [];
  let i = 0;
  const fn = async (_cfg: Config, messages: Message[]): Promise<StreamResult> => {
    inputs.push(messages);
    const r = replies[i];
    if (!r) throw new Error(`fake stream exhausted at round ${i + 1}`);
    i += 1;
    return {
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...r(),
    };
  };
  return { fn, inputs };
}

describe("planCompaction", () => {
  function user(text: string): Message {
    return { role: "user", content: text };
  }
  function assistant(text: string): Message {
    return { role: "assistant", content: text };
  }

  test("历史太短时拒绝压缩", () => {
    expect(() =>
      planCompaction([
        { role: "system", content: "sys" },
        user("hi"),
        assistant("ok"),
      ]),
    ).toThrow(/太短/);
  });

  test("切点落在 user 之前，不拆开相邻轮次", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
    ];
    const plan = planCompaction(messages);
    expect(plan.head.length).toBeGreaterThan(0);
    expect(plan.tail[0]?.role).toBe("user");
    expect(plan.head.length + plan.tail.length).toBe(messages.length - 1);

    const next = applyCompaction(messages, "摘要", plan);
    expect(next[0]?.role).toBe("system");
    expect(next[1]?.role).toBe("user");
    expect(String(next[1]?.content)).toContain("摘要");
    expect(next.slice(2)).toEqual(plan.tail);
  });

  test("F1 from 指定起点：head 从该下标起，之前的原文原样保留在 kept 里", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      user("u0"),
      assistant("a0"),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    const plan = planCompaction(messages, { from: 5 });
    expect(plan.kept.map((m) => m.content)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(plan.head[0]!.content).toBe("u2");
    expect(plan.head.length).toBeGreaterThan(0);
    expect(plan.prompt).not.toContain("u0");
    expect(plan.prompt).toContain("u2");
  });

  test("F2 切点不拆 assistant(tool_calls) ↔ tool 配对", () => {
    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
    };
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_1", name: "read_file", content: "R1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const plan = planCompaction(msgs, { from: 5 });
    expect(plan.head[0]!.role).toBe("assistant");
    expect(plan.head[0]!.tool_calls?.length).toBe(1);
    expect(plan.head[1]!.role).toBe("tool");
    expect(plan.head[1]!.tool_call_id).toBe("call_1");
    expect(plan.kept[plan.kept.length - 1]!.role).not.toBe("tool");
    const callIds = new Set(plan.head.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.id)));
    for (const m of plan.head.filter((x) => x.role === "tool")) {
      expect(callIds.has(m.tool_call_id!)).toBe(true);
    }
  });

  test("F3 from 越界 / 太靠后：抛错而不是产出空压缩", () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      user("u0"),
      assistant("a0"),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ];
    expect(() => planCompaction(msgs, { from: 99 })).toThrow();
    expect(() => planCompaction(msgs, { from: 8 })).toThrow();
    expect(() => planCompaction(msgs, { from: -1 })).toThrow();
  });
});

describe("compactNow / compact", () => {
  test("对话太短：compactNow 抛错，compact 返回 false", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    agent.messages.push(
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    );
    expect(agent.compactNow()).rejects.toThrow("对话太短");
    expect(await agent.compact()).toBe(false);
  });

  test("压缩成功：摘要 + 最近原文保留，事件携带前后 token", async () => {
    const events: string[] = [];
    const { fn } = fakeStream([() => ({ content: "## 摘要\n用户在做 X。" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
      onEvent: (e) => events.push(e.type),
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    const r = await agent.compactNow();
    expect(r.beforeTokens).toBeGreaterThan(0);
    expect(r.afterTokens).toBeGreaterThan(0);
    expect(agent.messages).toHaveLength(4);
    expect(agent.messages[0]!.content).toBe("sys");
    expect(agent.messages[1]!.content).toContain("<对话摘要>");
    expect(agent.messages[1]!.content).toContain("用户在做 X");
    expect(agent.messages.slice(2).map((m) => m.content)).toEqual(["m2", "a2"]);
    expect(events).toContain("compact");
  });

  test("P0-2：保留最近原文，且不拆散 assistant(tool_calls) 与 tool 结果", async () => {
    const { fn } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
    };
    const convo: Message[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_1", name: "read_file", content: "file body" },
      { role: "assistant", content: "a4" },
      { role: "user", content: "u5" },
      { role: "assistant", content: "a5" },
    ];
    agent.messages.push(...convo);
    await agent.compactNow();
    expect(agent.messages).toHaveLength(2 + 6);
    const tail = agent.messages.slice(2);
    expect(tail.map((m) => m.content)).toEqual(["u3", "", "file body", "a4", "u5", "a5"]);
    expect(tail[0]!.role).toBe("user");
    expect(tail[1]!.tool_calls?.[0]?.id).toBe("call_1");
    expect(tail[2]!.role).toBe("tool");
    expect(agent.messages[1]!.content).toContain("最近 6 条保留原文");
  });

  test("P0-2：摘要器输入不再按 160 字符截断", async () => {
    const longLine = `const cmd = "${"pnpm test --filter=very-long-package-name ".repeat(12)}";`;
    const { fn, inputs } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: longLine },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    );
    await agent.compactNow();
    const prompt = contentText(inputs[0]?.[1]?.content ?? null) ?? "";
    expect(prompt).toContain(longLine.slice(0, 300));
    expect(prompt).toContain("较早的历史");
  });

  test("P0-2：压缩调用自身的 usage 计入累计", async () => {
    const { fn } = fakeStream([
      () => ({
        content: "摘要",
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }),
    ]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    await agent.compactNow();
    expect(agent.cumulative).toEqual({ prompt: 120, completion: 30, reasoning: 0 });
  });

  test("P0-2：短历史的最后 user 提问必须保留为原文（切点回退修复）", async () => {
    const { fn } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    const toolCall: ToolCall = {
      id: "call_short",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    };
    agent.messages.push(
      { role: "user", content: "u0" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_short", name: "read_file", content: "body" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    );
    await agent.compactNow();
    const tail = agent.messages.slice(2);
    expect(tail.map((m) => m.content)).toEqual(["u1", "a1"]);
    expect(tail[0]!.role).toBe("user");
  });

  test("被压缩的带图提问在摘要器输入里留占位，不静默消失", async () => {
    const { fn, inputs } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      {
        role: "user",
        content: [
          { type: "text", text: "这个报错怎么修" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    );
    await agent.compactNow();
    const prompt = contentText(inputs[0]?.[1]?.content ?? null) ?? "";
    expect(prompt).toContain("这个报错怎么修");
    expect(prompt).toContain("[图片");
  });

  test("P0-2：10–11 条历史仍保留 ≥6 条原文", async () => {
    for (const len of [10, 11]) {
      const { fn } = fakeStream([() => ({ content: "摘要" })]);
      const agent = new Agent({
        cfg: makeCfg(),
        console: silentIo(),
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: fn,
      });
      for (let i = 0; i < len; i++) {
        agent.messages.push(
          i % 2 === 0
            ? { role: "user", content: `u${i}` }
            : { role: "assistant", content: `a${i}` },
        );
      }
      await agent.compactNow();
      expect(agent.messages.slice(2).length).toBeGreaterThanOrEqual(6);
      expect(agent.messages[2]!.role).toBe("user");
    }
  });

  test("压缩器返回空内容：compactNow 抛错，compact 返回 false", async () => {
    const { fn } = fakeStream([() => ({ content: "" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    expect(agent.compactNow()).rejects.toThrow("空摘要");
    expect(await agent.compact()).toBe(false);
  });

  test("compactNow({ from })：from 之前的原文保留，摘要只覆盖之后的 head", async () => {
    const { fn, inputs } = fakeStream([() => ({ content: "定点摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    );
    await agent.compactNow({ from: 5 });
    // system + kept(u0,a0,u1,a1) + 摘要 + tail
    expect(agent.messages[0]!.content).toBe("sys");
    expect(agent.messages.slice(1, 5).map((m) => m.content)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(String(agent.messages[5]!.content)).toContain("定点摘要");
    const prompt = contentText(inputs[0]?.[1]?.content ?? null) ?? "";
    expect(prompt).not.toContain("u0");
    expect(prompt).toContain("u2");
  });
});
