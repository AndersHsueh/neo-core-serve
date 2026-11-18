/**
 * `@neo/core-compat/compat/v1` 的公开类型契约（K01 窗口叶 + K45b 本批纯叶）。
 *
 * 这里只有声明，没有运行时代码：归档里的 `index.js` 由 `bun build` 从
 * `src/compat/v1.ts` 再导出的 core 源直接产出（唯一实现，不复制算法），本文件
 * 只负责让旧侧（neo-cli）在 TS 里拿到稳定、可检查的类型。
 *
 * 边界：
 *  - 只声明已晋升的纯叶（函数/常量/必要 DTO）；不引入 core 的 shell/config 声明树；
 *  - 不声明 learnedMaxTokens / handler / AnthropicStreamAccumulator /
 *    ModelFallbackController 或其它带状态运行时；
 *  - `ContextWindowEnv` 仍是结构类型：core 的 `ModelContextInfo` 直接可传；
 *  - 类型与对应 core 源必须一致，`tests/unit/compat-pack.test.ts` 用 tsc 做双向可赋值检查。
 */

/** 窗口来源。`default` = 未知模型的通用默认值（猜的），必须与 `known` 区分。 */
export type WindowSource = "config" | "models_api" | "overflow_error" | "known" | "default";

/** env 探测事实的最小结构（core 的 `ModelContextInfo` 结构兼容）。 */
export interface ContextWindowEnv {
  /** 探测到的窗口；null = 只知道存在但没拿到值。 */
  contextWindow: number | null;
  source: "models_api" | "overflow_error" | "config" | "known";
  updatedAt: string;
  evidence?: string;
  observedMaxPromptTokens?: number;
}

/** 解析结果。命中 env 事实时 `env` 是调用方传进来的同一个对象（identity）。 */
export interface ResolvedWindow {
  tokens: number;
  source: WindowSource;
  env?: ContextWindowEnv;
}

/** 已知模型兜底表查询；未命中返回 null（不猜）。 */
export declare function knownWindow(model: string): number | null;

/** env 探测值 > 配置值 > 已知兜底 > 通用默认（200k，source=default）。 */
export declare function resolveContextWindow(
  configured: number,
  model: string,
  env?: ContextWindowEnv | null,
): ResolvedWindow;

/** 是否为「上下文超限」类错误（仅 400/413/422 且文案匹配）。 */
export declare function isContextOverflowError(err: unknown): boolean;

/** 从服务端错误文案里解析真实窗口；解析不到返回 null。 */
export declare function parseContextLimitFromError(message: string): number | null;

/** 服务端是否在抱怨 parallel_tool_calls 这个字段。 */
export declare function isParallelToolCallsRejection(err: unknown): boolean;

/** 上下文窗口类错误文案（复用 isContextOverflowError 的正则，状态按 400 过门）。 */
export declare function isContextLengthErrorText(text: string): boolean;

/** 文案是否提及 max tokens（语义层面，无论能否解析出具体数字）。 */
export declare function isMaxTokensErrorText(text: string): boolean;

/** 鉴权类错误文案（401/403，及少数网关用 400 表达的 key 错误）。 */
export declare function isAuthErrorText(text: string): boolean;

/** 从 400/422 max_tokens 超限文案解析上限；解析不到或上限不小于 sent 时返回 null。 */
export declare function parseMaxTokensLimit(err: unknown, sent: number): number | null;

/** 不透明 400 的安全降级地板。 */
export declare const OPAQUE_400_DOWNGRADE_FLOOR: number;

/** 不透明 400 是否应在本次请求内降到地板重发（不记忆）。 */
export declare function shouldDowngradeForOpaque400(err: unknown, sent: number): boolean;

export type PromptTier = "full" | "standard" | "mini";

export declare const TIER_ORDER: readonly PromptTier[];

/** 十进制门槛：服务端声称 128,000 时不能被 131,072 门槛误降。 */
export declare const STANDARD_MIN_WINDOW: number;
export declare const FULL_MIN_WINDOW: number;

export type SelectionMode = "budget-first" | "context-gated";

export interface PromptSelectionConfig {
  selectionMode: SelectionMode;
  systemBudgetRatio: number;
  maxTier: PromptTier;
  unknownWindowBudget: number;
  trustKnownWindow: boolean;
}

export declare const DEFAULT_SELECTION_CONFIG: Readonly<PromptSelectionConfig>;

export interface SelectInput {
  window: number | null | undefined;
  source: WindowSource | undefined;
  overhead: Partial<Record<PromptTier, number>>;
  minTier?: PromptTier;
  config?: Partial<PromptSelectionConfig>;
}

export interface PromptSelection {
  tier: PromptTier;
  fits: boolean;
  reason: string;
  window: number | null;
  windowTrusted: boolean;
  source: WindowSource | undefined;
  budget: number;
  estimatedSystemTokens: number | null;
}

export declare function isWindowTrusted(
  window: number | null | undefined,
  source: WindowSource | undefined,
  trustKnown: boolean,
): boolean;

export declare function rank(t: PromptTier): number;

export declare function selectPromptTier(input: SelectInput): PromptSelection;

export interface SystemOverhead {
  tokens: number;
  tokenizer: "estimate";
}

export declare function countSystemTokens(
  systemTexts: readonly string[],
  tools?: readonly unknown[],
): SystemOverhead;

/** 三档核心提示词正文；改文案先改 core 源。 */
export declare const TIER_CORE: Readonly<Record<PromptTier, string>>;

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  thinking_blocks?: ThinkingBlock[];
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  raw: unknown;
  thinkingBlocks?: ThinkingBlock[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Record<string, unknown>[];
}

export declare function sanitizeToolId(id: string): string;

export declare function toAnthropicMessages(
  messages: Message[],
): { system: string; messages: AnthropicMessage[] };

export declare function toAnthropicTools(tools: ToolSpec[]): Record<string, unknown>[];

export interface AnthropicBodyInput {
  model: string;
  maxTokens: number;
  temperature: number;
  thinking?: { type: "enabled" | "disabled" };
  parallel: boolean;
}

export declare function buildAnthropicBody(
  input: AnthropicBodyInput,
  messages: Message[],
  tools: ToolSpec[],
  stream: boolean,
): Record<string, unknown>;

export declare function mapStopReason(reason: string | null | undefined): string | null;

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

export declare function mapUsage(u: RawUsage): Usage;

export declare function parseAnthropicMessage(json: Record<string, unknown>): StreamResult;

export declare function isRetryableAnthropicError(type: string): boolean;

/** 去掉 URL / 常见密钥形态，并按 Unicode code point 截断。 */
export declare function redactFallbackText(text: string, max?: number): string;

export type FallbackFailureCode =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "model_unavailable"
  | "model_forbidden";

export interface FallbackAttribution {
  code: FallbackFailureCode;
  message: string;
}

/** 判定一次候选失败是否值得进入下一个候选。null = 不切换。 */
export declare function attributeFailure(
  err: unknown,
  emitted: boolean,
  signal?: AbortSignal,
): FallbackAttribution | null;
