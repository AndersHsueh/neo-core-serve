/**
 * OpenAI 兼容 LLM 客户端。
 *
 * 针对本项目实测到的服务端特性做了三点适配：
 *  1. 推理模型会额外返回 reasoning_content，与 content 分开流式下发；
 *     两者都要累积，但只有 content 进对话历史，reasoning 只做展示。
 *  2. tool_calls 以增量形式下发（delta.tool_calls 带 index），需按 index 拼接。
 *  3. SSE 以空行分隔事件，末条为 data: [DONE]。
 */
import { DEFAULT_RETRY_CONFIG, IMPLEMENTED_PROVIDER_TYPES, isImplemented, type Config, type RetryConfig } from "./config.ts";
import { LLMError, LLMTimeoutError } from "./llm/types.ts";
import {
  OPAQUE_400_DOWNGRADE_FLOOR,
  announceLearnedLimit,
  appendMaxTokensHint,
  effectiveMaxTokens,
  learnedMaxTokens,
  maxTokensKey,
  parseMaxTokensLimit,
  shouldDowngradeForOpaque400,
} from "./llm/maxTokens.ts";

export { LLMError, LLMTimeoutError } from "./llm/types.ts";
export {
  OPAQUE_400_DOWNGRADE_FLOOR,
  appendMaxTokensHint,
  effectiveMaxTokens,
  isAuthErrorText,
  isContextLengthErrorText,
  isMaxTokensErrorText,
  isParallelToolCallsRejection,
  learnedMaxTokens,
  maxTokensKey,
  parseMaxTokensLimit,
  resetLearnedMaxTokens,
  resetMaxTokensLimitLearnedHandler,
  setMaxTokensLimitLearnedHandler,
  shouldDowngradeForOpaque400,
} from "./llm/maxTokens.ts";

import type {
  Role,
  ContentPart,
  ToolCall,
  ThinkingBlock,
  Message,
  ToolSpec,
  Usage,
  StreamResult,
} from "./llm/messageTypes.ts";
export type {
  Role,
  ContentPart,
  ToolCall,
  ThinkingBlock,
  Message,
  ToolSpec,
  Usage,
  StreamResult,
};

/**
 * 取消息的纯文本视图（C8 适配收口）。
 * string 原样；数组拼 text parts（image part 不贡献文本）；null → null。
 * 所有「只关心文本」的消费点（compact/预览/子代理/分类器）一律走这里，
 * 不许各自 instanceof —— 收口一处，类型扩展时只改这里。
 */
export function contentText(content: Message["content"]): string | null {
  if (content === null) return null;
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */

/**
 * 构造请求体。
 *
 * `respectLearned=false` 只给输出上限探测用：探测必须发精确候选值，
 * 不能被已学到的上限夹紧。默认 true，普通请求走 effectiveMaxTokens。
 */
/** OpenAI 协议不认 thinking_blocks，发出前剥掉，避免严格网关 400。 */
function stripThinkingBlocks(messages: Message[]): Message[] {
  if (!messages.some((m) => m.thinking_blocks !== undefined)) return messages;
  return messages.map((m) => {
    if (m.thinking_blocks === undefined) return m;
    const { thinking_blocks: _drop, ...rest } = m;
    return rest;
  });
}

function assertImplementedRequestProtocol(cfg: Config): void {
  const typ = cfg.providerType;
  // 缺省按已接入的 OpenAI 路径走，兼容未填 providerType 的测试与旧调用方。
  if (typ === undefined || isImplemented(typ)) return;
  throw new LLMError(
    `协议 ${typ} 尚未接入请求层（已实现：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}）。选中 ${typ} 不会按 OpenAI 协议发送。`,
  );
}

function buildBody(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[],
  stream: boolean,
  respectLearned = true,
) {
  const maxTokens = respectLearned ? effectiveMaxTokens(cfg) : cfg.maxTokens;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: stripThinkingBlocks(messages),
    stream,
    max_tokens: maxTokens,
    temperature: cfg.temperature,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    // 推理模型 + tools 的常见约束：并行调用会产生不确定结果，强制单个。
    body.parallel_tool_calls = false;
  }
  if (cfg.thinking !== undefined) body.thinking = cfg.thinking;
  return body;
}

function authHeaders(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function describeError(res: Response): Promise<LLMError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  let msg = `HTTP ${res.status} ${res.statusText}`;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
  } catch {
    if (body) msg = `${msg} — ${body.slice(0, 300)}`;
  }
  return new LLMError(msg, res.status, body);
}

