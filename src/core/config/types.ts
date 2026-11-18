/**
 * 配置类型与档位常量（从 config.ts 抽出，避免单文件超 1000 行）。
 */
import type { EnvConfig } from "../env/types.ts";
import type { ShellConfig } from "../shell.ts";
import type { WindowSource } from "../contextWindow.ts";
import type { InboundPolicy, MailboxConfig } from "../mailbox/types.ts";
/**
 * 已实现的 provider 协议类型。
 *
 * anthropic 尚未接入请求层。配置里可以先写上（占位、规划用），
 * 但一旦真被选中就会明确报错 —— 不能静默按 openai 协议发请求，
 * 两者鉴权头与响应结构都不兼容。
 */
export type ProviderType = "openai" | "anthropic";

/** 真正实现了请求层适配的类型。其余为「已声明但未接入」。 */
export const IMPLEMENTED_PROVIDER_TYPES: readonly ProviderType[] = ["openai"];

export function isImplemented(type: ProviderType): boolean {
  return IMPLEMENTED_PROVIDER_TYPES.includes(type);
}

/** 模型档位。取值决定用 provider 下的哪个 *_model_name 字段。 */
export type ModelTier = "default" | "deep_reasoning" | "balanced" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = [
  "default",
  "deep_reasoning",
  "balanced",
  "fast",
];

export const TIER_FIELD: Record<ModelTier, string> = {
  default: "default_model_name",
  deep_reasoning: "deep_reasoning_model_name",
  balanced: "balanced_model_name",
  fast: "fast_model_name",
};

export function isModelTier(v: string): v is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(v);
}

/**
 * 用户输入 → 规范档位名（v0.4.2）。内部/配置/路由仍用 `deep_reasoning`，
 * 这里只服务 `/tier`、`--tier`、task 等人类输入入口；大小写/空白不敏感。
 *
 * 为什么不在内部改名：`deep_reasoning_model_name` / `model_routes.deep_reasoning` /
 * 会话/测试/文档已按规范名落盘，改名需要 schema 迁移且会破坏旧 settings。
 */
export function normalizeTierName(input: string): ModelTier | null {
  const v = input.trim().toLowerCase();
  switch (v) {
    case "default":
    case "auto":
    case "dflt":
      return "default";
    case "deep_reasoning":
    case "deep-reasoning":
    case "deep":
    case "d":
    case "reasoning":
      return "deep_reasoning";
    case "balanced":
    case "balance":
    case "bal":
    case "b":
      return "balanced";
    case "fast":
    case "f":
      return "fast";
    default:
      return null;
  }
}

/** 展示用短名：内部 `deep_reasoning` → UI/命令里显示 `deep`；其余同名。 */
export function tierDisplayName(tier: ModelTier | string): string {
  return tier === "deep_reasoning" ? "deep" : tier;
}

/** 展示名 + 规范名（需区分时）：`deep (deep_reasoning)`；fast/balanced/default 只显示短名。 */
export function tierChoiceLabel(tier: ModelTier | string): string {
  const short = tierDisplayName(tier);
  return short === tier ? short : `${short} (${tier})`;
}


/**
 * 输出上限（`max_output_tokens`）主动探测的配置。
 * 默认关闭：探测会花请求配额，必须用户显式开启。
 */
export interface OutputProbeSettings {
  enabled: boolean;
  /** 一次探测最多发几个请求（1–8）。 */
  maxAttempts: number;
  /** 第一个候选预算；之后每档翻倍。 */
  start: number;
  /** 候选上限，防止为探极端值多花请求。 */
  cap: number;
}

export const DEFAULT_OUTPUT_PROBE: OutputProbeSettings = {
  enabled: false,
  maxAttempts: 3,
  start: 8_192,
  cap: 131_072,
};

/** 备用链单项：明确的 provider + model。与档位 fallback_allowed 不是一回事。 */
export interface ModelTarget {
  provider: string;
  model: string;
}

