/**
 * hub/worker.ts — 每会话一个 `matrix-core serve --stdio` 子进程。
 *
 * Hub 不跑 Agent；只做进程管理 + 帧转发。worker 的 stdout 只出协议帧，stderr 转发到 hub stderr。
 */
import { join } from "node:path";
import { decodeServerText } from "../protocol/guards.ts";
import type { ClientCommand, ServerMessage } from "../protocol/types.ts";

/** 向独立进程组发信号；失败则回退到 pid 本身。 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals | number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

export interface WorkerOptions {

  cwd: string;
  resume?: string | null;
  env?: Record<string, string | undefined>;
}

type SnapshotFrame = Extract<ServerMessage, { kind: "snapshot" }>;
type EventFrame = Extract<ServerMessage, { kind: "event" }>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerClient {
  sessionId = "";
  epoch = "";
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(frame: EventFrame) => void>();
  private readonly exitListeners = new Set<() => void>();
  private exited = false;
  private readonly stdoutDecoder = new TextDecoder();
  private readonly stderrDecoder = new TextDecoder();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private exitResolve: (() => void) | null = null;
  private readonly exitPromise: Promise<void>;
  private buffer = "";
  private snapshotWaiter: ((snapshot: SnapshotFrame) => void) | null = null;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  private constructor(proc: ReturnType<typeof Bun.spawn>, cwd: string) {
    this.proc = proc;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
    void this.readLoop();
    void this.stderrLoop(cwd);
    this.readyTimer = setTimeout(() => this.readyReject(new Error("worker ready timeout")), 15000);
  }

  static async spawn(opts: WorkerOptions): Promise<WorkerClient> {
    const entry = process.env["MATRIX_CORE_ENTRY"] ?? join(import.meta.dir, "..", "main.ts");
    const extra = (opts.env?.["MATRIX_CORE_WORKER_ARGS"] ?? process.env["MATRIX_CORE_WORKER_ARGS"] ?? "").trim();
    const extraArgs = extra ? extra.split(/\s+/).filter(Boolean) : [];
    const args = [process.execPath, entry, "serve", "--stdio", "--cwd", opts.cwd, ...extraArgs];
    if (opts.resume) args.push("--resume", opts.resume);
    process.stderr.write(`[hub] spawn worker ${args.slice(1).join(" ")}\n`);
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // 独立进程组：Hub 退出时可用 kill(-pid) 回收 shell 孙进程。
      detached: true,
    } as Parameters<typeof Bun.spawn>[1]);
    const client = new WorkerClient(proc, opts.cwd);
    try {
      await client.ready;
      if (!client.sessionId) throw new Error("worker ready without sessionId");
      return client;
    } catch (error) {
      try {
        proc.kill(9);
      } catch {
        /* gone */
      }
      throw error;
    }
  }

  onEvent(cb: (frame: EventFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onExit(cb: () => void): () => void {
    if (this.exited) {
      cb();
      return () => undefined;
    }
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  async request(command: ClientCommand): Promise<unknown> {
    if (this.exited) throw new Error("worker exited");
    await this.ready;
    const id = `w${++this.nextId}`;
    const dataPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request timeout: ${command.type}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.write(`${JSON.stringify({ v: 1, kind: "command", id, command })}\n`);
    });
    return await dataPromise;
  }

  async attach(lastSeq?: number, epoch?: string): Promise<SnapshotFrame> {
    if (this.exited) throw new Error("worker exited");
    await this.ready;
    const id = `w${++this.nextId}`;
    const snapshotPromise = new Promise<SnapshotFrame>((resolve) => {
      this.snapshotWaiter = resolve;
    });
    const dataPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("attach timeout")), 15000);
      this.pending.set(id, { resolve, reject, timer });
      const command: ClientCommand = {
        type: "session.attach",
        ...(lastSeq !== undefined ? { lastSeq } : {}),
        ...(epoch ? { epoch } : {}),
      };
      this.write(`${JSON.stringify({ v: 1, kind: "command", id, command })}\n`);
    });
    await dataPromise;
    return await snapshotPromise;
  }

  pid(): number {
    return this.proc.pid;
  }

  closeStdin(): void {
    try {
      const stdin = this.proc.stdin as unknown as { end?: () => void; flush?: () => void } | null;
      stdin?.flush?.();
      stdin?.end?.();
    } catch {
      /* ignore */
    }
  }

  signalGroup(signal: NodeJS.Signals | number): void {
    killProcessGroup(this.proc.pid, signal);
  }

  async waitExit(timeoutMs: number): Promise<boolean> {
    const code = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    return code;
  }

  async stopAndWait(timeoutMs = 2000): Promise<void> {
    this.stop();
    await this.waitExit(timeoutMs);
  }

  stop(): void {
    if (!this.exited) {
      this.exited = true;
      this.closeStdin();
      this.signalGroup("SIGTERM");
      setTimeout(() => this.signalGroup("SIGKILL"), 500);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("worker stopped"));
      }
      this.pending.clear();
      return;
    }
    this.signalGroup("SIGKILL");
  }

  alive(): boolean {
    return !this.exited;
  }

  private write(text: string): void {
    try {
      const stdin = this.proc.stdin as unknown as { write?: (s: string) => unknown; flush?: () => void } | null;
      stdin?.write?.(text);
      stdin?.flush?.();
    } catch (error) {
      throw new Error(`worker write failed: ${(error as Error).message}`);
    }
  }

  private async stderrLoop(cwd: string): Promise<void> {
    try {
      for await (const chunk of this.proc.stderr as ReadableStream<Uint8Array>) {
        process.stderr.write(`[worker ${cwd}] ${this.stderrDecoder.decode(chunk, { stream: true })}`);
      }
    } catch {
      /* exit */
    }
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
        this.buffer += this.stdoutDecoder.decode(chunk, { stream: true });
        for (;;) {
          const idx = this.buffer.indexOf("\n");
          if (idx < 0) break;
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          this.handleLine(line);
        }
      }
    } catch {
      /* exit */
    }
    this.exited = true;
    this.readyReject(new Error("worker exited before ready"));
    this.exitResolve?.();
    this.exitResolve = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("worker exited"));
    }
    this.pending.clear();
    for (const cb of this.exitListeners) cb();
    this.exitListeners.clear();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    const decoded = decodeServerText(line);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.kind === "ready") {
      this.sessionId = frame.sessionId ?? "";
      this.epoch = frame.epoch ?? "";
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.readyResolve();
      return;
    }
    if (frame.kind === "snapshot") {
      this.snapshotWaiter?.(frame);
      this.snapshotWaiter = null;
      return;
    }
    if (frame.kind === "result") {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.data);
      else waiter.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
      return;
    }
    if (frame.kind === "event") {
      for (const cb of this.listeners) cb(frame);
    }
  }
}
