/**
 * K12：LifecyclePort UserPromptSubmit 注入点形状（纯内存假 port）。
 *
 * 锁住：UPS 在分类器之前被调用一次；阻断时零模型请求且历史不动。
 * 不启动真实 hook 进程。不得把本测试说成 hooks 已迁入 core。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../../../src/core/agent.ts";
import type { Classifier } from "../../../src/core/classifier/index.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";
import type { StreamResult } from "../../../src/core/llm.ts";
import {
  NOOP_LIFECYCLE_PORT,
  type LifecycleHookResult,
  type LifecyclePort,
} from "../../../src/core/ports.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-core-ups-"));

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

function makeCfg(): Config {
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
    maxTokens: 100,
    temperature: 0,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.8,
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
  };
}

const EMPTY: LifecycleHookResult = { blocked: false, reason: "", context: "", continue: false };

function tracingPort(log: string[], blocked = false): LifecyclePort {
  return {
    ...NOOP_LIFECYCLE_PORT,
    async ensureUserPromptSubmit(prompt: string) {
      log.push(`ups:${prompt}`);
      if (blocked) return { ...EMPTY, blocked: true, reason: "policy" };
      return { ...EMPTY };
    },
  };
}

describe("K12 UserPromptSubmit 假 port 形状", () => {
  test("UPS 在分类器前被调用一次；放行后才会分类并请求模型", async () => {
    const order: string[] = [];
    const port = tracingPort(order);
    const classifier = {
      async classify(input: string) {
        order.push(`classify:${input}`);
        return null;
      },
    } as unknown as Classifier;
    const stream = async (): Promise<StreamResult> => {
      order.push("model");
      return {
        content: "ok",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      };
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      classifier,
      chatStream: stream,
      lifecycle: port,
    });
    const before = agent.messages.map((m) => m.content);
    const stats = await agent.send("hello-ups");
    expect(stats.hadError).toBe(false);
    expect(order).toEqual(["ups:hello-ups", "classify:hello-ups", "model"]);
    expect(agent.messages.some((m) => m.role === "user" && m.content === "hello-ups")).toBe(true);
    expect(before).toEqual(["sys"]);
  });

  test("阻断时零模型请求（含分类器）且历史不动", async () => {
    const order: string[] = [];
    const port = tracingPort(order, true);
    const classifier = {
      async classify() {
        order.push("classify");
        return null;
      },
    } as unknown as Classifier;
    let modelCalls = 0;
    const stream = async (): Promise<StreamResult> => {
      modelCalls += 1;
      order.push("model");
      return {
        content: "should-not-run",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      };
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      classifier,
      chatStream: stream,
      lifecycle: port,
    });
    const before = agent.messages.slice();
    const stats = await agent.send("blocked-input");
    expect(order).toEqual(["ups:blocked-input"]);
    expect(modelCalls).toBe(0);
    expect(agent.messages).toEqual(before);
    expect(agent.messages.some((m) => m.role === "user")).toBe(false);
    expect(stats.hadError).toBe(false);
    expect(stats.emptyResponse).toBe(false);
    expect(stats.iterations).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.errorMessage).toContain("阻断");
    expect(stats.finishReason).toBe("blocked");
  });

  test("子代理不调用注入的 UPS 端口，但主循环仍请求模型", async () => {
    const order: string[] = [];
    const port = tracingPort(order, true);
    const stream = async (): Promise<StreamResult> => {
      order.push("model");
      return {
        content: "child-ok",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      };
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentIo(),
      mode: "auto-all",
      systemPrompt: "sys",
      isSubagent: true,
      chatStream: stream,
      lifecycle: port,
    });
    const stats = await agent.send("child-prompt");
    expect(order).toEqual(["model"]);
    expect(stats.hadError).toBe(false);
    expect(agent.messages.some((m) => m.role === "user" && m.content === "child-prompt")).toBe(true);
  });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
