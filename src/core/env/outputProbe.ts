/**
 * 模型单次输出上限（`max_output_tokens`）的边界发现。
 *
 * 本片（K05a）落地：阶梯候选、错误分类、有界探测、默认关闭、memo 读写。
 * 写回 settings.json（只补空字段、手写优先）放在 K05b。
 *
 * 铁律：只信精确证据；不透明 400 / 上下文超长 / 鉴权 / 5xx 一律不猜。
 */
import type { Config, OutputProbeSettings } from "../config.ts";
import {
  isAuthErrorText,
  isContextLengthErrorText,
  parseMaxTokensLimit,
  rawChatOnce,
  LLMError,
  type Message,
} from "../llm.ts";
import { writeBackCapabilities } from "./modelCaps.ts";
import { modelKey, readModelContexts, recordModelContext } from "./modelWindows.ts";
import type { ModelContextInfo } from "./types.ts";

export { DEFAULT_OUTPUT_PROBE, resolveOutputProbe } from "../config.ts";
export type { OutputProbeSettings } from "../config.ts";

/** 防空转 memo 的 TTL：7 天内不重复探测（结论不论成败都算「探过」）。 */
export const OUTPUT_PROBE_MEMO_TTL_DAYS = 7;

/** 探测请求的正文：越短越好。 */
export const OUTPUT_PROBE_MESSAGES: Message[] = [{ role: "user", content: "ok" }];

export type ProbeFailureKind = "limit" | "opaque" | "context" | "auth" | "other";

export type ProbeAttempt =
  | { candidate: number; ok: true }
  | { candidate: number; ok: false; kind: ProbeFailureKind; limit?: number; message?: string };

export type ProbeOutcome =
  | { outcome: "found"; limit: number; attempts: ProbeAttempt[] }
  | { outcome: "lower_bound"; atLeast: number; attempts: ProbeAttempt[] }
  | { outcome: "inconclusive"; reason: Exclude<ProbeFailureKind, "limit">; attempts: ProbeAttempt[] };

export interface OutputProbeMemo {
  at: string;
  outcome: ProbeOutcome["outcome"];
  atLeast?: number;
  limit?: number;
  reason?: string;
}

/**
 * 阶梯候选：从 start 起翻倍，最多 maxAttempts 个，且不超过 cap。
 * 不把 cap 本身塞进候选（除非 start 就等于 cap）。
 */
export function probeCandidates(settings: OutputProbeSettings): number[] {
  const limit = Math.max(1, Math.min(8, Math.floor(settings.maxAttempts)));
  const cap = Math.max(256, Math.floor(settings.cap));
  let cur = Math.max(256, Math.floor(settings.start));
  const out: number[] = [];
  while (out.length < limit) {
    if (cur > cap) break;
    out.push(cur);
    const next = cur * 2;
    if (!Number.isFinite(next) || next <= cur || next > cap) break;
    cur = next;
  }
  return out;
}

/**
 * 探测失败 → 归因。顺序：上下文超长 / 鉴权优先排除；能解析出数字才算 limit；
 * 400/422 但解析不出数字 = opaque（不归因）；其余 = other。
 */
export function classifyProbeError(
  err: unknown,
  candidate: number,
): { kind: ProbeFailureKind; limit?: number; message: string } {
  const text =
    err instanceof LLMError
      ? `${err.message}${err.body ? `\n${err.body}` : ""}`
      : ((err as Error)?.message ?? String(err));
  if (isContextLengthErrorText(text)) return { kind: "context", message: text.slice(0, 300) };
  if (isAuthErrorText(text)) return { kind: "auth", message: text.slice(0, 300) };
  const limit = parseMaxTokensLimit(err, candidate);
  if (limit !== null) return { kind: "limit", limit, message: text.slice(0, 300) };
  if (err instanceof LLMError && (err.status === 400 || err.status === 422)) {
    return { kind: "opaque", message: text.slice(0, 300) };
  }
  return { kind: "other", message: text.slice(0, 300) };
}

/**
 * 跑一轮阶梯探测。`request` 由调用方注入（真实场景是 rawChatOnce，测试里是假函数）。
 * 一旦归因出非 limit 的失败就立即停止。
 */
export async function runOutputProbe(opts: {
  settings: OutputProbeSettings;
  request: (candidate: number) => Promise<unknown>;
  classify?: (err: unknown, candidate: number) => { kind: ProbeFailureKind; limit?: number; message?: string };
}): Promise<ProbeOutcome> {
  const classify = opts.classify ?? classifyProbeError;
  const attempts: ProbeAttempt[] = [];
  let lastOk: number | null = null;

  for (const candidate of probeCandidates(opts.settings)) {
    try {
      await opts.request(candidate);
      attempts.push({ candidate, ok: true });
      lastOk = candidate;
    } catch (err) {
      const c = classify(err, candidate);
      if (c.kind === "limit") {
        attempts.push({ candidate, ok: false, kind: "limit", limit: c.limit, message: c.message });
        return { outcome: "found", limit: c.limit!, attempts };
      }
      attempts.push({ candidate, ok: false, kind: c.kind, message: c.message });
      return { outcome: "inconclusive", reason: c.kind as Exclude<ProbeFailureKind, "limit">, attempts };
    }
  }

  return { outcome: "lower_bound", atLeast: lastOk ?? opts.settings.start, attempts };
}

/**
 * 现在该不该跑主动探测。默认关闭；已手写上限或 7 天内探过都不跑。
 */
