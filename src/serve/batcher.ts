/**
 * serve/batcher.ts — 每连接事件合批/背压（v0.0.2）。
 *
 * 规则（协议 §9）：
 *  - 16ms 或 4KB 或 64 帧 flush；
 *  - 同 block 的 assistant/reasoning delta 合并（保留最新 seq）；
 *  - 队列超 512 帧 / 8MB：先丢 ephemeral，仍超 → onOverflow（调用方关闭 4408）。
 */
import type { ServerMessage } from "../protocol/types.ts";

type EventFrame = Extract<ServerMessage, { kind: "event" }>;

const EPHEMERAL = new Set(["assistant.delta", "reasoning.delta", "tool.progress", "activity", "notice"]);

export interface BatcherOptions {
  send: (frame: ServerMessage) => void;
  onOverflow: () => void;
  flushMs?: number;
  flushBytes?: number;
  flushFrames?: number;
  maxFrames?: number;
  maxBytes?: number;
}

export class EventBatcher {
  private queue: ServerMessage[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly flushMs: number;
  private readonly flushBytes: number;
  private readonly flushFrames: number;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: BatcherOptions) {
    this.flushMs = opts.flushMs ?? 16;
    this.flushBytes = opts.flushBytes ?? 4096;
    this.flushFrames = opts.flushFrames ?? 64;
    this.maxFrames = opts.maxFrames ?? 512;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  }

  enqueue(frame: ServerMessage): void {
    if (this.closed) return;
    if (frame.kind === "event" && EPHEMERAL.has(frame.event.type)) {
      const last = this.queue[this.queue.length - 1];
      if (last && last.kind === "event" && sameDelta(last, frame)) {
        const before = estimate(last);
        const merged = mergeDelta(last, frame);
        this.queue[this.queue.length - 1] = merged;
        this.bytes += estimate(merged) - before;
        this.enforceLimits();
        if (!this.closed) this.schedule();
        return;
      }
    }
    this.queue.push(frame);
    this.bytes += estimate(frame);
    this.enforceLimits();
    if (!this.closed) this.schedule();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const frames = this.queue;
    this.queue = [];
    this.bytes = 0;
    for (const frame of frames) {
      try {
        this.opts.send(frame);
      } catch {
        this.closed = true;
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private schedule(): void {
    // 阈值优先：即使已有 16ms 定时器，也要在 4KB/64 帧时立即 flush。
    if (this.bytes >= this.flushBytes || this.queue.length >= this.flushFrames) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private enforceLimits(): void {
    if (this.queue.length <= this.maxFrames && this.bytes <= this.maxBytes) return;
    // 先丢 ephemeral（从旧到新），保留 durable
    const kept: ServerMessage[] = [];
    for (const frame of this.queue) {
      const ephemeral = frame.kind === "event" && EPHEMERAL.has(frame.event.type);
      if (ephemeral) continue;
      kept.push(frame);
    }
    this.queue = kept;
    this.bytes = kept.reduce((n, f) => n + estimate(f), 0);
    if (this.queue.length > this.maxFrames || this.bytes > this.maxBytes) {
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.opts.onOverflow();
    }
  }
}

function sameDelta(a: EventFrame, b: EventFrame): boolean {
  const ta = (a.event as { type: string; blockId?: string });
  const tb = (b.event as { type: string; blockId?: string });
  return ta.type === tb.type && ta.blockId !== undefined && ta.blockId === tb.blockId;
}

function mergeDelta(a: EventFrame, b: EventFrame): EventFrame {
  const ea = a.event as { type: "assistant.delta" | "reasoning.delta"; blockId: string; text: string };
  const eb = b.event as { type: "assistant.delta" | "reasoning.delta"; blockId: string; text: string };
  return { ...a, seq: b.seq, event: { ...ea, text: ea.text + eb.text } };
}

function estimate(frame: ServerMessage): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}
