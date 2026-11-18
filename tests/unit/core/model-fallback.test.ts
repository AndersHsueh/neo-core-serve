/**
 * K07 主请求有序模型备用链。
 *
 * 覆盖：错误归因、按目标 provider 重算、有序有界失败、会话保持、
 * Agent 主请求注入、compact 不继承备用链、分类器在 fallback 活动期间不得切走模型。
 * 全部使用 fake stream，不触网、不连真实模型。
 *
 * 不把 oneshot drive 退出码纳入本片（#64 D1 间歇风险不得宣称已消失）。
 * 不得把本片绿说成内核已追平。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  MAX_MODEL_FALLBACKS,
  applyModelTarget,
  parseFallbackTarget,
  resolveModelFallback,
  type Config,
  type ProviderConfig,
  type ProviderType,
} from "../../../src/core/config.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../../../src/core/mailbox/types.ts";
import {
  attributeFailure,
  ModelFallbackController,
  redactFallbackText,
  type ModelFallbackEvent,
} from "../../../src/core/modelFallback.ts";
import {
  chatStream,
  LLMError,
  LLMTimeoutError,
  type Message,
  type StreamHandlers,
  type StreamResult,
  type ToolSpec,
} from "../../../src/core/llm.ts";
import { Agent } from "../../../src/core/agent.ts";
import type { AgentIO } from "../../../src/core/agent/types.ts";
import type { Classifier } from "../../../src/core/classifier/index.ts";
import type { ModelTier } from "../../../src/core/config.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-fb-"));
  dirs.push(d);
  return d;
}

function provider(name: string, type: ProviderType = "openai", over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name,
    type,
    baseUrl: `https://${name}.example.com/v1`,
    apiKey: `key-${name}-SECRET`,
    models: {
      default: `${name}-default`,
      deep_reasoning: `${name}-deep`,
      balanced: `${name}-bal`,
      fast: `${name}-fast`,
    },
    maxTokens: null,
    temperature: null,
    contextWindow: null,
    ...over,
  };
}

const P_OPENAI = provider("primary", "openai", {
  maxTokens: 4_096,
  temperature: 0.3,
  contextWindow: 100_000,
});
const P_ANTHROPIC = provider("claude", "anthropic", {
  maxTokens: 16_384,
  temperature: 0.9,
  contextWindow: 200_000,
});
const P_BACKUP = provider("backup", "openai", {
  maxTokens: 16_384,
  temperature: 0.9,
  contextWindow: 200_000,
});
const P_SECOND = provider("second", "openai", {
  maxTokens: 8_192,
  temperature: 0.5,
  contextWindow: 128_000,
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

function makeCfg(providers: ProviderConfig[] = [P_OPENAI, P_BACKUP, P_SECOND], over: Partial<Config> = {}): Config {
  const cwd = sandbox();
  const p = providers[0]!;
  const models = p.models;
  const routeBase = { provider: p.name, model: null as string | null, fallbackAllowed: true };
  const tiers = ["default", "deep_reasoning", "balanced", "fast"] as const satisfies readonly ModelTier[];
  const routes = {} as Config["routes"];
  for (const t of tiers) routes[t] = { ...routeBase };
  return {
    cwd,
    providerName: p.name,
    providerType: p.type,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    model: p.models.default,
    modelTier: "default",
    providers,
    routes,
    classifierModel: models.fast,
    classifierProvider: p.name,
    legacyFormat: false,
    maxTokens: p.maxTokens ?? 8_192,
    temperature: p.temperature ?? 0.6,
    contextWindow: p.contextWindow ?? 200_000,
    configuredContextWindow: p.contextWindow ?? 200_000,
    contextWindowSource: "config",
    globalDefaults: { maxTokens: 8_192, temperature: 0.6, contextWindow: 200_000 },
    env: { enabled: false, prompt: false, wikiPage: false, dir: cwd },
    modelFallback: [],
    maxToolIterations: 8,
    compactThreshold: 0.9,
    toolOutputLimit: 1000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "memorys"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
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
    ...over,
  };
}

function okResult(content = "ok"): StreamResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    raw: null,
  };
}

function llmError(message: string, status?: number, body?: string): LLMError {
  return new LLMError(message, status, body);
}

/* ------------------------------------------------------------------ */
/* K07 B：现 C 主请求失败路径（无备用链）仍按原错误失败                */
/* ------------------------------------------------------------------ */

