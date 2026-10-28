/**
 * core/protocol-io.ts — AgentIO → 协议事件（v0.0.1）。
 *
 * neo 的 Agent 通过 `AgentIO` 与终端对话；core 无终端，本文件把它翻译成
 * 协议 v1.1 的 durable / ephemeral 事件：
 *
 *   begin/write/endStream  → assistant.start/delta/end、reasoning.start/delta/end
 *   toolHeader/toolResult  → tool.start / tool.end
 *   confirm                → approval.request → （resolveApproval / 超时）→ approval.resolve
 *   askUser                → question.request → （answerQuestion / 超时）→ question.resolve
 *   info/warn/error        → notice（ephemeral，不重放）
 *   spinner                → activity（ephemeral）
 *
 * 文本通道的唯一真源是 Agent 的 `onEvent({type:"text"|"reasoning"})`：
 * 它先于所有渲染发生，且拿到的是模型原始 chunk。因此 `writeStream` /
 * `writeRaw` 故意 no-op —— `StreamFormatter` 会插入终端框线（`┌─ code`），
 * 那种字符串不是协议文本。Agent 仍走 interactive 分支（streaming:true），
 * 才有 beginStream/endStream 这对干净的块边界。
 */

import type { AgentIO } from "./agent.ts";
import type { AskUserAnswer, AskUserRequest } from "./ui/askUser.ts";
import type { QuestionOption, SessionEvent, Tier, ToolState } from "../protocol/types.ts";

/** 工具输出预览上限：完整输出走 outputRef（v1.2），v0 只给预览。 */
const TOOL_OUTPUT_PREVIEW = 4_000;

export interface ProtocolIOOptions {
  /** 发事件；durable=true 时由 host 分配 seq 并写 transcript。 */
  emit: (event: SessionEvent, durable: boolean) => void;
  now: () => number;
  newId: (prefix: string) => string;
  /** 当前生效档位（assistant.start / tier.switch 用）。 */
  getTier: () => Tier;
  approvalTimeoutMs: number;
  questionTimeoutMs: number;
  /** 工具开始/结束回调（host 用于统计与诊断，可不传）。 */
  onToolStart?: (info: { blockId: string; name: string; at: number }) => void;
  onToolEnd?: (info: { blockId: string; name: string; state: ToolState; at: number }) => void;
}

type ActivityPhase = "llm" | "tool" | "approval" | "compact";