/** 备用项上限：有界约束，不是运行时自动截断。 */
export const MAX_MODEL_FALLBACKS = 8;

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  /** 四个档位各自对应的模型 ID。 */
  models: Record<ModelTier, string>;
  /** 该 provider 的运行时参数；缺省时回落到全局值。 */
  maxTokens: number | null;
  temperature: number | null;
  contextWindow: number | null;
  /**
   * 输出上限的主动探测配置（K03b-mpa）。undefined = 未配置 = 关闭。
   */
  outputProbe?: OutputProbeSettings;
  /**
   * 手写能力声明。true/false 是用户判断，探测只补空缺，绝不覆盖手写值（含 false）。
   * undefined = 未声明。
   */
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /** 手写的模型单次输出上限。与请求预算 maxTokens 无关。未填 = null。 */
  maxOutputTokens?: number | null;
}

/** 档位 → 目标 {provider, model} 的绑定。跨供应商调度靠这个。 */
export interface RouteConfig {
  provider: string;
  model: string | null;
  /** 目标 provider 的协议未接入时，是否允许静默降级。 */
  fallbackAllowed: boolean;
}

/**
 * LLM 请求重试与超时策略（P0-1）。
 *
 * 只重试「尚未向用户输出任何增量」的失败；时间单位毫秒。
 * settings.json 的 `retry` 段可覆盖，缺省值见 DEFAULT_RETRY_CONFIG。
 */
export interface RetryConfig {
  /** 总尝试次数（含首次）。1 = 不重试。 */
  maxAttempts: number;
  /** 指数退避基数（毫秒）。 */
  baseDelayMs: number;
  /** 连接 + 首字节超时（毫秒）。 */
  connectTimeoutMs: number;
  /** 流式空闲超时（毫秒），每收到一个 chunk 重置。 */
  streamIdleTimeoutMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  connectTimeoutMs: 30_000,
  streamIdleTimeoutMs: 120_000,
};

export interface Config {
  /** 当前选中的 provider（已解析为具体值）。 */
  providerName: string;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  /** 当前档位。 */
  modelTier: ModelTier;
  /** 由档位解析出的实际模型 ID。 */
  model: string;
  /** 全部 provider，供 /provider 展示与切换。 */
  providers: ProviderConfig[];
  /**
   * 档位路由表：tier → {provider, model}。
   * 与 provider 内的 models 正交 —— 档位可以指向任意 provider 的任意模型。
   */
  routes: Record<ModelTier, RouteConfig>;
  /** 分类器自己用的模型与 provider（固定外部指定，避免循环依赖）。 */
  classifierModel: string;
  classifierProvider: string;
  /** 本次启动是否使用了旧版扁平配置。 */
  legacyFormat: boolean;

  maxTokens: number;
  temperature: number;
  contextWindow: number;
  /** settings/provider/globalDefaults 当时的原始窗口值（不被探测结果覆盖，B2 用）。 */
  configuredContextWindow?: number;
  /**
   * contextWindow 的来源（v0.4.1 A2）：
   *  - config = settings 值；models_api/overflow_error = 自动探测；known = 兜底表；
   *    default = 未知模型的通用默认值（猜的，不是事实）。
   *  只用于 /context 展示与排障，不参与序列化。
   *  类型直接引用 `contextWindow.ts` 的 `WindowSource`，避免两处各写一份枚举。
   */
  contextWindowSource?: WindowSource;
  /** 顶层全局默认。provider 未覆盖某项时用它，切换 provider 时据此回滚。 */
  globalDefaults: { maxTokens: number; temperature: number; contextWindow: number };
  compactThreshold: number;
  maxToolIterations: number;
  toolOutputLimit: number;
  /**
   * LLM 重试/超时策略。所有字段都有默认值；测试可直接注入缩小的超时。
   * 缺省时 llm.ts 回落到 DEFAULT_RETRY_CONFIG。
   */
  retry?: RetryConfig;
  theme: string;
  showReasoning: boolean;
  /**
   * 工具调用详情显示。false（默认）= 交互模式下紧凑单行（. / .. / ... 动画，下一个调用覆盖）；
   * true = 旧版 header + 缩进结果块。
   */
  toolcallInfoDetails: boolean;
  /** 粘贴增强配置（PRD docs/paste-enhancement-prd[done].md §5.7）。 */
  paste: PasteConfig;
  /** 跨会话消息配置（docs/cross-session-messaging-prd[done].md v1.2 §4.6 / §4.10）。 */
  mailbox: MailboxConfig;
  /** 入站策略；"auto" = 按接收方权限档自动判定。 */
  crossSessionInbound: InboundPolicy | "auto";
  /** 透传给服务端的思考开关；不设则不下发该字段，由服务端自行决定。 */
  thinking?: { type: "enabled" | "disabled" };
  cwd: string;
  /** 主模型请求失败后的有序备用链。缺省 / [] = 禁用。本批只解析，不执行切换。 */
  modelFallback: ModelTarget[];
  settingsPath: string | null;
  /**
   * 全局技能库路径。默认 ~/.neo/skills。
   * 独立字段而非在 skills.ts 里硬编码 homedir()：测试必须能注入沙箱路径，
   * 否则会读写用户真实的技能库。
   */
  skillsStore: string;
  /** 额外技能目录（v0.4.1 B3）：按顺序只读扫描，用于外部技能包/团队共享目录。 */
  skillsExtraPaths?: string[];
  /**
   * 记忆系统配置。PRD docs/memory-prd.md §6.3 + §A 配套。
   * 实现层用 `cfg.memory.userLevelDir ?? homedir()/.neo/memorys`（§7.3）：
   * 测试场景下 cfg.memory 总有值；真启动路径下 loadConfig 必填默认。
   */
  memory: MemoryConfig;
  /** 跨平台 shell 覆盖（v0.4.0 平台适配层；不填=自动探测）。 */
  shell?: ShellConfig;
  /** 环境探测/注入配置（v0.4.0；不填=默认开启、TTL 12h、注入+写 wiki 页）。 */
  env?: EnvConfig;
}

