/**
 * settings.json 片段解析（从 config.ts 抽出）。未知键忽略。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { EnvConfig } from "../env/types.ts";
import type { ShellConfig } from "../shell.ts";
import {
  DEFAULT_MAILBOX_CONFIG,
  resolveMailboxConfig,
  type InboundPolicy,
  type MailboxConfig,
} from "../mailbox/types.ts";
import {
  DEFAULT_OUTPUT_PROBE,
  DEFAULT_RETRY_CONFIG,
  IMPLEMENTED_PROVIDER_TYPES,
  MAX_MODEL_FALLBACKS,
  MODEL_TIERS,
  TIER_FIELD,
  isImplemented,
  type MemoryConfig,
  type ModelTarget,
  type ModelTier,
  type OutputProbeSettings,
  type PasteConfig,
  type Config,
  type ProviderConfig,
  type ProviderType,
  type RetryConfig,
} from "./types.ts";
import { DEFAULT_SELECTION_CONFIG, TIER_ORDER, type PromptSelectionConfig } from "../prompt/select.ts";

export type Raw = Record<string, unknown>;
/** paste.* 解析：settings.json > 内置默认（3 行 / 300 字符 / 8MB）。 */
/**
 * 解析 settings.shell（v0.4.0 平台适配层）。
 *
 * 只做形状校验：路径是否可执行由 shell.ts 在运行时探测（配置写错不崩，
 * 回退到自动探测并给出 warnings）。全缺省 = undefined（纯自动探测）。
 */
export function resolveShellConfig(raw: unknown): ShellConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: ShellConfig = {};
  const path = r["path"];
  if (typeof path === "string" && path.trim() !== "") out.path = path.trim();
  if (typeof r["login"] === "boolean") out.login = r["login"];
  const args = r["args"];
  if (Array.isArray(args)) {
    const clean = args.filter((a): a is string => typeof a === "string");
    if (clean.length > 0) out.args = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 settings.env（v0.4.0 平台适配层）。
 *
 * 默认全开：enabled=true、TTL 12h、注入提示词、写用户级 wiki 页。
 * -p/非交互模式是否落盘由组合根决定，不在此处。
 */
export function resolveEnvConfig(raw: unknown): EnvConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: EnvConfig = {};
  if (typeof r["enabled"] === "boolean") out.enabled = r["enabled"];
  if (typeof r["probe_ttl_hours"] === "number" && Number.isFinite(r["probe_ttl_hours"])) {
    out.probeTtlHours = Math.max(0, r["probe_ttl_hours"]);
  }
  if (typeof r["prompt"] === "boolean") out.prompt = r["prompt"];
  if (typeof r["wiki_page"] === "boolean") out.wikiPage = r["wiki_page"];
  const dir = r["dir"];
  if (typeof dir === "string" && dir.trim() !== "") out.dir = dir.trim();
  if (typeof r["models_probe_timeout_ms"] === "number" && Number.isFinite(r["models_probe_timeout_ms"])) {
    // 与 modelWindows.modelsProbeTimeoutMs 同一夹取范围。
    out.modelsProbeTimeoutMs = Math.min(60_000, Math.max(250, Math.floor(r["models_probe_timeout_ms"])));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolvePasteConfig(raw: Raw | undefined): PasteConfig {
  const r = raw ?? {};
  return {
    foldLines: num(r["fold_lines"], 3),
    foldChars: num(r["fold_chars"], 300),
    imageMaxBytes: num(r["image_max_bytes"], 8_388_608),
  };
}

/**
 * 跨会话消息配置（PRD v1.2 §4.6）。settings.json 顶层 snake_case 键；
 * 未配置项取 PRD 裁决默认值（watchdog 120s / 心跳 120s 判死 / 自动 turn 20）。
 */
export function resolveMailboxSettings(raw: Raw): MailboxConfig {
  return resolveMailboxConfig({
    autoTurnLimit: num(raw["cross_session_auto_turn_limit"], DEFAULT_MAILBOX_CONFIG.autoTurnLimit),
    heartbeatMs: num(raw["cross_session_heartbeat_ms"], DEFAULT_MAILBOX_CONFIG.heartbeatMs),
    deadAfterMs: num(raw["cross_session_dead_after_ms"], DEFAULT_MAILBOX_CONFIG.deadAfterMs),
    progressTimeoutMs: num(raw["cross_session_progress_timeout_ms"], DEFAULT_MAILBOX_CONFIG.progressTimeoutMs),
    watchdogIntervalS: num(raw["cross_session_watchdog_interval_s"], DEFAULT_MAILBOX_CONFIG.watchdogIntervalS),
  });
}

export function resolveInboundPolicy(raw: unknown): InboundPolicy | "auto" {
  return raw === "accept" || raw === "hold" || raw === "refuse" ? raw : "auto";
}

/**
 * 额外技能目录（v0.4.1 B3）：settings.skills_extra_paths + NEO_SKILLS_PATHS。
 * 只做去空白/去重；路径展开由 skills.ts 负责（需要 cfg.cwd 解析相对路径）。
 */
export function parseSkillsExtraPaths(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
    }
  }
  const envRaw = env["NEO_SKILLS_PATHS"];
  if (envRaw) {
    const sep = process.platform === "win32" ? ";" : ":";
    for (const p of envRaw.split(sep)) {
      if (p.trim() !== "") out.push(p.trim());
    }
  }
  return [...new Set(out)];
}

