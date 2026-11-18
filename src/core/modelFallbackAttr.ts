/**
 * 模型备用链的纯归因函数：脱敏与失败分类。
 *
 * 从 modelFallback.ts 抽出，供 compat 归档打包；不导出 ModelFallbackController，
 * 不依赖 chatStream / Config / 探测写回。
 */
import { LLMError, isLlmErrorLike } from "./llm/types.ts";
import {
  isAuthErrorText,
  isContextLengthErrorText,
  isMaxTokensErrorText,
} from "./llm/maxTokensClassify.ts";

export type FallbackFailureCode =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "model_unavailable"
  | "model_forbidden";

const REASON_MAX = 240;

export function redactFallbackText(text: string, max: number = REASON_MAX): string {
  const cleaned = text
    .replace(/https?:\/\/[^\s"'<>]+/g, "[URL]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(
      /"?(authorization|api[-_]?key|token|secret|password|cookie|credential)"?\s*[:=]\s*"[^"]*"/gi,
      "[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(cleaned);
  return cps.length > max ? `${cps.slice(0, max).join("")}…` : cleaned;
}

export interface FallbackAttribution {
  code: FallbackFailureCode;
  message: string;
}

/**
 * 从响应里保守识别「明确的模型不存在 / 无权限」。
 * 优先用结构化 error.code/type；只有文本同时含 model 语义与 not-found/no-access 语义时才认。
 */
function explicitModelLevel(err: LLMError): "model_unavailable" | "model_forbidden" | null {
  const body = typeof err.body === "string" ? err.body : "";
  let code = "";
  let type = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string };
    };
    code = (parsed.error?.code ?? "").toLowerCase();
    type = (parsed.error?.type ?? "").toLowerCase();
  } catch {
    /* 非 JSON body：只走下面的保守文本判定 */
  }
  const structured = `${code} ${type}`;
  if (/model_not_found|model_not_exists|unknown_model|deployment_not_found/.test(structured)) {
    return "model_unavailable";
  }
  if (/model_permission|model_access_denied|model_forbidden|no_access_to_model/.test(structured)) {
    return "model_forbidden";
  }
  const text = err.message.toLowerCase();
  const modelWord = /model|deployment|模型/.test(text);
  const notFound = /not ?found|does ?not ?exist|unknown|不存在/.test(text);
  const noAccess = /permission|forbidden|denied|not ?allowed|无权限|不允许/.test(text);
  if (err.status === 404 && modelWord && notFound) return "model_unavailable";
  if ((err.status === 401 || err.status === 403) && modelWord && noAccess) {
    return "model_forbidden";
  }
  return null;
}

/**
 * 判定一次候选失败是否值得进入下一个候选。null = 不切换，原错误原样抛出。
 *
 * 判定顺序不可颠倒（架构 §3.4）：abort → 已发增量 → 上下文/参数/鉴权 →
 * 明确模型级 → 网络/超时/429/5xx → 其它一律不切换。
 */
export function attributeFailure(
  err: unknown,
  emitted: boolean,
  signal?: AbortSignal,
): FallbackAttribution | null {
  if (signal?.aborted) return null;
  const e = err as Error | undefined;
  if (e?.name === "AbortError") return null;
  // 任一 reasoning/content/tool 增量已交付：切换会造成重复正文或重复工具调用。
  if (emitted) return null;

  const llm = isLlmErrorLike(err)
    ? err instanceof LLMError
      ? err
      : new LLMError(err.message, err.status, err.body)
    : new LLMError(e?.message ?? String(err));
  const explicit = explicitModelLevel(llm);
  if (explicit) {
    return { code: explicit, message: redactFallbackText(llm.message) };
  }
  // 上下文超长、max_tokens 普通参数问题、无效 API key / 普通鉴权失败都不属于模型网关故障。
  if (
    isContextLengthErrorText(llm.message) ||
    isMaxTokensErrorText(llm.message) ||
    isAuthErrorText(llm.message)
  ) {
    return null;
  }
  if (
    (isLlmErrorLike(err) && err.name === "LLMTimeoutError") ||
    /timeout|timed? ?out|超时/i.test(llm.message)
  ) {
    return { code: "timeout", message: redactFallbackText(llm.message) };
  }
  const status = llm.status;
  if (status === undefined) {
    // 无 HTTP status 的连接 / DNS / socket 错误。
    return { code: "network", message: redactFallbackText(llm.message) };
  }
  if (status === 429) {
    return { code: "rate_limit", message: redactFallbackText(llm.message) };
  }
  if (status >= 500 || status === 408 || status === 409 || status === 425) {
    return { code: "server", message: redactFallbackText(llm.message) };
  }
  // 裸 400/401/403/404 不得仅凭状态码切换。
  return null;
}