interface PendingApproval {
  tool: string;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingQuestion {
  resolve: (answer: AskUserAnswer) => void;
  timer: ReturnType<typeof setTimeout> | null;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

/**
 * ProtocolIO —— AgentIO 的协议实现 + 待决审批/提问登记表。
 *
 * 待决表放在 IO 而不是 host：请求由 IO 发起，`blockId` 由 IO 生成，
 * 外部只按 blockId resolve，天然避免「host 与 IO 两套 id」。
 */
export class ProtocolIO implements AgentIO {
  private assistant: { blockId: string; text: string } | null = null;
  private reasoning: { blockId: string; text: string; startedAt: number } | null = null;
  private tool: { blockId: string; name: string; startedAt: number; output: string; ok: boolean } | null =
    null;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private lastActivity: ActivityPhase | null = null;
  /**
   * 本轮工具是否因审批被拒（deny/timeout）。
   * Agent 的 tool 在拒绝时返回普通说明文本（ok:true），协议侧必须把它标成
   * `tool.end.state="denied"`，否则客户端看起来像「工具成功但啥也没干」。
   */
  private toolDenied = false;
  /**
   * allow-session（内存 allowlist，不落盘；架构 §8.3）：
   * 仅 write_file / edit_file 可记忆，shell 永不记忆。
   */
  private readonly sessionAllowed = new Set<string>();

  constructor(private readonly opt: ProtocolIOOptions) {}

  /* ------------------------------------------------------------------ */
  /* AgentIO：文本渲染（core 不渲染）                                    */
  /* ------------------------------------------------------------------ */

  line(_s?: string): void {}
  blank(): void {}
  indent(body: string, prefix = "│ "): string {
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }

  info(msg: string): void {
    this.notice("info", msg);
  }
  warn(msg: string): void {
    this.notice("warn", msg);
  }
  error(msg: string): void {
    this.notice("error", msg);
  }

  private notice(level: "info" | "warn" | "error", text: string): void {
    if (!text.trim()) return;
    this.opt.emit({ type: "notice", level, text }, false);
  }

  /* ------------------------------------------------------------------ */
  /* 流式：唯一作用是把「块边界」变成 durable 事件                      */
  /* ------------------------------------------------------------------ */

  beginStream(kind: "reasoning" | "answer" | "tool-args"): void {
    if (kind === "answer") this.ensureAssistant();
    else if (kind === "reasoning") this.ensureReasoning();
  }

  /** 文本已由 host 的 onEvent 通道喂入；这里刻意不重复。 */
  writeStream(_text: string, _kind: "reasoning" | "answer" | "tool-args"): void {}

  endStream(kind?: "reasoning" | "answer" | "tool-args", _newline?: boolean): void {
    if (kind === "answer" || kind === undefined) this.endAssistant();
    if (kind === "reasoning" || kind === undefined) this.endReasoning();
  }

  ensureStreamClosed(): void {
    this.endAssistant();
    this.endReasoning();
  }

  /** 终端渲染通道（StreamFormatter 用）。core 不落文本，见文件头。 */
  writeRaw(_s: string): void {}

  startSpinner(_text: string): void {
    this.activity("llm");
  }
  updateSpinner(_text: string): void {}
  stopSpinner(_finalLine?: string): void {}

  /**
   * 轮开始/结束时清空活动相位缓存：`lastActivity` 只是去重用的，
   * 跨轮保留会让第二轮起不再发 activity（GUI spinner 只在第一轮有相位）。
   */
  beginTurn(): void {
    this.lastActivity = null;
  }
  endTurn(): void {
    this.lastActivity = null;
  }

  private activity(phase: ActivityPhase): void {
    if (this.lastActivity === phase) return;
    this.lastActivity = phase;
    this.opt.emit({ type: "activity", phase, since: this.opt.now() }, false);
  }

  get width(): number {
    return 80;
  }

  /* ------------------------------------------------------------------ */
  /* 文本增量（host 从 Agent.onEvent 转发）                              */
  /* ------------------------------------------------------------------ */

  assistantDelta(text: string): void {
    if (!text) return;
    this.ensureAssistant();
    if (!this.assistant) return;
    this.assistant.text += text;
    this.opt.emit({ type: "assistant.delta", blockId: this.assistant.blockId, text }, false);
  }

  reasoningDelta(text: string): void {
    if (!text) return;
    this.ensureReasoning();
    if (!this.reasoning) return;
    this.reasoning.text += text;
    this.opt.emit({ type: "reasoning.delta", blockId: this.reasoning.blockId, text }, false);
  }

  private ensureAssistant(): void {
    if (this.assistant) return;
    const blockId = this.opt.newId("asst");
    this.assistant = { blockId, text: "" };
    this.opt.emit(
      { type: "assistant.start", blockId, at: this.opt.now(), tier: this.opt.getTier() },
      true,
    );
  }

  private endAssistant(): void {
    if (!this.assistant) return;
    const { blockId, text } = this.assistant;
    this.assistant = null;
    this.opt.emit({ type: "assistant.end", blockId, text }, true);
  }

  private ensureReasoning(): void {
    if (this.reasoning) return;
    const blockId = this.opt.newId("rsn");
    this.reasoning = { blockId, text: "", startedAt: this.opt.now() };
    this.opt.emit({ type: "reasoning.start", blockId, at: this.opt.now() }, true);
  }

  private endReasoning(): void {
    if (!this.reasoning) return;
    const { blockId, text, startedAt } = this.reasoning;
    this.reasoning = null;
    this.opt.emit(
      {
        type: "reasoning.end",
        blockId,
        durationMs: Math.max(0, this.opt.now() - startedAt),
        tokens: 0,
        text,
      },
      true,
    );
  }

  /** 当前是否有打开的流（host 用它决定 snapshot.live）。 */
  streamState(): {
    assistant?: { blockId: string; text: string };
    reasoning?: { blockId: string; text: string };
  } {
    return {
      ...(this.assistant ? { assistant: { ...this.assistant } } : {}),
      ...(this.reasoning ? { reasoning: { blockId: this.reasoning.blockId, text: this.reasoning.text } } : {}),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  toolHeader(name: string, argsPreview: string): void {
    // 上一个工具没有 tool.end（异常路径）：先收口，避免快照里永远 running。
    if (this.tool) this.finishTool(false, false);
    const blockId = this.opt.newId("tool");
    const at = this.opt.now();
    this.tool = { blockId, name, startedAt: at, output: "", ok: true };
    this.toolDenied = false;
    this.activity("tool");
    this.opt.emit({ type: "tool.start", blockId, at, name, arg: argsPreview }, true);
    this.opt.onToolStart?.({ blockId, name, at });
  }

  toolResult(body: string, _maxLines?: number, ok?: boolean): void {
    if (!this.tool) return;
    this.tool.output = body ?? "";
    this.tool.ok = ok !== false;
  }

  /** Agent 的 tool_end 事件（带 ok/truncated）到达时收口工具块。 */
  finishTool(ok: boolean, truncated: boolean): void {
    const t = this.tool;
    if (!t) return;
    this.tool = null;
    const at = this.opt.now();
    const state: ToolState = this.toolDenied ? "denied" : ok ? "ok" : "error";
    this.toolDenied = false;
    this.opt.emit(
      {
        type: "tool.end",
        blockId: t.blockId,
        state,
        output: preview(t.output),
        durationMs: Math.max(0, at - t.startedAt),
        truncated: truncated || t.output.length > TOOL_OUTPUT_PREVIEW,
      },
      true,
    );
    this.opt.onToolEnd?.({ blockId: t.blockId, name: t.name, state, at });
  }

  /**
   * 强制收口正在运行的 tool（abort/异常/超时路径）。
   * 语义：审批被拒 → denied；其它中断 → error。绝不能留 `state:"running"`。
   */
  closeTool(reason = "（本轮已中断，工具未完成）"): void {
    const t = this.tool;
    if (!t) return;
    this.tool = null;
    const at = this.opt.now();
    const state: ToolState = this.toolDenied ? "denied" : "error";
    this.toolDenied = false;
    this.opt.emit(
      {
        type: "tool.end",
        blockId: t.blockId,
        state,
        output: t.output || reason,
        durationMs: Math.max(0, at - t.startedAt),
      },
      true,
    );
    this.opt.onToolEnd?.({ blockId: t.blockId, name: t.name, state, at });
  }

  /** 当前 running 的工具（snapshot.live 用）。 */
  toolState(): { blockId: string; name: string; startedAt: number } | undefined {
    return this.tool
      ? { blockId: this.tool.blockId, name: this.tool.name, startedAt: this.tool.startedAt }
      : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* 审批                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * neo 的 Agent 在 makeCtx 里已经做过模式判定（auto-all/auto-edit/plan），
   * 走到 confirm 的一定是「需要人回答」。问题文本形如 `写文件 — /tmp/x`。
   */
  async confirm(question: string): Promise<boolean> {
    const { tool, detail } = splitConfirm(question);
    if (this.sessionAllowed.has(tool)) return true;
    const blockId = this.opt.newId("appr");
    const at = this.opt.now();
    const deadlineAt = at + this.opt.approvalTimeoutMs;
    return new Promise<boolean>((resolve) => {
      const entry: PendingApproval = { tool, resolve, timer: null };
      // 先登记再 emit：同进程监听者可能在 emit 回调里同步 resolve（嵌入式/测试），
      // 反过来会查不到 pending 而误报 approval_expired。
      this.approvals.set(blockId, entry);
      entry.timer = safeSetTimeout(() => {
        if (!this.approvals.delete(blockId)) return;
        this.toolDenied = true;
        this.opt.emit({ type: "approval.resolve", blockId, state: "denied", by: "timeout" }, true);
        resolve(false);
      }, this.opt.approvalTimeoutMs);
      this.activity("approval");
      this.opt.emit(
        { type: "approval.request", blockId, at, tool, detail, deadlineAt },
        true,
      );
    });
  }

  resolveApproval(blockId: string, decision: "allow" | "deny" | "allow-session"): boolean {
    const entry = this.approvals.get(blockId);
    if (!entry) return false;
    this.approvals.delete(blockId);
    if (entry.timer) clearTimeout(entry.timer);
    const allowed = decision !== "deny";
    if (!allowed) this.toolDenied = true;
    if (allowed && decision === "allow-session" && isSessionAllowable(entry.tool)) {
      this.sessionAllowed.add(entry.tool);
    }
    this.opt.emit(
      { type: "approval.resolve", blockId, state: allowed ? "allowed" : "denied", by: "user" },
      true,
    );
    entry.resolve(allowed);
    return true;
  }

  pendingApprovalId(): string | undefined {
    return this.approvals.keys().next().value;
  }

  /* ------------------------------------------------------------------ */
  /* 提问                                                                */
  /* ------------------------------------------------------------------ */

  async askUser(req: AskUserRequest): Promise<AskUserAnswer> {
    const blockId = this.opt.newId("q");
    const at = this.opt.now();
    const options: QuestionOption[] = (req.options ?? []).map((o, i) => ({
      key: `o${i + 1}`,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    }));
    return new Promise<AskUserAnswer>((resolve) => {
      const entry: PendingQuestion = {
        resolve,
        timer: null,
        options,
        multiSelect: req.multiSelect === true,
        allowCustom: req.allowCustom !== false,
      };
      // 先登记再 emit（同 confirm：同步 answerQuestion 不能落在空 pending 上）。
      this.questions.set(blockId, entry);
      entry.timer = safeSetTimeout(() => {
        if (!this.questions.delete(blockId)) return;
        this.opt.emit(
          { type: "question.resolve", blockId, at: this.opt.now(), by: "timeout" },
          true,
        );
        resolve({ status: "canceled" });
      }, this.opt.questionTimeoutMs);
      this.opt.emit(
        {
          type: "question.request",
          blockId,
          at,
          prompt: req.question,
          ...(req.header ? { header: req.header } : {}),
          ...(req.context ? { context: req.context } : {}),
          options,
          multiSelect: req.multiSelect === true,
          allowCustom: req.allowCustom !== false,
          deadlineAt: at + this.opt.questionTimeoutMs,
        },
        true,
      );
    });
  }

  answerQuestion(blockId: string, keys: string[], custom?: string): boolean {
    const entry = this.questions.get(blockId);
    if (!entry) return false;
    // M7：先校验答案合法性，非法答案不消耗 pending（客户端可重答）。
    const trimmedCustom = custom?.trim() ? custom : undefined;
    const known = new Set(entry.options.map((o) => o.key));
    if (keys.some((k) => !known.has(k))) return false;
    if (keys.length > 1 && !entry.multiSelect) return false;
    if (trimmedCustom !== undefined && !entry.allowCustom) return false;
    if (keys.length === 0 && trimmedCustom === undefined) return false;
    this.questions.delete(blockId);
    if (entry.timer) clearTimeout(entry.timer);
    const selected = keys
      .map((k) => entry.options.find((o) => o.key === k)?.label)
      .filter((l): l is string => typeof l === "string");
    const answerLabel = [...selected, ...(trimmedCustom ? [trimmedCustom] : [])].join("；");
    this.opt.emit(
      {
        type: "question.resolve",
        blockId,
        at: this.opt.now(),
        ...(keys[0] ? { key: keys[0] } : {}),
        ...(keys.length > 0 ? { keys } : {}),
        ...(trimmedCustom ? { custom: trimmedCustom } : {}),
        ...(answerLabel ? { answerLabel } : {}),
        by: "user",
      },
      true,
    );
    entry.resolve({
      status: "answered",
      selected: selected.length > 0 ? selected : keys.slice(),
      custom: trimmedCustom ?? null,
    });
    return true;
  }

  pendingQuestionId(): string | undefined {
    return this.questions.keys().next().value;
  }

  /**
   * 统一收口所有待决项（abort/崩溃/关闭时）。
   * 审批按 deny、提问按 cancel —— 与架构 §8.2 的默认策略一致。
   */
  abortPending(by: "user" | "timeout" | "no_client" | "crash" | "shutdown" | "abort"): void {
    for (const [blockId, entry] of [...this.approvals]) {
      this.approvals.delete(blockId);
      if (entry.timer) clearTimeout(entry.timer);
      this.toolDenied = true;
      this.opt.emit({ type: "approval.resolve", blockId, state: "denied", by }, true);
      entry.resolve(false);
    }
    for (const [blockId, entry] of [...this.questions]) {
      this.questions.delete(blockId);
      if (entry.timer) clearTimeout(entry.timer);
      this.opt.emit({ type: "question.resolve", blockId, at: this.opt.now(), by }, true);
      entry.resolve({ status: "canceled" });
    }
  }

  hasPending(): boolean {
    return this.approvals.size > 0 || this.questions.size > 0;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** allow-session 只对写文件生效；shell 每次都要人批（架构 §8.3）。 */
function isSessionAllowable(tool: string): boolean {
  return tool === "write_file" || tool === "edit_file";
}

function splitConfirm(question: string): { tool: string; detail: string } {
  const idx = question.indexOf(" — ");
  if (idx === -1) return { tool: question.trim() || "tool", detail: "" };
  return { tool: question.slice(0, idx).trim(), detail: question.slice(idx + 3).trim() };
}

function preview(text: string): string {
  if (text.length <= TOOL_OUTPUT_PREVIEW) return text;
  return `${text.slice(0, TOOL_OUTPUT_PREVIEW)}…[已截断 ${text.length - TOOL_OUTPUT_PREVIEW} 字符]`;
}

/** setTimeout 的 unref 封装：计时器不阻止进程退出，但测试里仍会触发。 */
function safeSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}
