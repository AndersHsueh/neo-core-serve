/**
 * Agent 对 LifecyclePort 的委托（K02）。
 *
 * 这里只做来源校验、子代理短路，以及把调用转到注入的端口（缺省 no-op）。
 * 不搬 hook runner，不解析 hook 语义载荷。
 * K12 在 send() 里于分类器前调用 ensureUserPromptSubmit；默认仍是 no-op。
 */
import type { Agent } from "../agent.ts";
import {
  EMPTY_LIFECYCLE_RESULT,
  NOOP_LIFECYCLE_PORT,
  isSessionStartSource,
  type CompactTrigger,
  type LifecycleHookResult,
  type LifecyclePort,
  type SessionStartSource,
} from "../ports.ts";

export type { CompactTrigger, LifecycleHookResult, LifecyclePort, SessionStartSource };

function portOf(agent: Agent): LifecyclePort {
  return agent.opt.lifecycle ?? NOOP_LIFECYCLE_PORT;
}

const EMPTY: LifecycleHookResult = { ...EMPTY_LIFECYCLE_RESULT };

/** 子代理不触发会话/用户边界事件，避免递归。 */
function skipForSubagent(agent: Agent): boolean {
  return agent.opt.isSubagent === true;
}

/**
 * SessionStart。非法来源立刻抛错，不静默当成 new。
 * 默认 no-op：不阻断、不写历史。构造 Agent 不等于会话开始，宿主须显式调用。
 */
export async function runSessionStart(
  this: Agent,
  source: SessionStartSource,
): Promise<LifecycleHookResult> {
  if (!isSessionStartSource(source)) {
    throw new Error(
      `未知的 SessionStart 来源：${String(source)}（只认 new / resume / clear）`,
    );
  }
  if (skipForSubagent(this)) return { ...EMPTY };
  const r = await portOf(this).runSessionStart(source);
  return r ?? { ...EMPTY };
}

/**
 * 必要时补发 UserPromptSubmit。默认 no-op：放行、空上下文、不写历史。
 * K12：send() 在分类器与写历史之前调用；阻断时零模型请求且历史不动。
 */
export async function ensureUserPromptSubmit(
  this: Agent,
  prompt: string,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return { ...EMPTY };
  const r = await portOf(this).ensureUserPromptSubmit(prompt);
  return r ?? { ...EMPTY };
}

/**
 * Stop。默认 no-op：不续跑。本波不在 send() 终态自动调用（K12）。
 */
export async function runStopHooks(
  this: Agent,
  alreadyContinued = false,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return { ...EMPTY };
  const r = await portOf(this).runStopHooks(alreadyContinued);
  return r ?? { ...EMPTY };
}

/**
 * 压缩被 PreCompact 端口拒绝（K14）。
 *
 * 与「压缩失败」分成两个类型：拒绝后必须原样保留历史与 lastCompact，
 * 并且不得退化为 trimOldToolOutputs 或溢出恢复裁剪。普通失败仍走 ToolError。
 * 这不是 hook runner，不得据此宣称 core 已具备 hooks。
 */
export class CompactBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CompactBlockedError";
  }
}

/**
 * PreCompact。默认 no-op：不拒绝、不改历史。
 * K14：compactNow 在 planCompaction 与摘要请求之前调用。
 */
export async function runPreCompact(
  this: Agent,
  trigger: CompactTrigger,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return { ...EMPTY };
  const r = await portOf(this).runPreCompact(trigger);
  return r ?? { ...EMPTY };
}