/**
 * 记忆系统配置（v0.2 记忆激活；规格 docs/001-memory-system-design[done].md §7.9）。
 *
 * v0.1.12 清理：随 deprecated 实现删除了一批从未被消费的字段
 * （cwdRelativeMode / worktreeIsolation / maxProfileChars / profileTokensLimit /
 * ingest / autoWriteIndex / noProfileInOneShot / platform / piiFilter / ingestJournal）。
 * 旧 settings.json 里的这些键会被静默忽略，不报错。
 */
export interface MemoryConfig {
  /** 总开关；false 时记忆读写全部 no-op。 */
  enabled: boolean;
  /**
   * 旧用户级目录（~/.neo/memorys）。只服务于 `/memory migrate` 与旧 profile.md 兼容读取；
   * v0.1.11 起记忆不再写这里。NEO_MEMORY_DIR 可覆盖。
   */
  userLevelDir: string;
  /** 用户级 wiki 根目录（NEO_USER_WIKI_DIR 可覆盖）。 */
  userWikiDir: string;
  /** 运行 journal 目录（NEO_MEMORY_JOURNAL_DIR 可覆盖）。 */
  journalDir: string;
  /** 每轮开始前的自动召回（R1）。 */
  autoRecall: {
    enabled: boolean;
    maxTokens: number;
    projectPages: number;
    userPages: number;
  };
  /** 轮末自动捕获（T1/T2）。 */
  autoCapture: {
    enabled: boolean;
    mode: "off" | "boundary" | "every_turn";
    modelTier: string;
    maxOpsPerTurn: number;
    maxPagesPerSession: number;
    minConfidence: number;
    minInferredConfidence: number;
    journalRetentionDays: number;
    flushTimeoutMs: number;
  };
  /** 静默模式：不打印「记忆 +N」提示。 */
  quiet: boolean;
  /**
   * 运行时会话的记忆作用域（不落配置文件）。
   * -p 单次模式由组合根置为 "project"：只读写项目级记忆，
   * 避免服务器脚本场景混入操作员个人记忆。
   */
  scopeMode?: "both" | "project";
}

/**
 * 粘贴增强配置（PRD docs/paste-enhancement-prd[done].md §5.7）。
 * settings.json 的 paste.* 段；整块缺省 = 功能开启（不做总开关，chip 语义上线后关闭会造成认知分裂）。
 */
export interface PasteConfig {
  /** 行数阈值。M1 结构性不生效（readline 行缓冲装不下 \n，含换行必折叠），为 M2+ 预留。 */
  foldLines: number;
  /** 单行字符数阈值：≥ 此值折叠为 chip。 */
  foldChars: number;
  /** 图片大小上限（字节），超限拒绝（PRD C6）。默认 8MB。 */
  imageMaxBytes: number;
}
