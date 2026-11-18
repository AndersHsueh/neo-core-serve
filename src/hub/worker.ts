/**
 * hub/worker.ts — 每会话一个 `matrix-core serve --stdio` 子进程。
 *
 * Hub 不跑 Agent；只做进程管理 + 帧转发。worker 的 stdout 只出协议帧，stderr 转发到 hub stderr。
 */
import { join } from "node:path";
import { decodeServerText } from "../protocol/guards.ts";
import type { ClientCommand, ServerMessage } from "../protocol/types.ts";

/** Never fall back to a positive PID: it may belong to an unrelated generation. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals | number): "sent" | "gone" | "failed" {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  try { process.kill(-pid, signal); return "sent"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "failed"; }
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

/**
 * 活着的 worker 进程组表（key = worker pid，即组 id）。
 * worker 意外退出后仍保留条目：Hub 停止时必须回收整组（含 shell 孙进程），
 * 不能因为 onExit 把 worker 从会话表删掉就丢掉 PGID 引用。
 */
const liveGroups = new Map<number, WorkerClient>();

/** 当前仍被追踪的 worker 进程组（含已退出但组可能未清空的）。 */
export function trackedWorkerGroups(): WorkerClient[] {
  return [...liveGroups.values()];
}

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

  private stopping = false;
  private exitNotified = false;
  private groupDone = false;
  private termSent = false;
  private cleanupPromise: Promise<void> | null = null;

  private constructor(proc: ReturnType<typeof Bun.spawn>, cwd: string) {
    this.proc = proc;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
    void proc.exited.then(() => this.finishExit());
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
    // 立即登记到进程组表：ready 之前（或 ready 失败）也必须能被 shutdown 收口。
    client.track();
    try {
      await client.ready;
      if (!client.sessionId) throw new Error("worker ready without sessionId");
      return client;
    } catch (error) {
      // 启动失败：回收整组（ready 前崩溃的 worker 也可能已 fork 出 shell 孙进程）。
      await client.cleanupGroup();
      throw error;
    }
  }

  /** 登记进进程组表（Hub 用它保证「spawn 过就一定被追踪」）。 */
  private tracked = false;
  track(): void {
    if (this.tracked) return;
    this.tracked = true;
    liveGroups.set(this.proc.pid, this);
  }

  untrack(): void {
    if (!this.tracked) return;
    this.tracked = false;
    if (liveGroups.get(this.proc.pid) === this) liveGroups.delete(this.proc.pid);
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
    if (!this.alive()) throw new Error("worker exited");
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
    if (!this.alive()) throw new Error("worker exited");
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
    if (this.groupDone || ((signal === "SIGTERM" || signal === 15) && this.termSent)) return;
    const result = killProcessGroup(this.proc.pid, signal);
    if (result === "failed") throw new Error(`worker group ${this.proc.pid}: ${signal} failed`);
    if (signal === "SIGTERM" || signal === 15) this.termSent = true;
    if (result === "gone" || signal === "SIGKILL" || signal === 9) this.groupDone = true;
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
    await this.cleanupGroup();
    await this.waitExit(timeoutMs);
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.closeStdin();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("worker stopped")); }
    this.pending.clear();
    void this.cleanupGroup().catch((e) => process.stderr.write(`[hub] cleanup: ${String(e)}\n`));
  }

  /** Keep the group reference through TERM/KILL, even when the leader has died. */
  private cleanupGroup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.signalGroup("SIGTERM");
      if (!this.groupDone) await new Promise<void>((r) => setTimeout(r, 500));
      this.signalGroup("SIGKILL");
      this.untrack();
    })();
    return this.cleanupPromise;
  }

  alive(): boolean { return !this.exited && !this.stopping; }

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
    this.finishExit();
  }

  private finishExit(): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.exited = true;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
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
    void this.cleanupGroup().catch((e) => process.stderr.write(`[hub] cleanup: ${String(e)}\n`));
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
