/**
 * 配置加载。
 *
 * 结构（settings.json）：
 *   default_provider     使用哪个 provider（对应 providers[].provider_name）
 *   default_model_tier   使用哪个模型档位
 *   providers[]          每个 provider 一段独立配置
 *   其余全局字段         与 provider 无关的运行时参数
 *
 * 优先级（从低到高）：settings.example.json → ./settings.json → 环境变量 → CLI 覆盖。
 * 环境变量：NEO_PROVIDER / NEO_TIER / NEO_API_KEY / NEO_BASE_URL / NEO_MODEL。
 *
 * 兼容性：仍能读旧版扁平格式（api-key / OpenAI / model_name 位于顶层），
 * 自动折算成一个名为 legacy 的 provider 并给出警告。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_OUTPUT_PROBE,
  DEFAULT_RETRY_CONFIG,
  IMPLEMENTED_PROVIDER_TYPES,
  MAX_MODEL_FALLBACKS,
  MODEL_TIERS,
  isImplemented,
  isModelTier,
  normalizeTierName,
  tierChoiceLabel,
  tierDisplayName,
  type Config,
  type MemoryConfig,
  type ModelTarget,
  type ModelTier,
  type OutputProbeSettings,
  type PasteConfig,
  type ProviderConfig,
  type ProviderType,
  type RetryConfig,
  type RouteConfig,
} from "./config/types.ts";
import {
  ConfigError,
  normalizeBaseUrl,
  parseProviders,
  parseSkillsExtraPaths,
  providerFromLegacy,
  readJson,
  resolveEnvConfig,
  resolveInboundPolicy,
  resolveMailboxSettings,
  resolveMemoryConfig,
  resolveModelFallback,
  resolveOutputProbe,
  resolvePasteConfig,
  resolveRetryConfig,
  resolveShellConfig,
  str,
  bool,
  num,
  type Raw,
} from "./config/parse.ts";

export {
  DEFAULT_OUTPUT_PROBE,
  DEFAULT_RETRY_CONFIG,
  IMPLEMENTED_PROVIDER_TYPES,
  MAX_MODEL_FALLBACKS,
  MODEL_TIERS,
  isImplemented,
  isModelTier,
  normalizeTierName,
  tierChoiceLabel,
  tierDisplayName,
  ConfigError,
  normalizeBaseUrl,
  parseSkillsExtraPaths,
  resolveModelFallback,
  resolveOutputProbe,
  resolveRetryConfig,
};
export type {
  Config,
  MemoryConfig,
  ModelTarget,
  ModelTier,
  OutputProbeSettings,
  PasteConfig,
  ProviderConfig,
  ProviderType,
  RetryConfig,
  RouteConfig,
};


/* ------------------------------------------------------------------ */
/* 载入                                                                */
/* ------------------------------------------------------------------ */

/**
 * loadConfig 的可选第二参数（K03a）。
 *
 * `settingsDir`：settings.json 的搜索根。缺省时仍从 `overrides.cwd` 或
 * `process.cwd()` 起步（既有行为）。`spawnDir` / `pkgRoot` / `homeDir` /
 * `env` 可注入，便于测试，也供后续 loadRuntimeConfig 做显式快照。
 * 调用时不 process.chdir。
 */
