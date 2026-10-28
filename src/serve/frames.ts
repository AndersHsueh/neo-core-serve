/**
 * serve/frames.ts — 客户端帧解码（stdio 与 WS 共用）。
 *
 * 只做：JSON.parse → protocol guards → 统一错误形状；超长帧交给调用方先判。
 */
import { decodeClientMessage } from "../protocol/guards.ts";
import type { ClientCommand, HubError, ServerMessage } from "../protocol/types.ts";
import { PROTOCOL_VERSION } from "../protocol/types.ts";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8MB：容纳图片附件（v0.0.2）

export type DecodedFrame =
  | { ok: true; id: string; command: ClientCommand }
  | { ok: false; id: string; error: HubError };

export function frameTooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES;
}

/** 超限帧不回全量 parse，只轻量取 id，保证客户端能把错误关联到请求。 */
export function extractFrameId(text: string): string {
  const m = /"id"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1] ?? "?";
}

export function tooLargeResult(text: string): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    kind: "result",
    id: extractFrameId(text),
    ok: false,
    error: { code: "too_large", message: `frame exceeds 8MB`, retryable: false },
  };
}

export function decodeFrame(text: string): DecodedFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, id: "?", error: { code: "protocol", message: "invalid JSON frame", retryable: false } };
  }
  const id = (raw as { id?: string }).id ?? "?";
  const decoded = decodeClientMessage(raw);
  if (!decoded.ok) return { ok: false, id, error: decoded.error };
  return { ok: true, id, command: decoded.value };
}
