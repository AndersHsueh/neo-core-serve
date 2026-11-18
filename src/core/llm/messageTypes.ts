/**
 * LLM 消息 / 工具 / 用量的纯类型。无运行时，供 wire 转换与 token 估算引用，
 * 避免这些纯叶 import llm.ts 请求层。
 */
export type Role = "system" | "user" | "assistant" | "tool";

/**
 * 多模态 content part（PRD docs/paste-enhancement-prd[done].md §5.5）。
 * OpenAI 兼容 /chat/completions 的 user 消息标准形态；仅 user 消息可能携带数组，
 * system/assistant/tool 恒为 string（结构性约束，发送层不做转换）。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Anthropic 的思考块（含签名），原样保存以便下一轮回带。
 * 只在 Anthropic 协议路径下使用：OpenAI 路径、压缩、token 估算都忽略它。
 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** assistant 专用：上一轮 Anthropic 响应里的思考块，回带时排在 text/tool_use 之前。 */
  thinking_blocks?: ThinkingBlock[];
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  raw: unknown;
  /** Anthropic 协议下的思考块（含签名）；agent 写进 assistant 消息以便回带。 */
  thinkingBlocks?: ThinkingBlock[];
}