export interface LoadConfigOptions {
  settingsDir?: string;
  spawnDir?: string;
  pkgRoot?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export function loadConfig(overrides: Partial<Config> = {}, options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const here = process.cwd();
  const spawnDir = options.spawnDir ?? here;
  const home = options.homeDir ?? homedir();
  // Matrix-Core 移植改动（2026-10-28）：配置搜索从「会话 cwd」起步，
  // 否则 `--cwd DIR` 不会读该目录的 settings.json（main 不一定 chdir）。
  const searchCwd =
    overrides.cwd !== undefined
      ? isAbsolute(overrides.cwd)
        ? overrides.cwd
        : resolve(here, overrides.cwd)
      : here;
  // v0.4.0：Windows 上 URL.pathname 是 /C:/... 形态，必须用 fileURLToPath 还原盘符路径。
  // Matrix-Core：config.ts 从 src/ 下沉到 src/core/，包根要多上一级。
  const pkgRoot =
    options.pkgRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const searchRoot =
    options.settingsDir !== undefined
      ? isAbsolute(options.settingsDir)
        ? options.settingsDir
        : resolve(here, options.settingsDir)
      : searchCwd;
  // 显式工作区（settingsDir 或 overrides.cwd）且不同于启动目录时，
  // 缺工作区 settings 回落到 spawn，而不是直接掉进包装根密钥。
  const explicitSearch = options.settingsDir !== undefined || overrides.cwd !== undefined;
  const candidates = [
    join(searchRoot, "settings.json"),
    ...(explicitSearch && resolve(searchRoot) !== resolve(spawnDir)
      ? [join(spawnDir, "settings.json")]
      : []),
    join(pkgRoot, "settings.json"),
    join(home, ".neo", "settings.json"),
  ];
  const found = candidates.find((p) => existsSync(p)) ?? null;
  const raw = found ? (readJson(found) ?? {}) : {};
  const dflt = readJson(join(pkgRoot, "settings.example.json")) ?? {};

  // providers 是数组，无法用 {...a, ...b} 浅合并，必须按「本地优先」逐级判定。
  // 关键顺序：本地 settings.json 的旧版字段必须优先于模板的 providers。
  // 否则用户拿着旧配置会静默套用 settings.example.json 的示例密钥与地址 ——
  // 不报错，但请求全打到别人的网关上，这种失败极难排查。
  let providers: ProviderConfig[];
  let legacyFormat = false;
  const localList = raw["providers"];
  const localLegacy = providerFromLegacy(raw);
  const tplList = dflt["providers"];
  const tplLegacy = providerFromLegacy(dflt);

  if (localList !== undefined) {
    providers = parseProviders(localList);
  } else if (localLegacy) {
    providers = [localLegacy];
    legacyFormat = true;
  } else if (tplList !== undefined) {
    providers = parseProviders(tplList);
  } else if (tplLegacy) {
    providers = [tplLegacy];
    legacyFormat = true;
  } else {
    throw new ConfigError(
      `未在 ${found ?? "任何搜索路径"} 找到可用的 provider 配置。` +
        `请参考 settings.example.json 写一份 settings.json。`,
    );
  }

  // 默认 provider：环境变量 > settings.json > 列表第一项。
  // 不从模板回落 —— 模板的 "example" 是示例名，本地 providers 里通常没有这个名字，
  // 回落它会让 picked 静默退化成列表第一项，掩盖配置错误。
  const defProviderName = str(
    env["NEO_PROVIDER"],
    str(raw["default_provider"], providers[0]?.name ?? ""),
  );
  const picked =
    providers.find((p) => p.name === defProviderName) ?? providers[0];
  if (!picked) throw new ConfigError("没有可用的 provider。");

  // 默认档位
  const tierRaw = str(
    env["NEO_TIER"],
    str(raw["default_model_tier"], str(dflt["default_model_tier"], "default")),
  );
  const tier: ModelTier = isModelTier(tierRaw) ? tierRaw : "default";

  // 全局默认（provider 未覆盖时使用）
  const gMax = num(raw["max_tokens"], num(dflt["max_tokens"], 8192));
  const gTemp = num(raw["temperature"], num(dflt["temperature"], 0.6));
  const gCtx = num(raw["context_window"], num(dflt["context_window"], 200_000));

  // ---- 档位路由 ----
  // 未显式配置时，每个档位都指向当前 provider 的对应模型（即旧的单provider 行为）。
  // 同样不从模板回落 model_routes：模板里的 provider 名（"example"）与本地无关，
  // 混进来会凭空造出一条指向不存在 provider 的路由，或直接抛错。
  const rawRoutes = raw["model_routes"] as Raw | undefined;
  const routes = {} as Record<ModelTier, RouteConfig>;
  for (const t of MODEL_TIERS) {
    const entry = rawRoutes?.[t];
    if (entry !== undefined && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const r = entry as Raw;
      const rProvider = str(r["provider"], "");
      if (!rProvider) {
        throw new ConfigError(`model_routes.${t} 缺少 provider 字段。`);
      }
      if (!providers.some((p) => p.name === rProvider)) {
        throw new ConfigError(
          `model_routes.${t}.provider = "${rProvider}" 不在 providers 列表中。` +
            `已配置：${providers.map((p) => p.name).join(", ")}`,
        );
      }
      routes[t] = {
        provider: rProvider,
        model: str(r["model"], ""),
        fallbackAllowed: bool(r["fallback_allowed"], true),
      };
    } else if (entry !== undefined && typeof entry === "string") {
      // 简写形式："fast": "ipsa" 等价于 {provider:"ipsa", model:null}
      const name = entry as string;
      if (!providers.some((p) => p.name === name)) {
        throw new ConfigError(`model_routes.${t} = "${name}" 不在 providers 列表中。`);
      }
      routes[t] = { provider: name, model: null, fallbackAllowed: true };
    } else {
      routes[t] = { provider: picked.name, model: null, fallbackAllowed: true };
    }
  }

  // 分类器固定绑在外部指定的 provider 上 —— 不能让它用自己的分类结果选自己
  //
  // 注意：classifier_provider 是「身份」字段，不能从模板回落。
  // 模板里写的是示例值 "example"，本地配置若没写这一项就回落模板，
  // 会得到一个不在本地 providers 列表里的名字，直接把启动卡死。
  // 这与 providers 的处理是同一个道理：身份字段只认本地，模板只提供可调参数。
  const classifierProvider = str(
    env["NEO_CLASSIFIER_PROVIDER"],
    str(raw["classifier_provider"], str(raw["default_provider"], picked.name)),
  );
  const clsProv = providers.find((p) => p.name === classifierProvider);
  if (!clsProv) {
    throw new ConfigError(
      `classifier_provider = "${classifierProvider}" 不在 providers 列表中。` +
        `已配置：${providers.map((p) => p.name).join(", ")}`,
    );
  }
  // 同理，模型名也不从模板取 —— 模板值是 "your-fast-model-id" 这种占位符，
  // 落到真实请求里就是一次必然失败的调用。缺省用该 provider 的 fast 模型。
  const classifierModel = str(
    env["NEO_CLASSIFIER_MODEL"],
    str(raw["classifier_model_name"], clsProv.models["fast"]),
  );

  const cfg: Config = {
    providerName: picked.name,
    providerType: picked.type,
    // 环境变量优先级最高
    apiKey: str(env["NEO_API_KEY"], picked.apiKey),
    baseUrl: normalizeBaseUrl(str(env["NEO_BASE_URL"], picked.baseUrl)),
    modelTier: tier,
    model: str(env["NEO_MODEL"], routeModel(routes[tier], providers, tier)),
    providers,
    routes,
    classifierModel,
    classifierProvider,
    legacyFormat,

    maxTokens: picked.maxTokens ?? gMax,
    temperature: picked.temperature ?? gTemp,
    contextWindow: picked.contextWindow ?? gCtx,
    configuredContextWindow: picked.contextWindow ?? gCtx,
    contextWindowSource: "config",
    globalDefaults: { maxTokens: gMax, temperature: gTemp, contextWindow: gCtx },
    compactThreshold: num(raw["compact_threshold"], num(dflt["compact_threshold"], 0.75)),
    maxToolIterations: num(raw["max_tool_iterations"], num(dflt["max_tool_iterations"], 80)),
    toolOutputLimit: num(raw["tool_output_limit"], num(dflt["tool_output_limit"], 30_000)),
    retry: resolveRetryConfig(raw["retry"]),
    theme: str(raw["theme"], str(dflt["theme"], "matrix")),
    showReasoning: bool(raw["show_reasoning"], bool(dflt["show_reasoning"], true)),
    // 兼容用户手写的连字符键名；项目惯例仍是 snake_case。
    toolcallInfoDetails: bool(
      raw["toolcall_info_details"],
      bool(raw["toolcall-info-details"], false),
    ),
    cwd: searchCwd,
    settingsPath: found,
    skillsStore: str(raw["skills_store"], join(home, ".neo", "skills")),
    skillsExtraPaths: parseSkillsExtraPaths(raw["skills_extra_paths"]),
    memory: resolveMemoryConfig(raw["memory"] as Raw | undefined),
    shell: resolveShellConfig(raw["shell"]),
    env: resolveEnvConfig(raw["env"]),
    paste: resolvePasteConfig(raw["paste"] as Raw | undefined),
    mailbox: resolveMailboxSettings(raw),
    crossSessionInbound: resolveInboundPolicy(raw["cross_session_inbound"]),
    modelFallback: resolveModelFallback(raw["model_fallback"], providers),
    ...overrides,
  };

  if (overrides.cwd && !isAbsolute(overrides.cwd)) cfg.cwd = resolve(here, overrides.cwd);
  return cfg;
}

function routeModel(
  route: RouteConfig,
  providers: ProviderConfig[],
  tier: ModelTier,
): string {
  if (route.model) return route.model;
  const p = providers.find((x) => x.name === route.provider);
  return p?.models[tier] ?? "unknown";
}

/**
 * 把当前配置切到指定档位对应的目标 {provider, model}。
 *
 * 这是跨供应商调度的关键：档位不是「当前 provider 下的模型名」，
 * 而是「provider + model」的绑定。切档可能连带换供应商。
 *
 * 降级策略：目标 provider 的协议若未接入，按 fallbackAllowed 决定
 * 是静默回落 default 档还是报错。默认允许回落 —— 整个设计的地基是
 * 「default 永远能调通」，所以它必须承担兜底职责。
 */
export function applyTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  const route = cfg.routes[tier];
  if (!route) return { ok: false, error: `未知档位 ${tier}` };

