/**
 * LLM 错误类型。从 llm.ts 抽出，供 maxTokens 等纯函数用 instanceof，
 * 避免与请求层循环依赖。行为与抽出前一致。
 */

export class LLMError extends Error {
  /** 是否值得重试。4xx（408/409/425/429 除外）与「已输出后的中断」置 false。 */
  retryable = true;
  /** 服务端 Retry-After 给出的等待时长（毫秒）。 */
  retryAfterMs?: number;
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** 连接/首字节或流式空闲超时（P0-1）。 */
export class LLMTimeoutError extends LLMError {
  constructor(
    readonly kind: "connect" | "idle",
    timeoutMs: number,
  ) {
    super(kind === "connect" ? `连接/首字节超时（${timeoutMs}ms）` : `流式响应空闲超时（${timeoutMs}ms）`);
    this.name = "LLMTimeoutError";
  }
}
