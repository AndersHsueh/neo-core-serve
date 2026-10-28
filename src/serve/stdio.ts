/**
 * serve/stdio.ts — 行分隔帧传输（测试/PTY/嵌入）。
 *
 * stdout 只出协议帧；日志/错误一律 stderr。
 */
import { createInterface } from "node:readline";
import { decodeClientMessage } from "../protocol/guards.ts";
import { decodeFrame, frameTooLarge, tooLargeResult } from "./frames.ts";
import type { ServerMessage } from "../protocol/types.ts";
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
    if (frameTooLarge(text)) {
      write(tooLargeResult(text));
      continue;
    }
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

