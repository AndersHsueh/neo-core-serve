/**
 * K12：对照 neo-cli a7b237e / tests/agent-stream-events.test.ts 的事件形状。
 *
 * 内部 assistant_message 只映射已有 C 事件（`text`），不向 AgentEvent / Matrix
 * 倒入 N 的 assistant_message。seq 仍由宿主单分配，本文件不碰 session-host。
 * 工具事件在已有 tool_start / tool_end 上补 call_id、status、output；
 * not_executed 与 failure 必须区分。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentEvent, type AgentIO } from "../../../src/core/agent.ts";
import type { ToolEndEventData, ToolStartEventData } from "../../../src/core/agent/types.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";
import type { StreamResult, ToolCall } from "../../../src/core/llm.ts";
import { dispatch, registerTool } from "../../../src/core/tools/index.ts";
import type { ToolImpl } from "../../../src/core/tools/types.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-core-stream-events-"));
const previousTmpDir = process.env["NEO_TMP_DIR"];
const previousLogDir = process.env["NEO_LOG_DIR"];
const unregister: Array<() => void> = [];

beforeAll(() => {
  process.env["NEO_TMP_DIR"] = join(SANDBOX, "tmp");
  process.env["NEO_LOG_DIR"] = join(SANDBOX, "logs");
});

afterAll(() => {
  if (previousTmpDir === undefined) delete process.env["NEO_TMP_DIR"];
  else process.env["NEO_TMP_DIR"] = previousTmpDir;
  if (previousLogDir === undefined) delete process.env["NEO_LOG_DIR"];
  else process.env["NEO_LOG_DIR"] = previousLogDir;
  for (const off of unregister) off();
  rmSync(SANDBOX, { recursive: true, force: true });
});

function silentIo(): AgentIO {
  return {
    line() {},
    blank() {},
    info() {},
    warn() {},
    error() {},
    toolHeader() {},
    toolResult() {},
    indent(body) {
      return body;
    },
    startSpinner() {},
    updateSpinner() {},
    stopSpinner() {},
    beginStream() {},
    writeStream() {},
    endStream() {},
    ensureStreamClosed() {},
    async confirm() {
      return false;
    },
    width: 80,
  };
}

function makeCfg(over: Partial<Config> = {}): Config {
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
    model: "m-default",
    providers: [],
    routes,
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 256,
    temperature: 0,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 256, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.9,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
    cwd: SANDBOX,
    modelFallback: [],
    settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(SANDBOX, "mem"),
      userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
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

function result(over: Partial<StreamResult> = {}): StreamResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    raw: null,
    ...over,
  };
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function fakeTool(name: string, output: string, _readonly = true): ToolImpl {
  return {
    spec: {
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    },
    sensitive: false,
    kind: "neither",
    execute: () => output,
  };
}

function throwingTool(name: string, message: string): ToolImpl {
  return {
    spec: {
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    },
    sensitive: false,
    kind: "neither",
    execute: () => {
      throw new Error(message);
    },
  };
}

function reg(impl: ToolImpl): void {
  unregister.push(registerTool(impl));
}

function dataOf<T>(events: AgentEvent[], type: AgentEvent["type"]): T[] {
  return events.filter((e) => e.type === type).map((e) => e.data as T);
}

function indicesOf(events: AgentEvent[], type: AgentEvent["type"]): number[] {
  const out: number[] = [];
  events.forEach((e, i) => {
    if (e.type === type) out.push(i);
  });
  return out;
}

/**
 * 脚本化 chatStream：按序返回响应，并把 content 走已有 onContent → `text` 事件。
 * 这就是本片对 N `assistant_message` 的映射，不再新增事件类型。
 * 多要一轮就报错，防止静默死循环。
 */
function scriptedStream(
  rounds: StreamResult[],
): (
  cfg: Config,
  messages: unknown,
  tools: unknown,
  handlers?: { onContent?: (d: string) => void },
) => Promise<StreamResult> {
  let i = 0;
  return async (_cfg, _messages, _tools, handlers) => {
    const r = rounds[i];
    if (!r) throw new Error(`scripted stream exhausted at round ${i + 1}`);
    i += 1;
    if (r.content) handlers?.onContent?.(r.content);
    return r;
  };
}

