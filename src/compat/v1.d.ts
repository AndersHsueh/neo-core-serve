/**
 * `@neo/core-compat/compat/v1` 的公开类型契约（K01 离线兼容归档）。
 *
 * 这里只有声明，没有运行时代码：归档里的 `index.js` 由 `bun build` 从
 * `src/core/contextWindow.ts` 直接产出（唯一实现，不复制算法），本文件只负责
 * 让旧侧（neo-cli）在 TS 里拿到稳定、可检查的类型。
 *
 * 边界：
 *  - 只声明 4 个函数 + 2 个类型；不引入 core 的 shell/config 声明树；
 *  - `ContextWindowEnv` 是结构类型：core 的 `ModelContextInfo` 直接可传，
 *    多出的字段（updatedAt/evidence/observedMaxPromptTokens）原样带回（identity）；
 *  - 类型与 `src/core/contextWindow.ts` 必须一致，`tests/unit/compat-pack.test.ts`
 *    用 tsc 做双向可赋值检查，防止两份声明漂移。
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