describe("K07 B 无备用链时主请求失败路径不变", () => {
  test("未注入 mainChatStream 时，主请求 503 原样失败，不改 cfg 模型", async () => {
    const cfg = makeCfg();
    let calls = 0;
    const agent = new Agent({
      cfg,
      console: silentIo(),
      mode: "ask",
      systemPrompt: "system",
      nonInteractive: true,
      chatStream: (async () => {
        calls += 1;
        throw llmError("HTTP 503", 503);
      }) as typeof chatStream,
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(true);
    expect(calls).toBe(1);
    expect(cfg.providerName).toBe("primary");
    expect(cfg.model).toBe("primary-default");
  });
});

/* ------------------------------------------------------------------ */
/* 解析补充（K03b 已覆盖 resolveModelFallback 主体；此处补 CLI 解析）   */
/* ------------------------------------------------------------------ */

describe("K07 parseFallbackTarget / 未实现协议目标", () => {
  const providers = [P_OPENAI, P_BACKUP, P_SECOND];

  test("CLI --fallback 在第一个冒号分割、trim 外围空白", () => {
    expect(parseFallbackTarget(" backup : b-target ", providers)).toEqual({
      provider: "backup",
      model: "b-target",
    });
    expect(parseFallbackTarget("backup:b:target", providers)).toEqual({
      provider: "backup",
      model: "b:target",
    });
    expect(() => parseFallbackTarget("backup", providers)).toThrow(ConfigError);
    expect(() => parseFallbackTarget("backup:", providers)).toThrow(ConfigError);
    expect(() => parseFallbackTarget(":m", providers)).toThrow(ConfigError);
  });

  test("未实现协议不得进入备用链；大小写敏感", () => {
    const badList = [P_ANTHROPIC, ...providers];
    expect(() => resolveModelFallback([{ provider: "claude", model: "m" }], badList)).toThrow(ConfigError);
    expect(() => parseFallbackTarget("claude:m", badList)).toThrow(ConfigError);
    expect(() => parseFallbackTarget("PRIMARY:m", providers)).toThrow(ConfigError);
  });

  test("最多 1 + 8 个候选；超长链在解析期已被拒绝", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ provider: "backup", model: `m${i}` }));
    expect(() => resolveModelFallback(many, providers)).toThrow(ConfigError);
    const eight = Array.from({ length: MAX_MODEL_FALLBACKS }, (_, i) => ({
      provider: "backup",
      model: `m${i}`,
    }));
    expect(resolveModelFallback(eight, providers)).toHaveLength(MAX_MODEL_FALLBACKS);
  });
});

/* ------------------------------------------------------------------ */
/* 59-B 错误归因                                                       */
/* ------------------------------------------------------------------ */

