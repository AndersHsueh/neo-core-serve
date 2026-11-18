/**
 * K02：LifecyclePort 默认 no-op，以及 Agent 模块拆分后的公开面对照。
 *
 * 这些不是功能红测：默认端口不执行 hooks、不改历史、不阻断。
 * 不得据此宣称 core 已具备 hooks。
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Agent, renderFinal, type AgentIO } from "../../../src/core/agent.ts";
import { NOOP_LIFECYCLE_PORT, type LifecycleHookResult } from "../../../src/core/ports.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";
import type { Config, ModelTier } from "../../../src/core/config.ts";

const ROOT = join(import.meta.dir, "../../..");

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

function miniConfig(): Config {
  const models = { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" };
  const route = { provider: "t", model: null, fallbackAllowed: true };
  const tiers = ["default", "deep_reasoning", "balanced", "fast"] as const satisfies readonly ModelTier[];
  const routes = {} as Config["routes"];
  for (const t of tiers) routes[t] = route;
  return {
    providerName: "t",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://127.0.0.1",
    modelTier: "default",
    model: "m",
    providers: [
      {
        name: "t",
        type: "openai",
        baseUrl: "http://127.0.0.1",
        apiKey: "k",
        models,
        maxTokens: 1024,
        temperature: 0.6,
        contextWindow: 8000,
      },
    ],
    routes,
    classifierModel: "m",
    classifierProvider: "t",
    legacyFormat: false,
    maxTokens: 1024,
    temperature: 0.6,
    contextWindow: 8000,
    globalDefaults: { maxTokens: 1024, temperature: 0.6, contextWindow: 8000 },
    compactThreshold: 0.75,
    maxToolIterations: 8,
    toolOutputLimit: 1000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
    cwd: "/tmp",
    modelFallback: [],
    settingsPath: null,
    skillsStore: "/tmp/skills",
    memory: {
      enabled: false,
      userLevelDir: "/tmp/memorys",
      userWikiDir: "/tmp/wiki",
      journalDir: "/tmp/journal",
      autoRecall: { enabled: false, maxTokens: 0, projectPages: 0, userPages: 0 },
      autoCapture: {
        enabled: false,
        mode: "off",
        modelTier: "default",
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

function makeAgent(extra: ConstructorParameters<typeof Agent>[0] extends infer O ? Partial<O> : never = {}): Agent {
  return new Agent({
    cfg: miniConfig(),
    console: silentIo(),
    mode: "ask",
    systemPrompt: "sys",
    ...extra,
  });
}

const EMPTY: LifecycleHookResult = { blocked: false, reason: "", context: "", continue: false };

test("K02-B 源文件拆分后均不超过 1000 行，且 agent.ts 仍再导出公开类型", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(ROOT, "src/core"));
  const over = files
    .map((f) => ({ f: relative(ROOT, f), n: readFileSync(f, "utf8").split("\n").length }))
    .filter((x) => x.n > 1000 && !x.f.endsWith("session-host.ts") && !x.f.endsWith("tools/index.ts"));
  expect(over, over.map((x) => `${x.f}:${x.n}`).join(", ")).toEqual([]);
  const agentLines = readFileSync(join(ROOT, "src/core/agent.ts"), "utf8").split("\n").length;
  expect(agentLines).toBeLessThanOrEqual(1000);
  expect(typeof renderFinal("hi", 40)).toBe("string");
});

test("K02 LifecyclePort 默认 no-op：空上下文、不阻断、不改历史", async () => {
  const agent = makeAgent();
  const before = agent.messages.map((m) => m.content);
  const start = await agent.runSessionStart("new");
  const ups = await agent.ensureUserPromptSubmit("hello");
  const stop = await agent.runStopHooks(false);
  const pre = await agent.runPreCompact("manual");
  expect(start).toEqual(EMPTY);
  expect(ups).toEqual(EMPTY);
  expect(stop).toEqual(EMPTY);
  expect(pre).toEqual(EMPTY);
  expect(agent.messages.map((m) => m.content)).toEqual(before);
  const direct = await NOOP_LIFECYCLE_PORT.runSessionStart("resume");
  expect(direct).toEqual(EMPTY);
});

test("K02 runSessionStart 拒绝未知来源；子代理不调用注入端口", async () => {
  const agent = makeAgent();
  await expect(agent.runSessionStart("fork" as "new")).rejects.toThrow(/未知的 SessionStart 来源/);
  let called = 0;
  const child = makeAgent({
    isSubagent: true,
    lifecycle: {
      async runSessionStart() {
        called += 1;
        return { blocked: true, reason: "no", context: "x", continue: true };
      },
      async ensureUserPromptSubmit() {
        called += 1;
        return { blocked: true, reason: "no", context: "x", continue: true };
      },
      async runStopHooks() {
        called += 1;
        return { blocked: true, reason: "no", context: "x", continue: true };
      },
      async runPreCompact() {
        called += 1;
        return { blocked: true, reason: "no", context: "x", continue: true };
      },
    },
  });
  const before = child.messages.slice();
  expect(await child.runSessionStart("resume")).toEqual(EMPTY);
  expect(await child.ensureUserPromptSubmit("p")).toEqual(EMPTY);
  expect(await child.runStopHooks(true)).toEqual(EMPTY);
  expect(await child.runPreCompact("auto")).toEqual(EMPTY);
  expect(called).toBe(0);
  expect(child.messages).toEqual(before);
});