/**
 * LLM 重试/超时配置（P0-1）。settings.json `retry` 段，snake_case 键。
 *
 * 下限保护：max_attempts ≥1，超时 ≥1000ms —— 配成 0 会让所有请求立刻失败，
 * 这不是一个可以用配置表达的意图，直接兜底到合理值。
 */
export function resolveRetryConfig(raw: unknown): RetryConfig {
  const r = (raw ?? {}) as Raw;
  const d = DEFAULT_RETRY_CONFIG;
  return {
    maxAttempts: Math.max(1, Math.floor(num(r["max_attempts"], d.maxAttempts))),
    baseDelayMs: Math.max(0, Math.floor(num(r["base_delay_ms"], d.baseDelayMs))),
    connectTimeoutMs: Math.max(1000, Math.floor(num(r["connect_timeout_ms"], d.connectTimeoutMs))),
    streamIdleTimeoutMs: Math.max(1000, Math.floor(num(r["stream_idle_timeout_ms"], d.streamIdleTimeoutMs))),
  };
}


class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export { ConfigError };

export function readJson(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Raw;
  } catch (e) {
    throw new ConfigError(`配置文件解析失败 ${path}: ${(e as Error).message}`);
  }
}

export function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
export function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, "");
}


function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
/* ------------------------------------------------------------------ */
/* provider 解析                                                       */
/* ------------------------------------------------------------------ */

/** 解析 providers 数组。字段缺失时抛出可定位的错误，而不是静默用空值。 */
export function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError("settings.json 缺少 providers 数组，或它不是数组。");
  }
  if (raw.length === 0) {
    throw new ConfigError("providers 数组为空，至少需要一个 provider。");
  }

  return raw.map((entry, i): ProviderConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`providers[${i}] 不是对象。`);
    }
    const p = entry as Raw;
    const where = `providers[${i}]`;

    const name = str(p["provider_name"], "");
    if (!name) throw new ConfigError(`${where} 缺少 provider_name。`);

    const typeRaw = str(p["provider_type"], "");
    if (!typeRaw) throw new ConfigError(`${where}（${name}）缺少 provider_type。`);
    const type = typeRaw as ProviderType;
    if (type !== "openai" && type !== "anthropic") {
      throw new ConfigError(
        `${where}（${name}）的 provider_type = "${typeRaw}" 不是已知协议。` +
          `可用：openai、anthropic。`,
      );
    }

    const baseUrl = normalizeBaseUrl(str(p["base_url"], str(p["OpenAI"], "")));
    if (!baseUrl) {
      throw new ConfigError(`${where}（${name}）缺少 base_url。`);
    }

    const apiKey = str(p["api_key"], str(p["api-key"], ""));

    // 四个档位：缺失的档位回落到 default_model_name，再回落到任意已填档位
    const fallbackModel =
      str(p["default_model_name"], "") ||
      str(p["deep_reasoning_model_name"], "") ||
      str(p["balanced_model_name"], "") ||
      str(p["fast_model_name"], "");
    const models = {} as Record<ModelTier, string>;
    for (const tier of MODEL_TIERS) {
      models[tier] = str(p[TIER_FIELD[tier]], fallbackModel);
    }
    if (!fallbackModel) {
      throw new ConfigError(`${where}（${name}）的四个模型档位全部为空，至少要填 default_model_name。`);
    }

    return {
      name,
      type,
      baseUrl,
      apiKey,
      models,
      maxTokens: numOrNull(p["max_tokens"]),
      temperature: numOrNull(p["temperature"]),
      contextWindow: numOrNull(p["context_window"]),
      outputProbe: resolveOutputProbe(p["probe_max_output_tokens"]),
      vision: boolOrUndef(p["vision"]),
      tools: boolOrUndef(p["tools"]),
      reasoning: boolOrUndef(p["reasoning"]),
      maxOutputTokens: numOrNull(p["max_output_tokens"]),
    };
  });
}