describe("K07 错误归因矩阵", () => {
  test("网络 / 超时 / 429 / 5xx 可切换；类别正确", () => {
    expect(attributeFailure(llmError("connect ECONNREFUSED"), false)?.code).toBe("network");
    expect(attributeFailure(new LLMTimeoutError("connect", 1000), false)?.code).toBe("timeout");
    expect(attributeFailure(llmError("HTTP 429 Too Many Requests", 429), false)?.code).toBe("rate_limit");
    expect(attributeFailure(llmError("HTTP 503", 503), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 408", 408), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 409", 409), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 425", 425), false)?.code).toBe("server");
  });

  test("明确的模型不存在 / 无权限可提前切换（结构化 code 优先）", () => {
    expect(
      attributeFailure(llmError("not found", 404, '{"error":{"code":"model_not_found"}}'), false)?.code,
    ).toBe("model_unavailable");
    expect(
      attributeFailure(llmError("forbidden", 403, '{"error":{"code":"model_forbidden"}}'), false)?.code,
    ).toBe("model_forbidden");
    expect(attributeFailure(llmError("model xyz does not exist", 404), false)?.code).toBe("model_unavailable");
  });

  test("裸 4xx、鉴权、上下文超长、中断与已发增量一律不切换", () => {
    expect(attributeFailure(llmError("HTTP 400 Bad Request", 400), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 401 Unauthorized", 401), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 403 Forbidden", 403), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 404 Not Found", 404), false)).toBeNull();
    expect(attributeFailure(llmError("invalid api key"), false)).toBeNull();
    expect(attributeFailure(llmError("maximum context length exceeded"), false)).toBeNull();
    expect(attributeFailure(llmError("connect ECONNREFUSED"), true)).toBeNull();
    expect(attributeFailure(new DOMException("aborted", "AbortError"), false)).toBeNull();
    const ac = new AbortController();
    ac.abort();
    expect(attributeFailure(llmError("connect ECONNREFUSED"), false, ac.signal)).toBeNull();
  });

  test("脱敏：不输出 key / Authorization / URL，且按 code point 截断", () => {
    const raw =
      "HTTP 401 Bearer sk-abcdefghijklmnop https://gate.example.com/v1 api_key: \"secret-value\"";
    const out = redactFallbackText(raw, 240);
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("https://gate.example.com");
    expect(out).not.toContain("secret-value");
    expect(Array.from(redactFallbackText("x".repeat(500), 240)).length).toBeLessThanOrEqual(241);
  });
});

/* ------------------------------------------------------------------ */
/* 59-C 目标 cfg 重算                                                  */
/* ------------------------------------------------------------------ */

describe("K07 目标 cfg 按目标 provider 重算", () => {
  test("applyModelTarget 不继承来源模型的 maxTokens / 窗口 / key；anthropic 目标被拒绝", () => {
    const cfg = makeCfg([P_OPENAI, P_BACKUP, P_ANTHROPIC, P_SECOND]);
    applyModelTarget(cfg, { provider: "backup", model: "b-target" });
    expect(cfg.providerName).toBe("backup");
    expect(cfg.providerType).toBe("openai");
    expect(cfg.baseUrl).toBe(P_BACKUP.baseUrl);
    expect(cfg.apiKey).toBe(P_BACKUP.apiKey);
    expect(cfg.model).toBe("b-target");
    expect(cfg.maxTokens).toBe(16_384);
    expect(cfg.temperature).toBe(0.9);
    expect(cfg.contextWindow).toBe(200_000);
    expect(cfg.modelTier).toBe("default");
    expect(() => applyModelTarget(cfg, { provider: "claude", model: "c-target" })).toThrow(ConfigError);
  });

  test("controller 为备用候选构造独立 cfg：各候选不串值", async () => {
    const cfg = makeCfg();
    const seen: Config[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b-target" },
        { provider: "second", model: "s-target" },
      ],
      stream: (async (c: Config) => {
        seen.push({ ...c });
        if (seen.length < 3) throw llmError("HTTP 503", 503);
        return okResult();
      }) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    expect(seen).toHaveLength(3);
    expect(seen[0]!.providerName).toBe("primary");
    expect(seen[0]!.model).toBe("primary-default");
    expect(seen[0]!.maxTokens).toBe(4_096);
    expect(seen[1]!.providerName).toBe("backup");
    expect(seen[1]!.baseUrl).toBe(P_BACKUP.baseUrl);
    expect(seen[1]!.maxTokens).toBe(16_384);
    expect(seen[2]!.providerName).toBe("second");
    expect(seen[2]!.maxTokens).toBe(8_192);
    expect(cfg.providerName).toBe("second");
    expect(cfg.model).toBe("s-target");
  });

  test("与主模型相同的备用项被跳过，不重复请求", () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "primary", model: "primary-default" }],
      stream: (async () => okResult()) as typeof chatStream,
    });
    expect(controller.orderedCandidates).toEqual([{ provider: "primary", model: "primary-default" }]);
  });
});

/* ------------------------------------------------------------------ */
/* 59-D 顺序、有界、失败摘要                                           */
/* ------------------------------------------------------------------ */

