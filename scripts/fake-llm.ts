#!/usr/bin/env bun
/**
 * scripts/fake-llm.ts — 脚本化 OpenAI 兼容端点（SSE），供 e2e 测试使用。
 *
 * 来源：移植自 neo/scripts/fake-llm.ts，并按 Matrix-Core v0.0.1 的测试面扩展：
 *  - 场景：tool-then-answer（默认）| narration | ask-user | write-then-answer | slow | resume
 *  - reasoning_content：每个场景的首次请求都会流式下发思考内容，让 host 能产出
 *    reasoning.start/delta/end（协议 v1.1 §5.1）。
 *  - usage：流末尾追加一个只带 usage 的 chunk，让 stats.usage 非零（便于断言）。
 *  - 请求留痕：GET /_requests 返回最近请求的 messages 摘要，供 resume 测试验证
 *    「上一轮消息确实进了下一轮上下文」。
 *
 * 关键设计：**逐轮无状态** —— 每一轮该回什么，只由「最后一条 user 消息之后的 tool
 * 消息条数」决定。同一个进程可反复跑任意场景，多次运行/多轮对话结果一致，不会因为
 * 上一轮留下的状态而漂移；同时也让第二轮 turn.send 重新走工具调用（每轮独立）。
 *
 * 用法：
 *   bun run scripts/fake-llm.ts                        # 默认 18123 端口、tool-then-answer
 *   PORT=0 SCENARIO=ask-user bun run scripts/fake-llm.ts
 *     ↑ PORT=0 让内核分配空闲端口，启动后 stdout 打印 `FAKE_LLM_READY port=<n>`
 *       （e2e 用这种方式彻底规避端口冲突）
 *
 * 环境变量：
 *   PORT             监听端口，默认 18123；0 = 自动分配
 *   HOST             监听地址，默认 127.0.0.1
 *   SCENARIO         见上
 *   STREAM_DELAY_MS  帧间延迟（模拟流式），默认 2ms
 *   SLOW_DELAY_MS    slow 场景的帧间延迟，默认 120ms
 *   SLOW_FRAMES      slow 场景的正文帧数，默认 10
 *
 * 路由（同时接受带 /v1 前缀与不带的写法）：
 *   GET  /health                 → ok
 *   GET  /models                 → {"object":"list", ...}
 *   POST /chat/completions       → SSE
 *   GET  /_requests              → 最近请求的 {messages:[{role,content}]} 摘要
 *
 * 所有请求体仅在内存中读取；不写日志文件（避免测试数据落进仓库）。
 */

type Scenario =
  | "tool-then-answer"
  | "narration"
  | "ask-user"
  | "ask-user-multi"
  | "write-then-answer"
  | "allow-session"
  | "slow"
  | "resume";

const SCENARIOS: readonly Scenario[] = [
  "tool-then-answer",
  "narration",
  "ask-user",
  "ask-user-multi",
  "write-then-answer",
  "allow-session",
  "slow",
  "resume",
];

function pickScenario(raw: string | undefined): Scenario {
  const s = (raw ?? "").trim();
  if ((SCENARIOS as readonly string[]).includes(s)) return s as Scenario;
  if (s) {
    console.error(`[fake-llm] 未知 SCENARIO="${s}"，可选：${SCENARIOS.join(" | ")}；回落到 tool-then-answer`);
  }
  return "tool-then-answer";
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`[fake-llm] 非法 ${name}="${raw}"，回落 ${fallback}`);
    return fallback;
  }
  return n;
}

const SCENARIO: Scenario = pickScenario(process.env["SCENARIO"]);
const PORT = normalizePort(process.env["PORT"]);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const MODEL = "fake-model";
const STREAM_DELAY_MS = envInt("STREAM_DELAY_MS", 2, 0);
const SLOW_DELAY_MS = envInt("SLOW_DELAY_MS", 120, 1);
const SLOW_FRAMES = envInt("SLOW_FRAMES", 10, 1);

function normalizePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 18123;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[fake-llm] 非法 PORT="${raw}"，回落 18123`);
    return 18123;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 帧构造                                                              */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

/** 一个 chat.completion.chunk 帧。delta 为空对象表示本帧只携带 finish_reason。 */
function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return chunkFrame({ delta, finishReason });
}

function chunkFrame(opts: {
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: Record<string, unknown>;
}): string {
  const payload: Record<string, unknown> = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices:
      opts.delta === undefined
        ? []
        : [{ index: 0, delta: opts.delta, finish_reason: opts.finishReason ?? null }],
  };
  if (opts.usage) payload["usage"] = opts.usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 正文拆成两帧下发，确保客户端真的走增量拼接而不是「一次到手」。 */
function contentFrames(text: string): string[] {
  const half = Math.max(1, Math.floor(text.length / 2));
  return [frame({ content: text.slice(0, half) }), frame({ content: text.slice(half) })];
}

/** 思考内容：与正文同一条流，字段 reasoning_content（OpenAI 兼容推理模型口径）。 */
function reasoningFrames(text: string): string[] {
  const half = Math.max(1, Math.floor(text.length / 2));
  return [
    frame({ reasoning_content: text.slice(0, half) }),
    frame({ reasoning_content: text.slice(half) }),
  ];
}

/** 末端 usage chunk：choices 为空数组，只带用量统计。 */
function usageFrame(promptTokens = 12, completionTokens = 6, reasoningTokens = 3): string {
  return chunkFrame({
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  });
}

/** 工具调用：name 与 arguments 分开三帧，覆盖增量拼接路径（index/id/type）。 */
function toolCallFrames(id: string, name: string, argChunks: string[]): string[] {
  const out = [
    frame({
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
    }),
  ];
  for (const chunk of argChunks) {
    out.push(frame({ tool_calls: [{ index: 0, function: { arguments: chunk } }] }));
  }
  return out;
}

function finishFrames(reason: "stop" | "tool_calls"): string[] {
  return [frame({}, reason), "data: [DONE]\n\n"];
}

/* ------------------------------------------------------------------ */
/* 场景：按最后一条 user 消息之后的 tool 消息数决定这一轮              */
/* ------------------------------------------------------------------ */

interface WireMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
}

/** 最后一条 user 消息之后的 tool 消息条数 —— 本轮分支的唯一依据。 */
function countToolMessagesSinceUser(messages: WireMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") break;
    if (m.role === "tool") n++;
  }
  return n;
}

/** 最后一条 user 消息的纯文本（content 可能是 string 或多模态 part 数组）。 */
function lastUserText(messages: WireMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part !== "object" || part === null) return "";
          const p = part as { type?: string; text?: unknown };
          return p.type === "text" && typeof p.text === "string" ? p.text : "";
        })
        .join("");
    }
    return "";
  }
  return "";
}

function toolRounds(messages: WireMessage[]): number {
  return countToolMessagesSinceUser(messages);
}

function framesFor(scenario: Scenario, messages: WireMessage[]): string[] {
  const rounds = toolRounds(messages);
  switch (scenario) {
    case "resume":
      // 恢复回放场景：不调工具，两次请求都是同一个最终答案。
      return [...reasoningFrames("回忆一下。"), ...contentFrames("会话恢复测试答案。"), usageFrame(), ...finishFrames("stop")];

    case "narration": {
      // 连续两轮「正文 + 工具」，用于验证每一段正文都有独立的 assistant 块。
      if (rounds === 0) {
        return [
          ...contentFrames("先看看这个文件。"),
          ...toolCallFrames("call_fake_0", "read_file", ['{"path":', '"a.txt"}']),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      if (rounds === 1) {
        return [
          ...contentFrames("第二次说明。"),
          ...toolCallFrames("call_fake_1", "read_file", ['{"path":', '"b.txt"}']),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      return [...contentFrames("都读完了。"), usageFrame(), ...finishFrames("stop")];
    }

    case "ask-user": {
      if (rounds === 0) {
        const args = JSON.stringify({
          header: "确认方案",
          question: "选哪个报价方案？",
          context: "影响最终报价口径",
          options: [
            { label: "方案 A", description: "成本优先" },
            { label: "方案 B", description: "质量优先" },
          ],
        });
        return [
          ...contentFrames("需要你拍板一个问题。"),
          ...toolCallFrames("call_fake_ask", "ask_user", [args]),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      return [...contentFrames("ANSWER_OK"), usageFrame(), ...finishFrames("stop")];
    }

    case "ask-user-multi": {
      if (rounds === 0) {
        const args = JSON.stringify({
          header: "多选",
          question: "选哪些能力？",
          context: "多选/自定义回答用例",
          options: [
            { label: "读文件", description: "只读" },
            { label: "写文件", description: "需要审批" },
            { label: "跑命令", description: "shell" },
          ],
          multi_select: true,
          allow_custom: true,
        });
        return [
          ...contentFrames("需要你多选几个能力。"),
          ...toolCallFrames("call_fake_ask_multi", "ask_user", [args]),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      return [...contentFrames("MULTI_OK"), usageFrame(), ...finishFrames("stop")];
    }

    case "write-then-answer": {
      if (rounds === 0) {
        return [
          ...contentFrames("准备写文件。"),
          ...toolCallFrames("call_fake_write", "write_file", [
            '{"path":"a.txt",',
            '"content":"written by matrix-core\\n"}',
          ]),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      return [...contentFrames("写完了。"), usageFrame(), ...finishFrames("stop")];
    }

    case "allow-session": {
      // allow-session 语义测试：write a → write b（同 tool 应免审批）→ shell（必须再审批）。
      if (rounds === 0) {
        return [
          ...contentFrames("先写第一个文件。"),
          ...toolCallFrames("call_fake_ws_a", "write_file", [
            '{"path":"a.txt",',
            '"content":"allow-session A\\n"}',
          ]),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      if (rounds === 1) {
        return [
          ...contentFrames("再写第二个文件。"),
          ...toolCallFrames("call_fake_ws_b", "write_file", [
            '{"path":"b.txt",',
            '"content":"allow-session B\\n"}',
          ]),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      if (rounds === 2) {
        return [
          ...contentFrames("跑个命令确认。"),
          ...toolCallFrames("call_fake_sh", "shell", ['{"command":"echo allow-session-shell"}']),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      return [...contentFrames("全部完成。"), usageFrame(), ...finishFrames("stop")];
    }

    case "slow": {
      // 用于 turn.abort：首帧立刻到，之后每 SLOW_DELAY_MS 一帧，留出中断窗口。
      if (rounds > 0) return [...contentFrames("慢回答完成。"), usageFrame(), ...finishFrames("stop")];
      const frames: string[] = [];
      for (let i = 0; i < SLOW_FRAMES; i++) frames.push(frame({ content: `片段${i + 1}。` }));
      frames.push(usageFrame(), ...finishFrames("stop"));
      return frames;
    }

    case "tool-then-answer":
    default: {
      if (rounds === 0) {
        return [
          ...reasoningFrames("我先看看 a.txt。"),
          ...contentFrames("先看看这个文件。"),
          ...toolCallFrames("call_fake_0", "read_file", ['{"path":', '"a.txt"}']),
          usageFrame(),
          ...finishFrames("tool_calls"),
        ];
      }
      // 第 2 轮：已经拿到工具结果（无论成功/失败），直接给最终答案。
      return [...contentFrames("读完了：内容是 hello。"), usageFrame(), ...finishFrames("stop")];
    }
  }
}

/* ------------------------------------------------------------------ */
/* 请求留痕（仅内存）                                                  */
/* ------------------------------------------------------------------ */

interface RequestRecord {
  at: number;
  scenario: Scenario;
  /** 只留 {role, content 文本, tool_call_id}，便于断言且不落盘。 */
  messages: { role: string; content: string; toolCallId?: string; name?: string }[];
}

const MAX_RECORDS = 50;
const records: RequestRecord[] = [];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const p = part as { type?: string; text?: unknown };
        return p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return "";
}

function remember(messages: WireMessage[]): void {
  records.push({
    at: Date.now(),
    scenario: SCENARIO,
    messages: messages.map((m) => ({
      role: m.role ?? "unknown",
      content: textOf(m.content),
      ...(typeof m.tool_call_id === "string" ? { toolCallId: m.tool_call_id } : {}),
      ...(typeof m.name === "string" ? { name: m.name } : {}),
    })),
  });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function delayFor(scenario: Scenario): number {
  return scenario === "slow" ? SLOW_DELAY_MS : STREAM_DELAY_MS;
}

function sseResponse(frames: string[], scenario: Scenario): Response {
  const gap = delayFor(scenario);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 每帧之间让出事件循环：既模拟真实流式，也让客户端能观察到中间态。
        for (const f of frames) {
          controller.enqueue(encoder.encode(f));
          if (gap > 0) await Bun.sleep(gap);
        }
      } catch {
        // 客户端提前断开（例如 abort 测试）：静默收尾，不打印噪音。
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function json(data: unknown): Response {
  return Response.json(data, { headers: { "Cache-Control": "no-cache" } });
}

const server = (() => {
  try {
    return Bun.serve({
      hostname: HOST,
      port: PORT,
      // 测试端点只服务本机，不需要 keep-alive 保活策略。
      idleTimeout: 30,
      async fetch(req) {
        const url = new URL(req.url);
        // 同时接受带 /v1 与不带 /v1 的路径：NEO_BASE_URL 是否含 /v1 由调用方决定。
        const path = url.pathname.replace(/^\/v1(?=\/)/, "");

        if (req.method === "GET" && (path === "/health" || path === "/")) {
          return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }

        if (req.method === "GET" && path === "/models") {
          return json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "fake" }] });
        }

        if (req.method === "GET" && path === "/_requests") {
          return json({ scenario: SCENARIO, records });
        }

        if (req.method === "POST" && path === "/chat/completions") {
          let messages: WireMessage[] = [];
          try {
            const body = (await req.json()) as { messages?: WireMessage[] };
            if (Array.isArray(body.messages)) messages = body.messages;
          } catch {
            // 请求体不是合法 JSON 也照常回一个 stop 帧，避免测试被语法错误卡死。
          }
          remember(messages);
          return sseResponse(framesFor(SCENARIO, messages), SCENARIO);
        }

        return new Response(`not found: ${req.method} ${url.pathname}`, { status: 404 });
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[fake-llm] 无法监听 ${HOST}:${PORT} —— ${msg}\n` +
        `  端口被占用时请换 PORT，或用 PORT=0 让内核分配临时端口。`,
    );
    process.exit(1);
  }
})();

// 供 e2e 读取实际端口（PORT=0 时是内核分配的临时端口）。
// 一行、稳定前缀，便于父进程按行解析。
console.log(`FAKE_LLM_READY port=${server.port} scenario=${SCENARIO}`);

const shutdown = (): void => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
