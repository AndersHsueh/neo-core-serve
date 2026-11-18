/**
 * Anthropic Messages 协议的**纯转换层**（无网络、无副作用）。
 *
 * 内部消息模型（Message / ToolCall / ToolSpec / StreamResult）一直是 OpenAI 形态，
 * 会话持久化、压缩、子代理、记忆都依赖它。这里只在请求边界做双向转换：
 *   Message[] / ToolSpec[]  →  Anthropic 请求体
 *   Anthropic 响应 / SSE 事件  →  StreamResult / 回调
 * 这样切协议（甚至同一会话里切 provider）不会让历史失效。
 *
 * 只 `import type`：llm.ts 反过来依赖本文件，运行时不能成环。
 */
import type { Message, StreamResult, ThinkingBlock, ToolCall, ToolSpec, Usage } from "./llm/messageTypes.ts";

type Block = Record<string, unknown>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

/** tool_use.id / tool_result.tool_use_id 只允许 [a-zA-Z0-9_-]；其他协议生成的 id 可能含别的字符。 */
export function sanitizeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 0 ? s : "call_0";
}

function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return { type: "text", text: "[无法识别的图片]" };
}

function userBlocks(content: Message["content"]): Block[] {
  if (content === null) return [];
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text.length > 0) out.push({ type: "text", text: p.text });
    } else {
      out.push(imageBlock(p.image_url.url));
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI 形态消息 → Anthropic 的 system + messages。
 *
 *  - system：Anthropic 只有顶层 system 字段。**开头**连续的 system 消息合并进去；
 *    对话中途插入的 system 消息（实现提示、steer 等）没有对应位置，改成 user 文本块，
 *    内容原样保留并带「[系统消息]」前缀，不丢也不提升为顶层指令。
 *  - tool → user 消息里的 tool_result 块；连续的 tool 结果合并进同一条 user 消息
 *    （Anthropic 要求 tool_use 之后紧跟包含全部 tool_result 的一条 user 消息）。
 *  - 相邻同角色消息合并：保证 user / assistant 严格交替。
 */
export function toAnthropicMessages(messages: Message[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let seenNonSystem = false;

  const push = (role: "user" | "assistant", blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (!text) continue;
      if (!seenNonSystem) systemParts.push(text);
      else push("user", [{ type: "text", text: `[系统消息]\n${text}` }]);
      continue;
    }
    seenNonSystem = true;

    if (m.role === "user") {
      push("user", userBlocks(m.content));
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      // 思考块必须排在 text / tool_use 之前，并保持原样（含签名）。
      for (const tb of m.thinking_blocks ?? []) blocks.push({ ...tb });
      if (typeof m.content === "string" && m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: sanitizeToolId(tc.id),
          name: tc.function.name,
          input: parseArgs(tc.function.arguments),
        });
      }
      // 空助手消息（无正文无工具调用）Anthropic 会拒收，给一个占位而不是丢弃以保持交替。
      if (blocks.length === 0) blocks.push({ type: "text", text: "(无内容)" });
      push("assistant", blocks);
    } else {
      const text = typeof m.content === "string" ? m.content : "";
      push("user", [
        {
          type: "tool_result",
          tool_use_id: sanitizeToolId(m.tool_call_id ?? ""),
          content: text.length > 0 ? text : "(无输出)",
        },
      ]);
    }
  }

  // tool_result 必须排在同一条 user 消息的最前面（Anthropic 的硬性要求）。
  for (const msg of out) {
    if (msg.role !== "user") continue;
    const results = msg.content.filter((b) => b["type"] === "tool_result");
    if (results.length === 0) continue;
    msg.content = [...results, ...msg.content.filter((b) => b["type"] !== "tool_result")];
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

export function toAnthropicTools(tools: ToolSpec[]): Block[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export interface AnthropicBodyInput {
  model: string;
  maxTokens: number;
  temperature: number;
  thinking?: { type: "enabled" | "disabled" };
  /** 是否允许并行工具调用。 */
  parallel: boolean;
}

/** thinking 预算下限（Anthropic 规定 budget_tokens >= 1024 且 < max_tokens）。 */
const MIN_THINKING_BUDGET = 1024;

export function buildAnthropicBody(
  input: AnthropicBodyInput,
  messages: Message[],
  tools: ToolSpec[],
  stream: boolean,
): Record<string, unknown> {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: msgs,
    stream,
    temperature: input.temperature,
  };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = toAnthropicTools(tools);
    body.tool_choice = { type: "auto", disable_parallel_tool_use: !input.parallel };
  }
  if (input.thinking?.type === "disabled") {
    body.thinking = { type: "disabled" };
  } else if (input.thinking?.type === "enabled" && input.maxTokens > MIN_THINKING_BUDGET) {
    // 预算取输出上限的一半（至少 1024）：给正文留足空间，又不让思考吃光 max_tokens。
    body.thinking = {
      type: "enabled",
      budget_tokens: Math.min(input.maxTokens - 1, Math.max(MIN_THINKING_BUDGET, Math.floor(input.maxTokens / 2))),
    };
  }
  return body;
}

/** Anthropic stop_reason → 内部沿用的 OpenAI finish_reason 取值。 */
export function mapStopReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return reason;
  }
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

/**
 * Anthropic usage → 内部 Usage。
 * Anthropic 的 input_tokens **不含**缓存命中/写入部分，三者相加才是本次请求的真实输入规模。
 */
export function mapUsage(u: RawUsage): Usage {
  const prompt =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  const out: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  const th = u.output_tokens_details?.thinking_tokens;
  if (typeof th === "number") out.completion_tokens_details = { reasoning_tokens: th };
  return out;
}

/** 非流式响应 → StreamResult。 */
export function parseAnthropicMessage(json: Record<string, unknown>): StreamResult {
  const blocks = Array.isArray(json["content"]) ? (json["content"] as Block[]) : [];
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  for (const b of blocks) {
    const type = b["type"];
    if (type === "text" && typeof b["text"] === "string") content += b["text"];
    else if (type === "thinking" && typeof b["thinking"] === "string") {
      reasoning += b["thinking"];
      if (typeof b["signature"] === "string" && b["signature"]) {
        thinkingBlocks.push({ type: "thinking", thinking: b["thinking"], signature: b["signature"] });
      }
    } else if (type === "redacted_thinking" && typeof b["data"] === "string") {
      thinkingBlocks.push({ type: "redacted_thinking", data: b["data"] });
    } else if (type === "tool_use" && typeof b["name"] === "string") {
      toolCalls.push({
        id: typeof b["id"] === "string" && b["id"] ? b["id"] : `call_${toolCalls.length}_${Date.now()}`,
        type: "function",
        function: { name: b["name"], arguments: JSON.stringify(b["input"] ?? {}) },
      });
    }
  }
  const usage = json["usage"];
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: mapStopReason(json["stop_reason"] as string | null | undefined),
    usage: typeof usage === "object" && usage !== null ? mapUsage(usage as RawUsage) : null,
    raw: json,
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
  };
}

/** error 事件类型里哪些值得重试（过载/限流/服务端故障）；其余（鉴权、参数）重试无意义。 */
export function isRetryableAnthropicError(type: string): boolean {
  return type === "overloaded_error" || type === "api_error" || type === "rate_limit_error";
}