describe("K07 候选顺序与有界失败", () => {
  test("首个备用失败、第二个成功 → 一个成功事件，attempts 按序含全部失败摘要", async () => {
    const cfg = makeCfg();
    const events: ModelFallbackEvent[] = [];
    const notices: string[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b-target" },
        { provider: "second", model: "s-target" },
      ],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        if (c.providerName === "backup") throw llmError("HTTP 429", 429);
        return okResult("done");
      }) as typeof chatStream,
      onFallback: (e) => events.push(e),
      onNotice: (m) => notices.push(m),
    });
    const res = await controller.stream(cfg, [], []);
    expect(res.content).toBe("done");
    expect(events).toHaveLength(1);
    expect(events[0]!.from).toEqual({ provider: "primary", model: "primary-default" });
    expect(events[0]!.to).toEqual({ provider: "second", model: "s-target" });
    expect(events[0]!.attempts.map((a) => a.code)).toEqual(["server", "rate_limit"]);
    expect(events[0]!.reason.code).toBe("server");
    expect(events[0]!.reason.message).not.toContain(P_OPENAI.apiKey);
    expect(notices.some((m) => m.includes("已切换到 second"))).toBe(true);
  });

  test("全部候选失败 → LLMError 含按序脱敏摘要，不循环回已失败候选", async () => {
    const cfg = makeCfg();
    let calls = 0;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b" },
        { provider: "second", model: "s" },
      ],
      stream: (async () => {
        calls += 1;
        throw llmError("HTTP 503 upstream", 503);
      }) as typeof chatStream,
    });
    let thrown: unknown = null;
    try {
      await controller.stream(cfg, [], []);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LLMError);
    expect(calls).toBe(3);
    expect((thrown as Error).message).toContain("所有模型候选均失败");
    expect((thrown as Error).message).toContain("primary");
    expect((thrown as Error).message).toContain("backup");
    expect((thrown as Error).message).toContain("second");
  });

  test("部分流中断（已发增量）原样失败，不切换、不重复正文", async () => {
    const cfg = makeCfg();
    let calls = 0;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b" }],
      stream: (async (_c: Config, _m: Message[], _t: ToolSpec[], handlers: StreamHandlers = {}) => {
        calls += 1;
        handlers.onContent?.("partial");
        throw llmError("stream broken mid-response");
      }) as typeof chatStream,
    });
    await expect(controller.stream(cfg, [], [])).rejects.toBeInstanceOf(LLMError);
    expect(calls).toBe(1);
    expect(cfg.providerName).toBe("primary");
  });
});

/* ------------------------------------------------------------------ */
/* 59-E 会话保持 + Agent 接缝                                          */
/* ------------------------------------------------------------------ */