/**
 * 旧版扁平格式 → ProviderConfig。
 * 旧字段：api-key / OpenAI / model_name。折算后四个档位共用同一模型。
 */
export function providerFromLegacy(raw: Raw): ProviderConfig | null {
  const baseUrl = normalizeBaseUrl(str(raw["OpenAI"], ""));
  const model = str(raw["model_name"], "");
  if (!baseUrl && !model) return null;

  return {
    name: "legacy",
    type: "openai",
    baseUrl: baseUrl || "https://api.openai.com/v1",
    apiKey: str(raw["api-key"], ""),
    models: {
      default: model,
      deep_reasoning: model,
      balanced: model,
      fast: model,
    },
    maxTokens: numOrNull(raw["max_tokens"]),
    temperature: numOrNull(raw["temperature"]),
    contextWindow: numOrNull(raw["context_window"]),
    outputProbe: resolveOutputProbe(raw["probe_max_output_tokens"]),
    vision: boolOrUndef(raw["vision"]),
    tools: boolOrUndef(raw["tools"]),
    reasoning: boolOrUndef(raw["reasoning"]),
    maxOutputTokens: numOrNull(raw["max_output_tokens"]),
  };
}

export function resolveMemoryConfig(raw: Raw | undefined): MemoryConfig {
  const r = raw ?? {};
  const envDisable = process.env["NEO_MEMORY_DISABLE"] === "1";
  const envDir = process.env["NEO_MEMORY_DIR"];
  const envUserWiki = process.env["NEO_USER_WIKI_DIR"];
  const envJournal = process.env["NEO_MEMORY_JOURNAL_DIR"];

  // 旧用户级目录：只用于 /memory migrate 与旧 profile.md 兼容读取
  const userLevelDirRaw = envDir ?? str(r["user_level_dir"], join(homedir(), ".neo", "memorys"));
  const userLevelDir = isAbsolute(userLevelDirRaw) ? userLevelDirRaw : resolve(userLevelDirRaw);

  const userWikiRaw = envUserWiki ?? str(r["user_wiki_dir"], join(homedir(), ".neo", "wiki"));
  const userWikiDir = isAbsolute(userWikiRaw) ? userWikiRaw : resolve(userWikiRaw);
  const memJournalRaw = envJournal ?? str(r["journal_dir"], join(homedir(), ".neo", "memory", "journal"));
  const journalDir = isAbsolute(memJournalRaw) ? memJournalRaw : resolve(memJournalRaw);

  const recallRaw = (r["auto_recall"] ?? {}) as Raw;
  const autoRecall = {
    enabled: bool(recallRaw["enabled"], true),
    maxTokens: num(recallRaw["max_tokens"], 900),
    projectPages: num(recallRaw["project_pages"], 2),
    userPages: num(recallRaw["user_pages"], 1),
  };

  const captureRaw = (r["auto_capture"] ?? {}) as Raw;
  const modeRaw = str(captureRaw["mode"], "boundary");
  const mode: "off" | "boundary" | "every_turn" =
    modeRaw === "off" || modeRaw === "every_turn" ? modeRaw : "boundary";
  const autoCapture = {
    enabled: bool(captureRaw["enabled"], true),
    mode,
    modelTier: str(captureRaw["model_tier"], "fast"),
    maxOpsPerTurn: num(captureRaw["max_ops_per_turn"], 2),
    maxPagesPerSession: num(captureRaw["max_pages_per_session"], 8),
    minConfidence: num(captureRaw["min_confidence"], 0.65),
    minInferredConfidence: num(captureRaw["min_inferred_confidence"], 0.75),
    journalRetentionDays: num(captureRaw["journal_retention_days"], 7),
    flushTimeoutMs: num(captureRaw["flush_timeout_ms"], 3000),
  };

  return {
    enabled: !envDisable && bool(r["enabled"], true),
    userLevelDir,
    userWikiDir,
    journalDir,
    autoRecall,
    autoCapture,
    quiet: bool(r["quiet"], false),
  };
}