export function shouldRunOutputProbe(opts: {
  settings: OutputProbeSettings;
  outputLimitDeclared: boolean;
  memo?: OutputProbeMemo;
  now?: Date;
  ttlDays?: number;
}): { run: boolean; reason: "disabled" | "declared" | "recent" | "ok" } {
  if (!opts.settings.enabled) return { run: false, reason: "disabled" };
  if (opts.outputLimitDeclared) return { run: false, reason: "declared" };
  const ttl = (opts.ttlDays ?? OUTPUT_PROBE_MEMO_TTL_DAYS) * 86_400_000;
  const now = (opts.now ?? new Date()).getTime();
  if (opts.memo) {
    const at = Date.parse(opts.memo.at);
    if (Number.isFinite(at) && now - at < ttl) return { run: false, reason: "recent" };
  }
  return { run: true, reason: "ok" };
}

/** 读该 provider|model 的探测 memo（env 事实里没有 = undefined）。 */
export function readOutputProbeMemo(cfg: Config): OutputProbeMemo | undefined {
  return readModelContexts(cfg)[modelKey(cfg.providerName, cfg.model)]?.outputProbe;
}

/**
 * 落 env 事实：保留既有上下文窗口/能力标记，只更新输出上限与探测 memo。
 * 既有 maxOutputTokens 不覆盖。本函数不写 settings.json。
 */
export function recordOutputLimitFact(
  cfg: Config,
  patch: {
    /** 窗口来源保持兼容 ContextWindowEnv；探测出处写在 evidence / memo。 */
    source?: ModelContextInfo["source"];
    value: number | null;
    evidence: string;
    memo?: OutputProbeMemo;
  },
): void {
  try {
    const existing = readModelContexts(cfg)[modelKey(cfg.providerName, cfg.model)];
    recordModelContext(cfg, {
      contextWindow: existing?.contextWindow ?? null,
      source: existing?.source ?? patch.source ?? "config",
      maxOutputTokens: existing?.maxOutputTokens ?? patch.value,
      vision: existing?.vision,
      tools: existing?.tools,
      reasoning: existing?.reasoning,
      evidence: patch.evidence.slice(0, 300),
      ...(patch.memo ? { outputProbe: patch.memo } : {}),
    });
  } catch {
    /* env 事实是增强项，写不进去不影响会话 */
  }
}

/** 一句话结论（落 env evidence / 启动日志用）。 */
export function describeProbeOutcome(outcome: ProbeOutcome): string {
  if (outcome.outcome === "found") {
    const tried = outcome.attempts.map((a) => a.candidate.toLocaleString()).join(" → ");
    return `行为探测：上限 ${outcome.limit.toLocaleString()}（候选 ${tried}，400/422 明确给出上限）`;
  }
  if (outcome.outcome === "lower_bound") {
    return `行为探测：已验证网关接受 ${outcome.atLeast.toLocaleString()}，未探到上界（未写配置）`;
  }
  return `行为探测：无法确定上限（${outcome.reason}），未写配置`;
}

/**
 * 把探测结论落地：只有 `found` 才写 settings（且只写空字段），三种结论都记 env memo。
 */
export function applyProbeOutcome(
  cfg: Config,
  outcome: ProbeOutcome,
  opts: { now?: Date } = {},
): { written: string[]; memo: OutputProbeMemo } {
  const memo: OutputProbeMemo = {
    at: (opts.now ?? new Date()).toISOString(),
    outcome: outcome.outcome,
  };

  if (outcome.outcome === "found") {
    memo.limit = outcome.limit;
    const r = writeBackCapabilities(cfg, { maxOutputTokens: outcome.limit });
    recordOutputLimitFact(cfg, {
      value: outcome.limit,
      evidence: describeProbeOutcome(outcome),
      memo,
    });
    return { written: r.written, memo };
  }

  if (outcome.outcome === "lower_bound") memo.atLeast = outcome.atLeast;
  else memo.reason = outcome.reason;

  recordOutputLimitFact(cfg, {
    value: null,
    evidence: describeProbeOutcome(outcome),
    memo,
  });
  return { written: [], memo };
}

/**
 * A 路径：把「从报错里学到的精确上限」入账。
 * 只在 `max_output_tokens` 为空时写 settings；env 事实里保留证据文案。
 */
export function persistLearnedOutputLimit(
  cfg: Config,
  limit: number,
  evidence: string,
): { written: string[] } {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n <= 0) return { written: [] };
  const r = writeBackCapabilities(cfg, { maxOutputTokens: n });
  recordOutputLimitFact(cfg, {
    value: n,
    evidence: `报错学到上限 ${n.toLocaleString()}：${evidence}`,
  });
  return { written: r.written };
}

/**
 * 真实探测入口：用 rawChatOnce 发阶梯请求，再把结论落地。
 * 调用方负责前置判定（shouldRunOutputProbe）与展示。本片测试主要走注入 request。
 */
export async function probeOutputLimitForConfig(
  cfg: Config,
  settings: OutputProbeSettings,
): Promise<{ outcome: ProbeOutcome; written: string[]; memo: OutputProbeMemo }> {
  const outcome = await runOutputProbe({
    settings,
    request: (candidate) => rawChatOnce(cfg, OUTPUT_PROBE_MESSAGES, candidate),
  });
  const applied = applyProbeOutcome(cfg, outcome);
  return { outcome, ...applied };
}