  const target = cfg.providers.find((p) => p.name === route.provider);
  if (!target) return { ok: false, error: `档位 ${tier} 指向不存在的 provider "${route.provider}"` };

  if (!isImplemented(target.type)) {
    if (!route.fallbackAllowed) {
      return {
        ok: false,
        error:
          `档位 ${tier} → ${target.name}（${target.type} 协议未接入），` +
          `且该路由设置了 fallback_allowed: false。`,
      };
    }
    if (tier === "default") {
      return {
        ok: false,
        error: `default 档位指向未接入的 ${target.name}，无更低档可降。`,
      };
    }
    // 降级到 default
    const defRoute = cfg.routes["default"];
    const defProv = cfg.providers.find((p) => p.name === defRoute.provider);
    if (!defProv || !isImplemented(defProv.type)) {
      return {
        ok: false,
        error: `档位 ${tier} 不可用，且 default 档位也不可用，无法降级。`,
      };
    }
    cfg.modelTier = "default";
    cfg.providerName = defProv.name;
    cfg.providerType = defProv.type;
    cfg.apiKey = defProv.apiKey;
    cfg.baseUrl = defProv.baseUrl;
    cfg.model = routeModel(defRoute, cfg.providers, "default");
    cfg.maxTokens = defProv.maxTokens ?? cfg.globalDefaults.maxTokens;
    cfg.temperature = defProv.temperature ?? cfg.globalDefaults.temperature;
    cfg.contextWindow = defProv.contextWindow ?? cfg.globalDefaults.contextWindow;
    cfg.configuredContextWindow = cfg.contextWindow;
    return {
      ok: true,
      degraded: true,
      note: `档位 ${tier} 指向 ${target.name}（${target.type} 未接入），已降级到 default / ${defProv.name}`,
    };
  }