/** 解析某档位在路由表下的实际模型名。route.model 为空则取该 provider 的同名档位。 */

function clampInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * 解析 settings 里的 `probe_max_output_tokens`：
 *  - 未配置（undefined）→ undefined，表示用户没表达意图；
 *  - 布尔简写 true/false → 只改 enabled；
 *  - 对象 → `{ enabled?: boolean, max_attempts?, start?, cap? }`，缺 enabled 视为开启；
 *  - 其它形状（字符串/数组/数字/null）→ undefined，不抛错。
 *
 * 越界值夹紧：max_attempts 1–8、start ≥256、cap < start 时以 start 为准。
 */

/**
 * 解析 settings.system_prompt（K08 / issue #20）。非法值一律回落默认，不报错：
 * 选档是增强项，配错不该阻止启动。未知键忽略。
 */
export function resolveSystemPromptConfig(raw: unknown): PromptSelectionConfig {
  const out: PromptSelectionConfig = { ...DEFAULT_SELECTION_CONFIG };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Raw;
  const mode = r["selection_mode"];
  if (mode === "budget-first" || mode === "context-gated") out.selectionMode = mode;
  const ratio = r["system_budget_ratio"];
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    out.systemBudgetRatio = Math.min(0.3, Math.max(0.05, ratio));
  }
  const maxTier = r["max_tier"];
  if (typeof maxTier === "string" && (TIER_ORDER as readonly string[]).includes(maxTier)) {
    out.maxTier = maxTier as PromptSelectionConfig["maxTier"];
  }
  const unknown = r["unknown_window_budget"];
  if (typeof unknown === "number" && Number.isFinite(unknown) && unknown > 0) {
    out.unknownWindowBudget = Math.floor(unknown);
  }
  if (typeof r["trust_known_window"] === "boolean") out.trustKnownWindow = r["trust_known_window"];
  return out;
}

export function resolveOutputProbe(raw: unknown): OutputProbeSettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return { ...DEFAULT_OUTPUT_PROBE, enabled: raw };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const enabled = typeof rec["enabled"] === "boolean" ? rec["enabled"] : true;
  const maxAttempts = clampInt(rec["max_attempts"], 1, 8) ?? DEFAULT_OUTPUT_PROBE.maxAttempts;
  const start = clampInt(rec["start"], 256, Number.MAX_SAFE_INTEGER) ?? DEFAULT_OUTPUT_PROBE.start;
  const capRaw = clampInt(rec["cap"], 256, Number.MAX_SAFE_INTEGER) ?? DEFAULT_OUTPUT_PROBE.cap;
  return { enabled, maxAttempts, start, cap: Math.max(capRaw, start) };
}