async function chatOnce(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[] = [],
  respectLearned = true,
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(buildBody(cfg, messages, tools, false, respectLearned)),
  });
  if (!res.ok) throw await describeError(res);

  const json = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
    usage?: Usage;
  };

  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage ?? null,
    raw: json,
  };
}

/**
 * 非流式请求。5xx 仍不在本函数重试（与抽出前一致）；
 * 仅对可解析输出上限夹紧、以及不透明 400 降到地板各重发一次。
 * 降级值不写入 learnedMaxTokens，避免单次观察污染后续请求。
 */
export async function chat(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[] = [],
): Promise<StreamResult> {
  assertImplementedRequestProtocol(cfg);
  let clamped = false;
  let opaqueDowngraded = false;
  let activeCfg = cfg;
  for (;;) {
    try {
      return await chatOnce(activeCfg, messages, tools);
    } catch (e) {
      const limit = clamped ? null : parseMaxTokensLimit(e, effectiveMaxTokens(activeCfg));
      if (limit !== null) {
        clamped = true;
        learnedMaxTokens.set(maxTokensKey(cfg), limit);
        announceLearnedLimit(cfg, limit, effectiveMaxTokens(activeCfg), e);
        continue;
      }
      if (!opaqueDowngraded && shouldDowngradeForOpaque400(e, effectiveMaxTokens(activeCfg))) {
        opaqueDowngraded = true;
        activeCfg = { ...activeCfg, maxTokens: OPAQUE_400_DOWNGRADE_FLOOR };
        continue;
      }
      if (e instanceof LLMError) appendMaxTokensHint(e);
      throw e;
    }
  }
}

/**
 * 输出上限探测用的单次非流式请求：发送精确候选值，不被已学上限夹紧，也不走重试/降级。
 */
export async function rawChatOnce(
  cfg: Config,
  messages: Message[],
  maxTokens: number,
): Promise<StreamResult> {
  return chatOnce({ ...cfg, maxTokens }, messages, [], false);
}

/**
 * `/models` 探测请求（按协议优先级）。K05a 只给出已接入的 OpenAI 端点；
 * Anthropic wire 在 K06a，本函数届时再扩展，不得把未接入协议静默当成 OpenAI。
 */