function makeHarness(rounds: StreamResult[], cfgOver: Partial<Config> = {}) {
  const events: AgentEvent[] = [];
  const agent = new Agent({
    cfg: makeCfg(cfgOver),
    console: silentIo(),
    mode: "auto-all",
    systemPrompt: "sys",
    chatStream: scriptedStream(rounds) as Agent["injectedStreamFn"],
    onEvent: (e) => events.push(e),
  });
  return { events, agent };
}

describe("K12 Agent 内部事件载荷（映射已有 C 事件）", () => {
  test("事件类型不含 assistant_message；正文走已有 text", async () => {
    const { events, agent } = makeHarness([
      result({ content: "纯回答", finishReason: "stop", reasoning: "不得外泄", raw: { secret: "RAW_LEAK" } }),
    ]);
    await agent.send("只回答");
    expect(events.some((e) => (e.type as string) === "assistant_message")).toBe(false);
    const texts = events.filter((e) => e.type === "text").map((e) => String(e.data ?? ""));
    expect(texts.join("")).toContain("纯回答");
    expect(indicesOf(events, "tool_start")).toEqual([]);
    expect(indicesOf(events, "tool_end")).toEqual([]);
  });

  test("A call_id 按 tool_calls 原序配对；不泄露 reasoning/raw/thinking", async () => {
    reg(fakeTool("t_read_a", "a ok"));
    reg(fakeTool("t_read_b", "b ok"));
    reg(fakeTool("t_read_c", "c ok"));

    const first = result({
      content: "我来读取三个文件",
      reasoning: "内部思维链不得外泄",
      toolCalls: [
        tc("c1", "t_read_a", { path: "src/a.ts" }),
        tc("c2", "t_read_b", { path: "src/b.ts" }),
        tc("c3", "t_read_c", { path: "src/c.ts" }),
      ],
      finishReason: "tool_calls",
      raw: { secret: "RAW_LEAK" },
      thinkingBlocks: [{ type: "thinking", thinking: "THINK_LEAK", signature: "sig" }],
    });
    const final = result({ content: "最终答案：完成", finishReason: "stop" });
    const { events, agent } = makeHarness([first, final]);
    const stats = await agent.send("读三个文件");

    expect(stats.hadError).toBe(false);
    expect(stats.toolCalls).toBe(3);
    expect(events.some((e) => (e.type as string) === "assistant_message")).toBe(false);

    const starts = dataOf<ToolStartEventData>(events, "tool_start");
    const ends = dataOf<ToolEndEventData>(events, "tool_end");
    expect(starts.map((s) => s.call_id)).toEqual(["c1", "c2", "c3"]);
    expect(ends.map((e) => e.call_id)).toEqual(["c1", "c2", "c3"]);
    expect(starts.map((s) => s.name)).toEqual(["t_read_a", "t_read_b", "t_read_c"]);
    expect(starts[0]!.args).toBe(JSON.stringify({ path: "src/a.ts" }));
    expect(ends.map((e) => e.ok)).toEqual([true, true, true]);
    expect(ends.map((e) => e.status)).toEqual(["success", "success", "success"]);
    expect(ends.map((e) => e.output)).toEqual(["a ok", "b ok", "c ok"]);
    expect(ends.map((e) => e.truncated)).toEqual([false, false, false]);

    // 正文已通过已有 text 事件发出（流式或收口），且在首个 tool_start 之前出现过。
    const textBeforeTool = events
      .slice(0, indicesOf(events, "tool_start")[0]!)
      .filter((e) => e.type === "text")
      .map((e) => String(e.data ?? ""))
      .join("");
    expect(textBeforeTool).toContain("我来读取三个文件");

    const toolSerialized = JSON.stringify({ starts, ends });
    expect(toolSerialized.includes("内部思维链不得外泄")).toBe(false);
    expect(toolSerialized.includes("THINK_LEAK")).toBe(false);
    expect(toolSerialized.includes("RAW_LEAK")).toBe(false);
  });

  test("B status 映射 success/failure/not_executed；truncated 透传；未知工具不执行", async () => {
    reg(fakeTool("t_ok", "ok", false));
    reg(throwingTool("t_fail", "boom"));
    reg(fakeTool("t_long", "x".repeat(200), false));

    const first = result({
      content: "做四件事",
      toolCalls: [tc("k1", "t_ok"), tc("k2", "t_fail"), tc("k3", "t_missing"), tc("k4", "t_long")],
      finishReason: "tool_calls",
    });
    const final = result({ content: "done", finishReason: "stop" });
    const { events, agent } = makeHarness([first, final], { toolOutputLimit: 20 });
    await agent.send("go");

    const starts = dataOf<ToolStartEventData>(events, "tool_start");
    const ends = dataOf<ToolEndEventData>(events, "tool_end");
    expect(starts.map((s) => s.call_id)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(ends.map((e) => e.call_id)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(ends.map((e) => e.status)).toEqual(["success", "failure", "not_executed", "success"]);
    expect(ends.map((e) => e.ok)).toEqual([true, false, false, true]);
    expect(ends.map((e) => e.truncated)).toEqual([false, false, false, true]);
    expect(ends[0]!.output).toBe("ok");
    expect(ends[1]!.output).toContain("boom");
    expect(ends[2]!.output).toContain("未知工具");
  });

  test("C 同一 send() 内多轮工具循环：每轮完整响应都有 text，且 call_id 分轮保序", async () => {
    reg(fakeTool("t_round", "r", false));
    const rounds: StreamResult[] = [
      result({ content: "第 1 轮", toolCalls: [tc("a1", "t_round")], finishReason: "tool_calls" }),
      result({ content: "第 2 轮", toolCalls: [tc("a2", "t_round")], finishReason: "tool_calls" }),
      result({ content: "第 3 轮最终", finishReason: "stop" }),
    ];
    const { events, agent } = makeHarness(rounds);
    await agent.send("多轮");

    const texts = events.filter((e) => e.type === "text").map((e) => String(e.data ?? "")).join("\n");
    expect(texts).toContain("第 1 轮");
    expect(texts).toContain("第 2 轮");
    expect(texts).toContain("第 3 轮最终");
    expect(dataOf<ToolStartEventData>(events, "tool_start").map((s) => s.call_id)).toEqual(["a1", "a2"]);
    expect(dataOf<ToolEndEventData>(events, "tool_end").map((e) => e.call_id)).toEqual(["a1", "a2"]);

    const startIdx = indicesOf(events, "tool_start");
    expect(startIdx).toHaveLength(2);
    // 每一轮的 text 都出现在该轮 tool_start 之前。
    const beforeFirst = events.slice(0, startIdx[0]!).some((e) => e.type === "text" && String(e.data).includes("第 1 轮"));
    const mid = events.slice(startIdx[0]!, startIdx[1]!).some((e) => e.type === "text" && String(e.data).includes("第 2 轮"));
    expect(beforeFirst).toBe(true);
    expect(mid).toBe(true);
  });

  test("E finish_reason=length 的响应也发完整 text，事件自身不带 truncated 字段", async () => {
    const { events, agent } = makeHarness([result({ content: "被截断的正文", finishReason: "length" })]);
    await agent.send("长回答");
    const texts = events.filter((e) => e.type === "text").map((e) => String(e.data ?? "")).join("");
    expect(texts).toContain("被截断的正文");
    for (const e of events.filter((ev) => ev.type === "text")) {
      expect(typeof e.data).toBe("string");
      expect(e).not.toHaveProperty("truncated");
    }
  });

  test("未知工具 / 非法参数 dispatch 返回 executed:false，与抛错失败区分", async () => {
    const ctx = {
      cfg: makeCfg(),
      signal: new AbortController().signal,
      approve: async () => true,
    };
    const missing = await dispatch("t_definitely_missing", "{}", ctx);
    expect(missing.ok).toBe(false);
    expect(missing.executed).toBe(false);
    expect(missing.output).toContain("未知工具");

    const off = registerTool(fakeTool("t_json_only", "should-not-run"));
    try {
      const bad = await dispatch("t_json_only", "not-json", ctx);
      expect(bad.ok).toBe(false);
      expect(bad.executed).toBe(false);
      expect(bad.output).toContain("不是合法 JSON");
    } finally {
      off();
    }
  });
});
