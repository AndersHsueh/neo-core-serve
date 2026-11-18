/**
 * 输出上限（max_tokens）分类与夹紧判定：纯函数，不持有 learned Map / 监听器。
 *
 * 上下文超限判定复用已晋升的 isContextOverflowError，不在本文件复制第二套正则。
 */
import { isContextOverflowError } from "../contextWindow.ts";
import { isLlmErrorLike } from "./types.ts";

/**
 * 服务端是否在抱怨 parallel_tool_calls 这个字段（瘦网关常见：400 unknown field）。
 *
 * 只在 4xx 且错误文本里同时出现字段名与「不认识/不支持」语义时才认，
 * 避免把普通的参数错误误判成降级信号。
 */
export function isParallelToolCallsRejection(err: unknown): boolean {
  if (!isLlmErrorLike(err)) return false;
  const status = err.status;
  if (status === undefined || status < 400 || status >= 500) return false;
  const text = `${err.message}\n${err.body ?? ""}`.toLowerCase();
  if (!text.includes("parallel_tool_calls")) return false;
  return /(unknown|unsupported|not supported|unrecognized|invalid|not allowed|unexpected|不支持|未知)/.test(text);
}

/**
 * 上下文窗口类错误文案（context length / prompt too long）。
 * 由 agent 的 overflow 恢复处理，max_tokens 的学习与降级都不碰。
 * 正则只来自 isContextOverflowError：传入拼好的文案，并用 400 通过其状态门。
 */
export function isContextLengthErrorText(text: string): boolean {
  return isContextOverflowError({ status: 400, message: text });
}

/** 文案是否提及 max tokens（语义层面，无论能否解析出具体数字）。 */
export function isMaxTokensErrorText(text: string): boolean {
  return /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?|最大.{0,4}token/i.test(text);
}

/** 鉴权类错误文案（401/403，及少数网关用 400 表达的 key 错误）。 */
export function isAuthErrorText(text: string): boolean {
  return /unauthorized|forbidden|authentication|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key|missing[\s_-]*key/i.test(
    text,
  );
}

/**
 * 服务端因 max_tokens 超过**该模型**的上限而拒绝时，从错误文案里取出上限。
 *
 * 只在 400/422 且文案同时出现 max tokens 语义与「>/超过/exceed」时才认，并且要求
 * 解析出的上限小于本次发送的值（否则夹紧没有意义，不能死循环）。
 */
export function parseMaxTokensLimit(err: unknown, sent: number): number | null {
  if (!isLlmErrorLike(err)) return null;
  if (err.status !== 400 && err.status !== 422) return null;
  const text = `${err.message}\n${err.body ?? ""}`;
  // 上下文窗口类错误不是这里的事（由 agent 的 overflow 恢复处理）。
  if (isContextLengthErrorText(text)) return null;
  // 形态 1（MiniMax）：max tokens > 196608
  // 形态 2（Anthropic 官方）：max_tokens: 100000 > 64000, which is the maximum allowed …
  // 形态 3（OpenAI 风格）：supports at most 4096 completion tokens / maximum is 4096
  const patterns = [
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*(?:>|greater than|exceeds?|more than|above)\s*([\d,_]+)/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*[:=]?\s*[\d,_]+\s*>\s*([\d,_]+)/i,
    /(?:at most|up to|no more than|limited to|maximum (?:is|of|allowed)|不超过|上限为?)\s*([\d,_]+)\s*(?:completion |output )?tokens?/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?[^\n]{0,60}?(?:is|of|:|=|limit(?:ed)?(?: to)?|at most|up to|不超过|上限为?)\s*([\d,_]+)/i,
  ];
  if (!isMaxTokensErrorText(text)) return null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number((m[1] ?? "").replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n >= 256 && n < sent) return Math.floor(n);
  }
  return null;
}

/**
 * 不透明 400 的安全降级地板。
 *
 * 取 8192 = 既有默认 max_tokens：本项目对「保守但可用的输出预算」
 * 的既有默认，不引入第三个魔数。刻意不用 contextWindow 的比例。
 */
export const OPAQUE_400_DOWNGRADE_FLOOR = 8192;

/**
 * 不透明 400 的安全降级判定。
 *
 * 触发条件（全部满足才降级）：
 *  1. status === 400（401/403/404/5xx 各走各的路径，不掺和）；
 *  2. parseMaxTokensLimit 返回 null（文案解析不出上限 —— 能解析的走学习夹紧）；
 *  3. 不是上下文超长文案（那是 agent 的 overflow 恢复管的）；
 *  4. 不是鉴权类文案（少数网关用 400 表达 key 错误，降级重发没有意义）；
 *  5. 当前生效值 > OPAQUE_400_DOWNGRADE_FLOOR（只降不升：≤8192 时降级没有意义）。
 *
 * 作用域由调用方决定：**仅本次请求内降级一次，不记忆**。
 */
export function shouldDowngradeForOpaque400(err: unknown, sent: number): boolean {
  if (!isLlmErrorLike(err)) return false;
  if (err.status !== 400) return false;
  // parallel_tool_calls 被拒是另一条降级路径，不能被这里抢走。
  if (isParallelToolCallsRejection(err)) return false;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isContextLengthErrorText(text)) return false;
  if (isAuthErrorText(text)) return false;
  if (parseMaxTokensLimit(err, sent) !== null) return false;
  return sent > OPAQUE_400_DOWNGRADE_FLOOR;
}
