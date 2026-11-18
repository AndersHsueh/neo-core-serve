/**
 * `@neo/core-compat/compat/v1` 打包入口：只再导出已晋升的纯叶，不复制算法。
 *
 * 归档里的 index.js 由构建器从本文件出发、沿相对导入打包；不要从本入口
 * 再导出 maxTokens 的 learned Map / handler、AnthropicStreamAccumulator、
 * 或 ModelFallbackController。
 */
export {
  knownWindow,
  resolveContextWindow,
  isContextOverflowError,
  parseContextLimitFromError,
} from "../core/contextWindow.ts";
export type { WindowSource, ContextWindowEnv, ResolvedWindow } from "../core/contextWindow.ts";

export {
  isParallelToolCallsRejection,
  isContextLengthErrorText,
  isMaxTokensErrorText,
  isAuthErrorText,
  parseMaxTokensLimit,
  OPAQUE_400_DOWNGRADE_FLOOR,
  shouldDowngradeForOpaque400,
} from "../core/llm/maxTokensClassify.ts";

export {
  TIER_ORDER,
  STANDARD_MIN_WINDOW,
  FULL_MIN_WINDOW,
  DEFAULT_SELECTION_CONFIG,
  isWindowTrusted,
  rank,
  selectPromptTier,
} from "../core/prompt/select.ts";
export type {
  SelectionMode,
  PromptSelectionConfig,
  SelectInput,
  PromptSelection,
} from "../core/prompt/select.ts";

export { countSystemTokens } from "../core/prompt/tokens.ts";
export type { SystemOverhead } from "../core/prompt/tokens.ts";

export { TIER_CORE } from "../core/prompt/tiers.ts";
export type { PromptTier } from "../core/prompt/tiers.ts";

export {
  sanitizeToolId,
  toAnthropicMessages,
  toAnthropicTools,
  buildAnthropicBody,
  mapStopReason,
  mapUsage,
  parseAnthropicMessage,
  isRetryableAnthropicError,
} from "../core/anthropicWireConvert.ts";
export type { AnthropicMessage, AnthropicBodyInput, RawUsage } from "../core/anthropicWireConvert.ts";
export type {
  Role,
  ContentPart,
  ToolCall,
  ThinkingBlock,
  Message,
  ToolSpec,
  Usage,
  StreamResult,
} from "../core/llm/messageTypes.ts";

export { redactFallbackText, attributeFailure } from "../core/modelFallbackAttr.ts";
export type { FallbackFailureCode, FallbackAttribution } from "../core/modelFallbackAttr.ts";