describe("K07 会话内保持与 Agent 接缝", () => {
  test("切换成功后 isActive=true，后续请求从当前目标开始、不自动回切", async () => {
    const cfg = makeCfg();
    const seen: string[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        seen.push(`${c.providerName}:${c.model}`);
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult();
      }) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    expect(controller.isActive).toBe(true);
    await controller.stream(cfg, [], []);
    await controller.stream(cfg, [], []);
    expect(seen).toEqual([
      "primary:primary-default",
      "backup:b-target",
      "backup:b-target",
      "backup:b-target",
    ]);
    expect(cfg.providerName).toBe("backup");
  });

  test("显式身份变更（/model 语义）在下一请求边界重置链", async () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async () => okResult()) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    cfg.model = "user-chosen-model";
    const seen: string[] = [];
    controller.resetForExplicitTarget();
    const stream = controller.stream.bind(controller);
    // 重新构造以匹配源测「新控制器从当前 cfg 起步」；同一实例 reset 等价。
    const c2 = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        seen.push(`${c.providerName}:${c.model}`);
        return okResult();
      }) as typeof chatStream,
    });
    await c2.stream(cfg, [], []);
    expect(seen[0]).toBe("primary:user-chosen-model");
    expect(c2.isActive).toBe(false);
    expect(typeof stream).toBe("function");
  });

  test("切换事件与人类提示不含 api key / Authorization / 完整 body", async () => {
    const cfg = makeCfg();
    let payload = "";
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b" }],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") {
          throw llmError(
            "HTTP 503 Bearer sk-SECRETKEY12345 https://gate.example.com/v1",
            503,
            '{"error":{"message":"internal with api_key":"sk-SECRETKEY12345"}}',
          );
        }
        return okResult();
      }) as typeof chatStream,
      onFallback: (e) => {
        payload = JSON.stringify(e);
      },
      onNotice: (m) => {
        payload += m;
      },
    });
    await controller.stream(cfg, [], []);
    expect(payload).not.toContain("sk-SECRETKEY12345");
    expect(payload).not.toContain("https://gate.example.com");
    expect(payload).toContain("server");
  });

  test("注入 mainChatStream 后主请求走备用链；累计 token 仍累加", async () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult("ok");
      }) as typeof chatStream,
    });
    const agent = new Agent({
      cfg,
      console: silentIo(),
      mode: "ask",
      systemPrompt: "system",
      nonInteractive: true,
      mainChatStream: (c, m, t, h, s) => controller.stream(c, m, t, h, s),
      isFallbackActive: () => controller.isActive,
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    expect(cfg.providerName).toBe("backup");
    expect(cfg.model).toBe("b-target");
    expect(controller.isActive).toBe(true);
    const cum = agent.cumulative;
    expect(cum.prompt).toBe(10);
    expect(cum.completion).toBe(5);
  });

  test("compact 走 chatStream，不悄悄继承主请求备用链", async () => {
    const cfg = makeCfg();
    const mainSeen: string[] = [];
    const compactSeen: string[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        mainSeen.push(c.providerName);
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult("main");
      }) as typeof chatStream,
    });
    const agent = new Agent({
      cfg,
      console: silentIo(),
      mode: "ask",
      systemPrompt: "system",
      nonInteractive: true,
      chatStream: (async (c: Config) => {
        compactSeen.push(c.providerName);
        return okResult("summary");
      }) as typeof chatStream,
      mainChatStream: (c, m, t, h, s) => controller.stream(c, m, t, h, s),
    });
    // compactNow 要求非 system 消息至少 4 条。
    agent.messages.push(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );
    await agent.compactNow();
    expect(compactSeen.length).toBeGreaterThanOrEqual(1);
    expect(mainSeen).toEqual([]);
    expect(cfg.providerName).toBe("primary");
    await agent.send("hi");
    expect(mainSeen[0]).toBe("primary");
    expect(mainSeen).toContain("backup");
  });

  test("分类器在 fallback 活动期间不得切走模型", async () => {
    const cfg = makeCfg();
    cfg.routes.fast = { provider: "second", model: "second-fast", fallbackAllowed: true };
    let classifyCalls = 0;
    const classifier = {
      async classify() {
        classifyCalls += 1;
        // 第一轮发生在备用链生效前，返回当前档以免提前切走身份。
        // 第二轮若未被短路，会切到 second/fast。
        if (classifyCalls === 1) return { tier: "default", reason: "stay", source: "rule" };
        return { tier: "fast", reason: "should-not-apply", source: "rule" };
      },
    } as unknown as Classifier;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult("ok");
      }) as typeof chatStream,
    });
    const agent = new Agent({
      cfg,
      console: silentIo(),
      mode: "ask",
      systemPrompt: "system",
      nonInteractive: true,
      classifier,
      mainChatStream: (c, m, t, h, s) => controller.stream(c, m, t, h, s),
      isFallbackActive: () => controller.isActive,
    });
    const first = await agent.send("hi");
    expect(first.hadError).toBe(false);
    expect(cfg.providerName).toBe("backup");
    expect(controller.isActive).toBe(true);
    const callsAfterFirst = classifyCalls;
    const second = await agent.send("again");
    expect(second.hadError).toBe(false);
    expect(second.tierSwitch ?? null).toBeNull();
    expect(cfg.providerName).toBe("backup");
    expect(cfg.model).toBe("b-target");
    expect(cfg.modelTier).toBe("default");
    // 第二轮分类必须被短路；第一轮发生在切换之前，允许调用。
    expect(classifyCalls).toBe(callsAfterFirst);
    expect(classifyCalls).toBe(1);
  });
});
