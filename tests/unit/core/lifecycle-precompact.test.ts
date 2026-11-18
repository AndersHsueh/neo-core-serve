/**
 * K14：LifecyclePort PreCompact 注入点形状（纯内存假 port）。
 *
 * 锁住：拒绝发生在 planCompaction 之前；拒绝后历史与 lastCompact 不变；
 * 不得落入 trimOldToolOutputs。完整 PreCompact 进程语义留 K26。
 * 不启动真实 hook 进程。不得把本测试说成 hooks 已迁入 core。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../../../src/core/agent.ts";
import { CompactBlockedError } from "../../../src/core/agent/lifecycle.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";
import { LLMError, type StreamResult } from "../../../src/core/llm.ts";
import {
  NOOP_LIFECYCLE_PORT,
  type CompactTrigger,
  type LifecycleHookResult,
  type LifecyclePort,
} from "../../../src/core/ports.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-core-precompact-"));

afterAll(() => {
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
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m1",
    providers: [],
    routes,
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0,
    contextWindow: 8_000,
    contextWindowSource: "config",
    globalDefaults: { maxTokens: 100, temperature: 0, contextWindow: 8_000 },
    compactThreshold: 0.01,
    maxToolIterations: 8,
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
      autoRecall: { enabled: false, maxTokens: 0, projectPages: 0, userPages: 0 },
      autoCapture: {
        enabled: false,
        mode: "off",
        modelTier: "fast",
        maxOpsPerTurn: 0,
        maxPagesPerSession: 0,
        minConfidence: 0,
        minInferredConfidence: 0,
        journalRetentionDays: 0,
        flushTimeoutMs: 0,
      },
      quiet: true,
    },
    ...over,
  };
}

const EMPTY: LifecycleHookResult = { blocked: false, reason: "", context: "", continue: false };
const TRIM_MARK = "旧工具输出已裁剪";

function blockingPort(log: Array<{ trigger: CompactTrigger }>, reason = "no-compact"): LifecyclePort {
  return {
    ...NOOP_LIFECYCLE_PORT,
    async runPreCompact(trigger: CompactTrigger) {
      log.push({ trigger });
      return { ...EMPTY, blocked: true, reason };
    },
  };
}

function seedLong(agent: Agent): void {
  agent.messages.push(
    { role: "user", content: "u1" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "shell", content: "OLD_TOOL_OUTPUT_KEEP_ME" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  );
}

describe("K14 PreCompact 假 port 形状", () => {
  test("拒绝发生在 planCompaction 之前：短历史被阻断时抛 CompactBlockedError，而不是「对话太短」", async () => {
    const log: Array<{ trigger: CompactTrigger }> = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      lifecycle: blockingPort(log),
    });
    agent.messages.push({ role: "user", content: "hi" }, { role: "assistant", content: "yo" });
    const before = agent.messages.map((m) => m.content);
    const last = agent.lastCompactionInfo;
    await expect(agent.compactNow()).rejects.toBeInstanceOf(CompactBlockedError);
    await expect(agent.compactNow()).rejects.toThrow("no-compact");
    expect(log).toEqual([{ trigger: "manual" }, { trigger: "manual" }]);
    expect(agent.messages.map((m) => m.content)).toEqual(before);
    expect(agent.lastCompactionInfo).toEqual(last);
  });

  test("拒绝后历史与 lastCompact 不变，且不调用摘要器", async () => {
    const log: Array<{ trigger: CompactTrigger }> = [];
    let summarizerCalls = 0;
    const stream = async (): Promise<StreamResult> => {
      summarizerCalls += 1;
      return { content: "不应生成的摘要", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null };
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      lifecycle: blockingPort(log, "keep-history"),
    });
    seedLong(agent);
    agent.lastCompact = { beforeTokens: 99, afterTokens: 88 };
    const snap = agent.messages.map((m) => ({ ...m, content: m.content }));
    await expect(agent.compactNow({ compactTrigger: "auto" })).rejects.toBeInstanceOf(CompactBlockedError);
    expect(log).toEqual([{ trigger: "auto" }]);
    expect(summarizerCalls).toBe(0);
    expect(agent.messages).toHaveLength(snap.length);
    expect(agent.messages.map((m) => m.content)).toEqual(snap.map((m) => m.content));
    expect(agent.lastCompactionInfo).toEqual({ beforeTokens: 99, afterTokens: 88 });
  });

  test("溢出恢复被拒绝时不得落入 trimOldToolOutputs，本轮明确失败", async () => {
    const log: Array<{ trigger: CompactTrigger }> = [];
    let calls = 0;
    const stream = async (): Promise<StreamResult> => {
      calls += 1;
      throw new LLMError("This model's maximum context length is 128000 tokens", 400);
    };
    const agent = new Agent({
      cfg: makeCfg({ compactThreshold: 0.99, contextWindow: 100_000 }),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      lifecycle: blockingPort(log, "stop-overflow"),
    });
    seedLong(agent);
    const beforeTools = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const stats = await agent.send("继续");
    expect(log.some((x) => x.trigger === "auto")).toBe(true);
    expect(agent.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(beforeTools);
    expect(JSON.stringify(agent.messages).includes(TRIM_MARK)).toBe(false);
    expect(JSON.stringify(agent.messages).includes("OLD_TOOL_OUTPUT_KEEP_ME")).toBe(true);
    expect(stats.hadError).toBe(true);
    expect(stats.errorMessage).toContain("PreCompact");
    expect(stats.errorMessage).toContain("stop-overflow");
    // 有界：拒绝后不再用 trim 重试出第三次模型请求（主请求 1 次即停）
    expect(calls).toBe(1);
  });

  test("compact() 不得把 PreCompact 拒绝吞成 ordinary false", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      lifecycle: blockingPort([]),
    });
    seedLong(agent);
    await expect(agent.compact()).rejects.toBeInstanceOf(CompactBlockedError);
  });
});
