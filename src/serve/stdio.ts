/**
 * serve/stdio.ts — 行分隔帧传输（测试/PTY/嵌入）。
 *
 * stdout 只出协议帧；日志/错误一律 stderr。
 */
import { createInterface } from "node:readline";
import { decodeClientMessage } from "../protocol/guards.ts";
import type { ClientCommand, ServerMessage } from "../protocol/types.ts";
import { dispatchCommand, eventFrame, makeResult, readyFrame } from "./dispatch.ts";
import type { HostPort } from "./types.ts";

export interface StdioOptions {
  coreVersion: string;
  /** 启动时先推送的事件（例如恢复提示） */
  bootEvents?: unknown[];
}

export async function runStdio(host: HostPort, opts: StdioOptions): Promise<number> {
  const write = (msg: ServerMessage): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const send = { frame: write };

  const unsub = host.onEvent((event) => write(eventFrame(host, event)));
  write(readyFrame(host, opts.coreVersion));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      write(makeResult("?", false, { code: "protocol", message: "invalid JSON frame", retryable: false }));
      continue;
    }
    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) {
      const id = (raw as { id?: string }).id ?? "?";
      write(makeResult(id, false, decoded.error));
      continue;
    }
    const envelope = raw as { id: string };
    await dispatchCommand({ host, coreVersion: opts.coreVersion, send }, envelope.id, decoded.value);
  }

  unsub();
  await host.close();
  return 0;
}

/** 供 WS 复用：把一条文本帧解码为命令（失败返回错误帧） */
export function decodeFrame(text: string):
  | { ok: true; id: string; command: ClientCommand }
  | { ok: false; id: string; error: { code: string; message: string; retryable: boolean } } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, id: "?", error: { code: "protocol", message: "invalid JSON frame", retryable: false } };
  }
  const id = (raw as { id?: string }).id ?? "?";
  const decoded = decodeClientMessage(raw);
  if (!decoded.ok) {
    const e = decoded.error;
    return {
      ok: false,
      id,
      error: { code: e.code, message: e.message, retryable: e.retryable },
    };
  }
  return { ok: true, id, command: decoded.value };
}
