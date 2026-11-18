/**
 * Agent 私有辅助（从 agent.ts 抽出，行为不变）。
 *
 * 这些函数通过 `this: Agent` 绑定回类上；字段在 Agent 上对同目录模块可见，
 * 运行时语义与抽出前一致。
 */
import type { Agent } from "../agent.ts";
import { contentText, type Message } from "../llm.ts";
import { appendTurnLog } from "../turnDiagnostics.ts";
import type { ToolCtx } from "../tools/index.ts";
import type { TurnStats } from "./types.ts";

/**
 * 连续 capability 调用阈值（2026-10-26）。
 *
 * 取 4 而不是 2/3：正常排查里连续两次 shell 很常见（`ls` 再看 `cat`），
 * 阈值太低会把正常工作流误判成漂移，提示变成噪音、被模型学会忽略。
 * 4 次连续只扩展手段而无事实产出，已经不像在查东西，更像在开通道。
 */
export const CAPABILITY_STREAK_LIMIT = 4;

/**
 * 写一轮诊断日志（v0.4.1 A1）。失败静默：诊断不得影响主流程。
 * 只记元数据，不记 prompt/回答正文。
 */
export function writeTurnLog(this: Agent, stats: TurnStats): void {
  // 没有会话 id = 测试/裸 Agent：不写盘，避免单测污染用户 ~/.neo/logs。
  if (!this.opt.sessionId) return;
  appendTurnLog({
    sessionId: this.opt.sessionId,
    turn: this.turnCounter,
    provider: this.opt.cfg.providerName,
    model: this.opt.cfg.model,
    durationMs: stats.durationMs,
    iterations: stats.iterations,
    toolCalls: stats.toolCalls,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    reasoningTokens: stats.reasoningTokens,
    finishReason: stats.finishReason,
    aborted: stats.aborted,
    hadError: stats.hadError,
    emptyResponse: stats.emptyResponse,
    errorMessage: stats.errorMessage,
    contextWindow: this.opt.cfg.contextWindow,
    contextUsage: stats.contextUsage,
    ...(this.lastCompact
      ? { compaction: { before: this.lastCompact.beforeTokens, after: this.lastCompact.afterTokens } }
      : {}),
  });
}

/**
 * 上下文溢出兜底（A2）：压缩不可用时，把最老的一批 tool 输出替换为占位文本。
 * 只动 tool content，不改角色/配对，消息序列仍然合法。
 */
export function trimOldToolOutputs(this: Agent, keepRecent = 6): void {
  const toolIndices: number[] = [];
  this.messages.forEach((m, i) => {
    if (m.role === "tool") toolIndices.push(i);
  });
  const drop = Math.max(0, toolIndices.length - Math.max(0, keepRecent));
  for (let k = 0; k < drop; k++) {
    const idx = toolIndices[k];
    if (idx === undefined) continue;
    const m = this.messages[idx];
    if (!m) continue;
    const before = contentText(m.content)?.length ?? 0;
    m.content = `[旧工具输出已裁剪以适配上下文（原 ${before} 字符）；如需重看请重新调用工具]`;
  }
}

/**
 * 轮末捕获入口（§7.6.1 T1 / abort）。
 * fire-and-forget：捕获内部有队列与失败降级，绝不允许异常冒泡到主循环。
 */
export function emitMemoryCapture(this: Agent, turnStart: number, kind: "turn" | "aborted"): void {
  const mem = this.opt.memory;
  if (!mem) return;
  this.turnSeq += 1;
  try {
    mem.capture({
      kind,
      messages: this.messages.slice(turnStart),
      turn: this.turnSeq,
      ...(this.lastStats
        ? {
            stats: {
              toolCalls: this.lastStats.toolCalls,
              iterations: this.lastStats.iterations,
              aborted: this.lastStats.aborted,
              finishReason: this.lastStats.finishReason,
            },
          }
        : {}),
    });
  } catch {
    // 捕获失败静默：记忆不是主流程的一部分
  }
}