export function modelsRequests(
  cfg: Config,
): Array<{ proto: Config["providerType"]; url: string; headers: Record<string, string> }> {
  // 未接入的协议不得按 OpenAI 形态去探 /models。
  if (!isImplemented(cfg.providerType) || cfg.providerType !== "openai") return [];
  const headers = authHeaders(cfg);
  return [
    {
      proto: "openai",
      url: `${cfg.baseUrl.replace(/\/$/, "")}/models`,
      headers,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */

/** 除 5xx 外，按 HTTP 语义明确值得重试的状态码。 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429]);
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

function isRetryableStatus(status?: number): boolean {
  return status === undefined || status >= 500 || RETRYABLE_STATUS.has(status);
}

export interface StreamHandlers {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onToolCallDelta?: (index: number, name: string | null, argsDelta: string) => void;
  /** 重试/降级提示（可选）。用于把「正在重试」告诉用户，而不是静默变慢。 */
  onNotice?: (msg: string) => void;
}

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * 发起流式请求并累积结果，失败时按策略重试（P0-1）。
 *
 * 重试边界是本函数最重要的约束：
 *  - 只重试「尚未向调用方输出任何增量」的失败 —— 一旦 reasoning/content/tool 增量
 *    已经回调给 handlers，重试会造成重复输出或重复工具调用，一律不重试；
 *  - 4xx（408/409/425/429 除外）不重试；
 *  - 用户 abort 不重试（agent 按 signal.aborted 走取消路径）。
 */
export async function chatStream(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<StreamResult> {
  const policy = cfg.retry ?? DEFAULT_RETRY_CONFIG;
  assertImplementedRequestProtocol(cfg);
  // 已经取消的 signal 不应再发请求（调用方可能在进入前就按了 ESC）。
  if (signal?.aborted) throw abortError();
  let attempt = 0;
  /** 输出上限夹紧只做一次：夹过还被拒说明是别的问题，交给调用方。 */
  let clamped = false;
  /**
   * 不透明 400 的安全降级：文案解析不出上限时夹到 OPAQUE_400_DOWNGRADE_FLOOR
   * 重发一次。只降不升；降级值通过 activeCfg 覆盖，刻意不写 learnedMaxTokens。
   */
  let opaqueDowngraded = false;
  let activeCfg = cfg;
  for (;;) {
    attempt += 1;
    try {
      return await streamOnce(activeCfg, messages, tools, handlers, signal, policy);
    } catch (e) {
      if (signal?.aborted) throw abortError();
      const err = e instanceof LLMError ? e : new LLMError((e as Error)?.message ?? String(e));
      // max_tokens 超过该模型上限：学到上限、夹紧后同轮重发一次（不占重试预算）。
      if (!clamped) {
        const limit = parseMaxTokensLimit(err, effectiveMaxTokens(activeCfg));
        if (limit !== null) {
          clamped = true;
          learnedMaxTokens.set(maxTokensKey(cfg), limit);
          announceLearnedLimit(cfg, limit, effectiveMaxTokens(activeCfg), err);
          handlers.onNotice?.(
            `${cfg.model} 的输出上限是 ${limit.toLocaleString()} tokens（当前配置 ${cfg.maxTokens.toLocaleString()}），本次起自动夹紧并重发。`,
          );
          attempt -= 1;
          continue;
        }
      }
      // 不透明 400：文案解析不出上限、非上下文超长/鉴权/parallel 拒绝时，
      // 夹到保守值重发一次。不占重试预算，且必须放在 canRetry 之前（4xx 本不重试）。
      if (!opaqueDowngraded && shouldDowngradeForOpaque400(err, effectiveMaxTokens(activeCfg))) {
        opaqueDowngraded = true;
        const original = effectiveMaxTokens(activeCfg);
        activeCfg = { ...activeCfg, maxTokens: OPAQUE_400_DOWNGRADE_FLOOR };
        handlers.onNotice?.(
          `网关拒绝了原 max_tokens=${original.toLocaleString()}（错误文案里解析不出上限），已降级到 ${OPAQUE_400_DOWNGRADE_FLOOR.toLocaleString()} 重发（仅本次请求；若持续失败请检查 settings.json 的 max_tokens 配置）。`,
        );
        attempt -= 1;
        continue;
      }
      const canRetry = err.retryable && isRetryableStatus(err.status);
      if (!canRetry || attempt >= policy.maxAttempts) {
        if (attempt > 1) err.message = `${err.message}（已尝试 ${attempt} 次）`;
        appendMaxTokensHint(err);
        throw err;
      }
      const delay = backoffMs(attempt, policy, err.retryAfterMs);
      handlers.onNotice?.(
        `LLM 请求失败：${err.message}；${(delay / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${policy.maxAttempts} 次）`,
      );
      await sleepAbortable(delay, signal);
    }
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(e: unknown): boolean {
  return (e as Error | undefined)?.name === "AbortError";
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** 指数退避 + 抖动；服务端给了 Retry-After 就优先听它的（封顶 30s）。 */
function backoffMs(attempt: number, policy: RetryConfig, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const exp = Math.min(MAX_BACKOFF_MS, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = policy.baseDelayMs > 0 ? Math.random() * policy.baseDelayMs * 0.25 : 0;
  return Math.round(exp + jitter);
}

/** 可被 abort 打断的 sleep（退避期间用户按 ESC 要能立刻停）。 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 已经输出过内容后的中断：明确不可重试，避免重复正文/重复工具调用。 */
function partialInterrupt(e: Error, emittedChars: number): LLMError {
  const err = new LLMError(
    `流式响应中断（已输出 ${emittedChars} 字符，为避免重复不再重试）：${e.message}`,
    e instanceof LLMError ? e.status : undefined,
  );
  err.retryable = false;
  return err;
}

/**
 * 单次流式请求（不重试）。失败语义：
 *  - LLMTimeoutError：连接/首字节或空闲超时，调用方按「是否已输出」决定能否重试；
 *  - LLMError(status)：HTTP 失败；
 *  - 其余：网络错误。
 */
async function streamOnce(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  policy: RetryConfig,
): Promise<StreamResult> {
  const ctrl = new AbortController();
  let timedOut: "connect" | "idle" | null = null;
  /** 已向调用方输出的字符数；>0 表示失败不可重试。 */
  let emittedChars = 0;
  /** 流 reader 的释放动作（读完或异常都要 releaseLock）。 */
  let releaseReader: (() => void) | null = null;
  const onUserAbort = (): void => ctrl.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });
  const connectTimer = setTimeout(() => {
    timedOut = "connect";
    ctrl.abort();
  }, policy.connectTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "idle";
      ctrl.abort();
    }, policy.streamIdleTimeoutMs);
  };
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify(buildBody(cfg, messages, tools, true)),
      signal: ctrl.signal,
    });
    clearTimeout(connectTimer);
    if (!res.ok) {
      const err = await describeError(res);
      err.retryable = isRetryableStatus(res.status);
      err.retryAfterMs = parseRetryAfter(res);
      throw err;
    }
    if (!res.body) throw new LLMError("响应没有 body，无法流式读取");

    const streamReader = res.body.getReader();
    releaseReader = () => streamReader.releaseLock?.();
    armIdle();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    const partials = new Map<number, PartialToolCall>();
    let lastRaw: unknown = null;
    /** 是否收到显式 [DONE]；与 finish_reason 一起用于识别连接被提前掐断。 */
    let sawDone = false;

    const handleChunk = (chunk: Record<string, unknown>): void => {
      lastRaw = chunk;
      if (typeof chunk["usage"] === "object" && chunk["usage"] !== null) {
        usage = chunk["usage"] as Usage;
      }
      const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) return;

      if (typeof choice["finish_reason"] === "string") {
        finishReason = choice["finish_reason"] as string;
      }

      const delta = choice["delta"] as Record<string, unknown> | undefined;
      if (!delta) return;

      const r = delta["reasoning_content"];
      if (typeof r === "string" && r.length > 0) {
        reasoning += r;
        emittedChars += r.length;
        handlers.onReasoning?.(r);
      }
      // 部分服务端把 reasoning 放在 reasoning 或 thinking 字段
      const th = delta["thinking"];
      if (typeof th === "string" && th.length > 0) {
        reasoning += th;
        emittedChars += th.length;
        handlers.onReasoning?.(th);
      }

      const ct = delta["content"];
      if (typeof ct === "string" && ct.length > 0) {
        content += ct;
        emittedChars += ct.length;
        handlers.onContent?.(ct);
      }

      const tcs = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc["index"] === "number" ? tc["index"] : 0;
          let p = partials.get(idx);
          if (!p) {
            p = { id: "", name: "", args: "" };
            partials.set(idx, p);
          }
          if (typeof tc["id"] === "string" && tc["id"].length > 0) p.id = tc["id"];
          const fn = tc["function"] as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn["name"] === "string" && fn["name"].length > 0) p.name = fn["name"];
            if (typeof fn["arguments"] === "string" && fn["arguments"].length > 0) {
              p.args += fn["arguments"];
              emittedChars += fn["arguments"].length;
              handlers.onToolCallDelta?.(idx, p.name, fn["arguments"]);
            }
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        sep = buffer.search(/\r?\n\r?\n/);

        for (const line of rawEvent.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }
          try {
            handleChunk(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // 忽略无法解析的 keep-alive 片段
          }
        }
      }
    }

    // SSE 正常收尾：OpenAI 兼容端点应发 [DONE] 或至少一个 finish_reason。
    // 两者都没有却 EOF，说明连接被中途掐断（部分网关/代理会这样，客户端读到的
    // 是正常 EOF 而不是错误）。必须显式失败，否则会拿半截内容当完整答案。
    if (!sawDone && finishReason === null) {
      const err = new LLMError("流式连接提前结束（未收到 [DONE] 或 finish_reason）");
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, p]) => p.name.length > 0)
      .map(([, p], i) => ({
        id: p.id || `call_${i}_${Date.now()}`,
        type: "function" as const,
        function: { name: p.name, arguments: p.args || "{}" },
      }));

    return { content, reasoning, toolCalls, finishReason, usage, raw: lastRaw };
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      const err = new LLMTimeoutError(
        timedOut,
        timedOut === "connect" ? policy.connectTimeoutMs : policy.streamIdleTimeoutMs,
      );
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }
    if (e instanceof LLMError) {
      if (emittedChars > 0) throw partialInterrupt(e, emittedChars);
      throw e;
    }
    if (isAbortError(e) && ctrl.signal.aborted) {
      // 除了超时与用户取消，没有别的内部 abort 来源；兜底按连接超时归类。
      const err = new LLMTimeoutError("connect", policy.connectTimeoutMs);
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }
    const err = new LLMError(`网络请求失败：${(e as Error)?.message ?? String(e)}`);
    if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
    throw err;
  } finally {
    clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onUserAbort);
    releaseReader?.();
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export async function listModels(cfg: Config): Promise<string[]> {
  const res = await fetch(`${cfg.baseUrl}/models`, { headers: authHeaders(cfg) });
  if (!res.ok) throw await describeError(res);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

export { estimateTokens } from "./llm/estimateTokens.ts";