  cfg.modelTier = tier;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = routeModel(route, cfg.providers, tier);
  cfg.maxTokens = target.maxTokens ?? cfg.globalDefaults.maxTokens;
  cfg.temperature = target.temperature ?? cfg.globalDefaults.temperature;
  cfg.contextWindow = target.contextWindow ?? cfg.globalDefaults.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  return { ok: true, degraded: false };
}

/** 某档位当前是否可用（目标 provider 已接入）。分类器据此避免推荐不可用的档。 */
export function tierAvailable(cfg: Config, tier: ModelTier): boolean {
  const route = cfg.routes[tier];
  if (!route) return false;
  const p = cfg.providers.find((x) => x.name === route.provider);
  return p !== undefined && isImplemented(p.type);
}

/** 某档位的路由描述，供 /tier 展示。 */
export function describeRoute(cfg: Config, tier: ModelTier): string {
  const route = cfg.routes[tier];
  if (!route) return "未配置";
  const p = cfg.providers.find((x) => x.name === route.provider);
  const model = routeModel(route, cfg.providers, tier);
  const okTag = p && isImplemented(p.type) ? "" : " (未接入)";
  return `${route.provider} / ${model}${okTag}`;
}

/**
 * 切换 provider。会重算 model / baseUrl / apiKey 及该 provider 覆盖的运行时参数。
 *
 * 档位保持不变，但 model 改为「该 provider 在当前档位下的模型」。
 * 注意这与 applyTier 不同：applyTier 是「档位决定 provider」，
 * 这里是「provider 决定模型」—— 手动指定供应商时应当听用户的，不走路由表。
 */
export function switchProvider(cfg: Config, name: string): { ok: true } | { ok: false; error: string } {
  const target = cfg.providers.find((p) => p.name === name);
  if (!target) {
    const names = cfg.providers.map((p) => p.name).join(", ");
    return { ok: false, error: `未找到 provider "${name}"。可用：${names || "（无）"}` };
  }

  // 先校验再赋值：未接入的协议必须原样留在当前 provider 上，不能先切过去再报错
  if (!isImplemented(target.type)) {
    return {
      ok: false,
      error:
        `provider "${target.name}" 声明为 ${target.type} 协议，但请求层尚未接入。` +
        `已实现的协议：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。` +
        `切换已取消，仍在使用 ${cfg.providerName}。`,
    };
  }

  const g = cfg.globalDefaults;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = target.models[cfg.modelTier];
  // provider 没覆盖的项回落到全局默认，而不是沿用上一个 provider 的值
  cfg.maxTokens = target.maxTokens ?? g.maxTokens;
  cfg.temperature = target.temperature ?? g.temperature;
  cfg.contextWindow = target.contextWindow ?? g.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;

  return { ok: true };
}

/**
 * 切换模型档位。走路由表，可能连带换供应商。
 * 返回降级信息供调用方提示。
 */
export function switchTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  return applyTier(cfg, tier);
}

/** 脱敏展示 key，只保留头尾。 */
export function maskKey(k: string): string {
  if (!k) return "<未设置>";
  if (k.length <= 12) return "*".repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
