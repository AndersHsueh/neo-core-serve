/**
 * 无头端口契约（K02）。
 *
 * LifecyclePort 是会话/用户边界上的注入面，默认 no-op：返回空上下文、不阻断。
 * 本文件不包含 hook runner、语义载荷解析、进程/PGID 收口或 ACP/`-p` 入口。
 * 不得把本端口的存在写成 core 已具备 hooks（core 当前无 `src/core/hooks/`）。
 */
export type SessionStartSource = "new" | "resume" | "clear";

export const SESSION_START_SOURCES: readonly SessionStartSource[] = ["new", "resume", "clear"];

export type CompactTrigger = "manual" | "auto";

/** 一次生命周期端口调用的结果。 */
export interface LifecycleHookResult {
  /** 是否要求阻断（默认 no-op 恒为 false）。 */
  blocked: boolean;
  /** 阻断原因 / 诊断文本。默认 no-op 为空串。 */
  reason: string;
  /** 附加上下文。默认 no-op 为空串，不写入历史。 */
  context: string;
  /** Stop 是否请求续跑。默认 no-op 为 false。 */
  continue: boolean;
}

export const EMPTY_LIFECYCLE_RESULT: LifecycleHookResult = {
  blocked: false,
  reason: "",
  context: "",
  continue: false,
};

/**
 * 会话边界生命周期端口。
 *
 * 默认实现不执行任何 hook、不改历史、不阻断、不续跑。
 * 真实 hook 执行不在本波（后续 K26/K27，且须先有 K17a）。
 */
export interface LifecyclePort {
  runSessionStart(source: SessionStartSource): Promise<LifecycleHookResult>;
  ensureUserPromptSubmit(prompt: string): Promise<LifecycleHookResult>;
  runStopHooks(alreadyContinued?: boolean): Promise<LifecycleHookResult>;
  runPreCompact(trigger: CompactTrigger): Promise<LifecycleHookResult>;
}

function empty(): Promise<LifecycleHookResult> {
  return Promise.resolve({ ...EMPTY_LIFECYCLE_RESULT });
}

/** 默认 no-op 端口。所有方法返回空结果且不抛错（来源合法性由 Agent 方法校验）。 */
export const NOOP_LIFECYCLE_PORT: LifecyclePort = {
  runSessionStart: (_source: SessionStartSource) => empty(),
  ensureUserPromptSubmit: (_prompt: string) => empty(),
  runStopHooks: (_alreadyContinued?: boolean) => empty(),
  runPreCompact: (_trigger: CompactTrigger) => empty(),
};

export function isSessionStartSource(v: unknown): v is SessionStartSource {
  return SESSION_START_SOURCES.includes(v as SessionStartSource);
}