/** 校验一个 target：provider 必须存在且协议已接入，model 非空。 */
function assertModelTarget(target: ModelTarget, providers: ProviderConfig[], where: string): void {
  if (!target.provider || !target.model) {
    throw new ConfigError(`${where} 需要非空的 provider 与 model。`);
  }
  const found = providers.find((x) => x.name === target.provider);
  if (!found) {
    throw new ConfigError(
      `${where} 的 provider "${target.provider}" 不在 providers 列表中。` +
        `已配置：${providers.map((x) => x.name).join(", ") || "（无）"}`,
    );
  }
  if (!isImplemented(found.type)) {
    throw new ConfigError(
      `${where} 的 provider "${target.provider}" 声明为 ${found.type} 协议，但请求层尚未接入。` +
        `已实现：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。`,
    );
  }
}

/**
 * 严格解析 settings.model_fallback：只接受对象数组，不接受字符串简写、对象 map 或旧字段别名。
 * 缺省 / [] = 禁用；任何非法形状、未知 provider、空字段、重复项或超过 8 项都在模型请求前报错。
 */
export function resolveModelFallback(raw: unknown, providers: ProviderConfig[]): ModelTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("settings.model_fallback 必须是对象数组（[{provider, model}, ...]）。");
  }
  if (raw.length > MAX_MODEL_FALLBACKS) {
    throw new ConfigError(`settings.model_fallback 最多 ${MAX_MODEL_FALLBACKS} 项（收到 ${raw.length} 项）。`);
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `model_fallback[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConfigError(`${where} 必须是 {provider, model} 对象。`);
    }
    const rec = item as Record<string, unknown>;
    const target: ModelTarget = {
      provider: typeof rec["provider"] === "string" ? rec["provider"].trim() : "",
      model: typeof rec["model"] === "string" ? rec["model"].trim() : "",
    };
    assertModelTarget(target, providers, where);
    const key = `${target.provider}\u0000${target.model}`;
    if (seen.has(key)) {
      throw new ConfigError(`${where} 与前面的备用项重复：${target.provider}:${target.model}。`);
    }
    seen.add(key);
    return target;
  });
}

/**
 * 配置窗口来源：provider 自己写了窗口就是 config，否则是默认值。
 * C 没有 globalWindowExplicit 字段，缺省按 default。
 */
export function windowSourceFor(_cfg: Config, providerWindow: number | null | undefined): "config" | "default" {
  return providerWindow != null ? "config" : "default";
}

/**
 * 解析 CLI --fallback <provider>:<model>：在第一个冒号分割，两侧 trim 后必须非空。
 * provider 名本身含冒号不支持，避免二义。本函数供组合根使用；本波不改 neo-cli。
 */
export function parseFallbackTarget(text: string, providers: ProviderConfig[]): ModelTarget {
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) {
    throw new ConfigError(`--fallback 需要 <provider>:<model>（收到 "${text}"）。`);
  }
  const target: ModelTarget = {
    provider: text.slice(0, at).trim(),
    model: text.slice(at + 1).trim(),
  };
  assertModelTarget(target, providers, "--fallback");
  return target;
}

/**
 * 把会话共享 cfg 切到目标 provider+model（#59 / K07）。
 *
 * 重新赋 provider/协议/key/baseUrl/model、输出预算、温度与窗口事实；
 * 不复制来源模型的 maxTokens / 窗口 / baseUrl / key / 协议，也不写 settings。
 * modelTier 保留当前展示档位，但 fallback 身份优先于档位路由。
 * 未接入协议的目标必须抛错，不得静默按 OpenAI 发送。
 */
export function applyModelTarget(cfg: Config, target: ModelTarget): void {
  const p = cfg.providers.find((x) => x.name === target.provider);
  if (!p) throw new ConfigError(`备用目标 provider "${target.provider}" 不存在。`);
  if (!isImplemented(p.type)) {
    throw new ConfigError(`备用目标 provider "${target.provider}" 的 ${p.type} 协议未接入。`);
  }
  const g = cfg.globalDefaults;
  cfg.providerName = p.name;
  cfg.providerType = p.type;
  cfg.apiKey = p.apiKey;
  cfg.baseUrl = p.baseUrl;
  cfg.model = target.model;
  cfg.maxTokens = p.maxTokens ?? g.maxTokens;
  cfg.temperature = p.temperature ?? g.temperature;
  cfg.contextWindow = p.contextWindow ?? g.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, p.contextWindow);
}