/**
 * 读目标锚，任何异常都降级为 null。
 *
 * 目标锚是增强项：注入方（组合根 / 子代理 / 测试）抛错不得炸掉整轮。
 * 组合根那侧也包了 try/catch，但调用方必须自己兜底 —— 否则任何注入方
 * 的疏忽都会让主流程崩，而这条约定该由调用点保证。
 */
export function readGoalSafe(this: Agent): string | null {
  try {
    const g = this.opt.readGoal?.() ?? null;
    return g && g.trim() ? g : null;
  } catch {
    return null;
  }
}

/**
 * 构造本轮预算 + 目标提示。
 *
 * 每次请求前注入、请求后移除，模型因此始终知道「这是第几次、还剩几次」。
 * 剩余 ≤ 5 时额外给出明确次数并要求收敛 —— 只写「即将耗尽」模型无法判断
 * 还能做几件事，往往会继续探索，最后被硬截断，用户拿到半截答案。
 *
 * 2026-10-26 追加目标锚：只报消耗量不够。跑偏的会话每步都有进展
 * （DNS 解析成功、拿到 IP 都是真的），心跳满格方向全错。把原始目标
 * 每轮摆在这里，是给模型一个「离目标多远」的信号，而不只是「还剩几步」。
 * 目标由用户/宿主写入，模型只读 —— 提示里明确写出这一点，防止它自行重述。
 */
export function budgetMessage(this: Agent, attempt: number, max: number): Message {
  const remaining = Math.max(0, max - attempt);
  let text =
    `本轮工具调用：第 ${attempt} 次 / 上限 ${max}（已用 ${attempt - 1}，剩余 ${remaining}）。`;
  const goal = this.readGoalSafe();
  if (goal) {
    text +=
      `\n原始目标（用户设定，你不可修改）：${goal}` +
      `\n每次调用工具前自问：这一步是在产出关于目标的事实，还是只在扩展手段？` +
      `若连续多次只扩展手段而无新事实，停下来回到目标本身。`;
    // 手段/目标分层计数（2026-10-26）：把偏离做成可见数字。
    // 只在设了目标时显示 —— 没有目标就没有「离目标多远」可言。
    if (this.capabilityStreak > 0) {
      text += `\n距上次产出事实，已连续 ${this.capabilityStreak} 次只扩展手段（shell/发消息/派子代理/加载技能）。`;
      if (this.capabilityStreak >= CAPABILITY_STREAK_LIMIT) {
        text +=
          `\n**已超过 ${CAPABILITY_STREAK_LIMIT} 次阈值**：你正在把手段当成目标。` +
          `立刻停止扩展能力，回到原始目标：现在手上已有的事实够回答吗？` +
          `够就直接答；不够就说明缺什么，不要再去开新通道。`;
      }
    }
  }
  if (remaining <= 5) {
    text +=
      `\n预算即将耗尽，仅剩 ${remaining} 次工具调用机会。` +
      `请停止继续探索，立即基于已有信息给出最终答案；` +
      `信息不足就在答案中明确说明缺什么，不要再用工具。`;
  }
  return { role: "system", content: text };
}

/** 移除临时消息（预算提示 / 重试提示）。按引用比对，避免误删历史里内容相同的消息。 */
export function dropTransientMessage(this: Agent, msg: Message): void {
  const i = this.messages.lastIndexOf(msg);
  if (i !== -1) this.messages.splice(i, 1);
}

export function makeCtx(this: Agent, signal: AbortSignal): ToolCtx {
  const mode = this.mode;
  const ui = this.opt.console;
  return {
    cfg: this.opt.cfg,
    signal,
    host: this,
    checkpoint: this.opt.checkpoint,
    approve: async (tool, detail) => {
      if (mode === "auto-all") return true;
      if (mode === "auto-edit" && tool !== "shell") return true;
      if (mode === "plan") {
        ui.warn(`plan 模式禁止 ${tool}：${detail}`);
        return false;
      }
      return ui.confirm(`${tool} — ${detail}`);
    },
    onNotice: (m) => ui.info(m),
    onProgress: (m) => ui.updateSpinner(m),
    askUser: this.opt.askUser,
    cancelAskUser: this.opt.cancelAskUser,
    readOnly: this.opt.mode === "plan",
  };
}
