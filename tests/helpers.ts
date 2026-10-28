/**
 * tests/helpers.ts — stdio e2e 脚手架（文件名不带 .test，不会被 bun test 当用例收）。
 *
 * 职责：
 *  1. 临时目录：每个场景一个 root（work/home/sessions/mailbox/logs/memory），
 *     绝不读写真实 ~/.neo；测试结束 whole-dir 删除（KEEP_TMP=1 可保留排查）。
 *  2. fake LLM：PORT=0 起 scripts/fake-llm.ts，从 `FAKE_LLM_READY port=` 拿端口。
 *  3. core 子进程：`bun run src/main.ts serve --stdio`，cwd=work，NEO_* 全部重定向；
 *     stdout 按行解析协议帧（非 JSON 行单独记录，供「stdout 纯净」断言）。
 *  4. 帧工具：request/awaitFrame/awaitEvent/expectNoEvent/mark/since。
 *
 * 设计约束（见 docs/protocol-v1.md）：
 *  - 一行一帧；stderr 是日志，stdout 只能是帧。
 *  - ready 是首帧；事件帧 {kind:"event", seq, event}。
 *  - 测试失败信息必须能复现：diag() 汇总 stderr/未匹配帧/退出码。
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const MAIN_ENTRY = join(REPO_ROOT, "src", "main.ts");
export const FAKE_LLM_ENTRY = join(REPO_ROOT, "scripts", "fake-llm.ts");

/** settings.json 里的假 key；settings.get 掩码测试断言它不出现在任何回执里。 */
export const FAKE_API_KEY = "sk-fake-SECRET-abc123";
export const FAKE_MODEL = "fake-model";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值；超时报出 label + 最后一次抛错。 */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      const suffix = lastError ? `；最后一次错误：${String(lastError)}` : "";
      throw new Error(`等待超时（${timeoutMs}ms）：${opts.label ?? "条件未满足"}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ */
/* 临时目录 + 确定性 settings.json                                     */
/* ------------------------------------------------------------------ */

export interface TestDirs {
  root: string;
  work: string;
  home: string;
  sessions: string;
  mailbox: string;
  logs: string;
  memory: string;
  /** NEO_RUN_DIR：锁/token/core.json（WS 发现）都落这里，绝不碰真实 ~/.neo/run。 */
  run: string;
}

export async function makeDirs(name: string): Promise<TestDirs> {
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40);
  const root = await mkdtemp(join(tmpdir(), `matrix-core-${safe}-`));
  const dirs: TestDirs = {
    root,
    work: join(root, "work"),
    home: join(root, "home"),
    sessions: join(root, "sessions"),
    mailbox: join(root, "mailbox"),
    logs: join(root, "logs"),
    memory: join(root, "memory"),
    run: join(root, "run"),
  };
  for (const d of [dirs.work, dirs.home, dirs.sessions, dirs.mailbox, dirs.logs, dirs.memory, dirs.run]) {
    await mkdir(d, { recursive: true });
  }
  return dirs;
}

/** 确定性 settings.json：provider 指向 fake LLM；memory/env 关闭减少副作用。 */
export function fakeSettings(baseUrl: string): Record<string, unknown> {
  const model = FAKE_MODEL;
  return {
    default_provider: "fake",
    default_model_tier: "default",
    classifier_provider: "fake",
    classifier_model_name: model,
    providers: [
      {
        provider_name: "fake",
        provider_type: "openai",
        base_url: baseUrl,
        api_key: FAKE_API_KEY,
        default_model_name: model,
        deep_reasoning_model_name: model,
        balanced_model_name: model,
        fast_model_name: model,
        max_tokens: 2048,
        temperature: 0.2,
        context_window: 128000,
      },
    ],
    model_routes: {
      default: { provider: "fake", model },
      balanced: { provider: "fake", model },
      fast: { provider: "fake", model },
      deep_reasoning: { provider: "fake", model, fallback_allowed: true },
    },
    compact_threshold: 0.75,
    max_tool_iterations: 8,
    tool_output_limit: 4000,
    skills_extra_paths: [],
    shell: { path: null, login: false, args: null },
    env: { enabled: false, probe_ttl_hours: 1, prompt: false, wiki_page: false },
    retry: { max_attempts: 2, base_delay_ms: 30, connect_timeout_ms: 5000, stream_idle_timeout_ms: 30000 },
    show_reasoning: true,
    toolcall_info_details: true,
    memory: { enabled: false },
  };
}

export async function writeSettings(dirs: TestDirs, baseUrl: string): Promise<void> {
  await writeFile(join(dirs.work, "settings.json"), `${JSON.stringify(fakeSettings(baseUrl), null, 2)}\n`, "utf8");
}

/** 继承宿主环境但清掉所有测试注入变量，避免宿主 ~/.neo / 端口串味。 */
export function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("NEO_") || k.startsWith("MATRIX_CORE_")) continue;
    if (k === "COLUMNS" || k === "LINES") continue;
    env[k] = v;
  }
  return env;
}

/* ------------------------------------------------------------------ */
/* fake LLM                                                            */
/* ------------------------------------------------------------------ */

export type FakeScenario =
  | "tool-then-answer"
  | "narration"
  | "ask-user"
  | "ask-user-multi"
  | "write-then-answer"
  | "allow-session"
  | "slow"
  | "resume";

export interface FakeRequestRecord {
  at: number;
  scenario: string;
  messages: { role: string; content: string; toolCallId?: string; name?: string }[];
}

/** 把子进程流按块解成文本喂回调（流关闭即返回，不抛）。 */
async function pumpText(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onText(decoder.decode(value, { stream: true }));
    }
    onText(decoder.decode());
  } catch {
    /* 进程退出时流关闭 */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

export interface FakeLlm {
  readonly port: number;
  readonly scenario: FakeScenario;
  /** `http://127.0.0.1:<port>/v1`（NEO_BASE_URL 口径） */
  readonly baseUrl: string;
  readonly stderr: () => string;
  /** 已收到的请求（仅内存） */
  requests(): Promise<{ scenario: string; records: FakeRequestRecord[] }>;
  stop(): Promise<void>;
}

/** 起 fake LLM；PORT=0 自动分配，读懂 `FAKE_LLM_READY port=` 后才返回。 */
export async function startFakeLlm(
  scenario: FakeScenario,
  extraEnv: Record<string, string> = {},
): Promise<FakeLlm> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", FAKE_LLM_ENTRY],
    cwd: REPO_ROOT,
    env: { ...cleanBaseEnv(), PORT: "0", SCENARIO: scenario, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let outBuffer = "";
  let errBuffer = "";
  let port = 0;

  // 逐块读：假 LLM 只在启动后打印一行 READY，必须流式读，不能等流结束。
  const pumps = [
    pumpText(proc.stdout as ReadableStream<Uint8Array>, (t) => {
      outBuffer += t;
    }),
    pumpText(proc.stderr as ReadableStream<Uint8Array>, (t) => {
      errBuffer += t;
    }),
  ];
  const done = Promise.allSettled(pumps);

  try {
    await waitFor(
      () => {
        const m = /FAKE_LLM_READY port=(\d+)/.exec(outBuffer);
        if (m?.[1]) {
          port = Number(m[1]);
          return true;
        }
        return false;
      },
      { timeoutMs: 10000, intervalMs: 10, label: `fake LLM(${scenario}) 就绪` },
    );
  } catch (e) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([done, sleep(1000)]);
    throw new Error(`fake LLM 启动失败：${String(e)}\nstderr:\n${errBuffer}\nstdout:\n${outBuffer}`);
  }

  let stopped = false;
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    scenario,
    baseUrl: `${base}/v1`,
    stderr: () => errBuffer,
    async requests() {
      const res = await fetch(`${base}/_requests`);
      if (!res.ok) throw new Error(`fake LLM /_requests 失败：HTTP ${res.status}`);
      return (await res.json()) as { scenario: string; records: FakeRequestRecord[] };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const exitedWithin = (ms: number): Promise<boolean> =>
        Promise.race([proc.exited.then(() => true), sleep(ms).then(() => false)]);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      // 兜底：SIGTERM 被 SSE 连接/事件循环拖住时升级 SIGKILL，绝不留孤儿进程。
      if (!(await exitedWithin(2000))) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        await exitedWithin(2000);
      }
      await Promise.race([done, sleep(500)]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* core stdio 帧模型                                                    */
/* ------------------------------------------------------------------ */

export interface Frame {
  v: number;
  kind: string;
  id?: string;
  ok?: boolean;
  data?: any;
  error?: { code: string; message: string; retryable?: boolean };
  sessionId?: string;
  seq?: number;
  event?: any;
  snapshot?: any;
  sessions?: any[];
  settings?: any;
  records?: any[];
  totals?: any;
  range?: string;
  user?: any;
  coreVersion?: string;
  protocolVersion?: string;
  capabilities?: string[];
  epoch?: string;
}

export interface AwaitOpts {
  /** 从第几帧开始找（mark() 的返回值）；默认 0 = 全历史 */
  since?: number;
  timeoutMs?: number;
}

interface Waiter {
  pred: (frame: Frame) => boolean;
  since: number;
  label: string;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 帧等待器：stdio 与 WS 两条传输共用同一套语义。
 *  - since 之前的帧也参与匹配（事件常先于 await 到达）；
 *  - 超时/进程退出时给出带诊断的错误，避免测试只看到「超时」。
 */
export class FrameWaiters {
  private waiters: Waiter[] = [];

  constructor(
    private readonly frames: () => Frame[],
    private readonly diag: (since: number) => string,
  ) {}

  onFrame(frame: Frame): void {
    if (this.waiters.length === 0) return;
    const all = this.frames();
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      const matched = waiter.pred(frame) && all.length - 1 >= waiter.since;
      if (matched) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  rejectAll(message: string): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(`等待「${w.label}」失败：${message}`));
    }
  }

  awaitFrame(pred: (frame: Frame) => boolean, label: string, opts: AwaitOpts = {}): Promise<Frame> {
    const since = opts.since ?? 0;
    const timeoutMs = opts.timeoutMs ?? 15000;
    const all = this.frames();
    for (let i = since; i < all.length; i++) {
      const frame = all[i];
      if (frame && pred(frame)) return Promise.resolve(frame);
    }
    return new Promise<Frame>((res, rej) => {
      const waiter: Waiter = {
        pred,
        since,
        label,
        resolve: res,
        reject: rej,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          rej(new Error(`等待超时（${timeoutMs}ms）：${label}\n${this.diag(since)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** 等待「多个候选之一」先到（例如：下一个审批 or 本轮收口），不留下悬挂 waiter。 */
  awaitEither(
    specs: { label: string; pred: (frame: Frame) => boolean }[],
    opts: AwaitOpts = {},
  ): Promise<{ index: number; frame: Frame }> {
    const since = opts.since ?? 0;
    const timeoutMs = opts.timeoutMs ?? 15000;
    const anyPred = (frame: Frame): boolean => specs.some((s) => s.pred(frame));
    return this.awaitFrame(anyPred, specs.map((s) => s.label).join("|"), { since, timeoutMs }).then(
      (frame) => ({ index: specs.findIndex((s) => s.pred(frame)), frame }),
    );
  }
}

export interface CoreStartOptions {
  dirs: TestDirs;
  fake: FakeLlm;
  /** 额外参数，例如 ["--resume", sessionId] */
  args?: string[];
  /** 额外环境变量，例如 MATRIX_CORE_APPROVAL_TIMEOUT_MS */
  env?: Record<string, string>;
  /** 覆盖会话 cwd（默认 dirs.work） */
  cwd?: string;
  /** 覆盖被测入口（默认 src/main.ts）；仅供 harness 自检使用。 */
  entry?: string;
  timeoutMs?: number;
}

/** 起 core 的子进程参数（stdio 是默认传输方式；WS 用例自己拼 --port）。 */
export function coreSpawnArgs(opts: CoreStartOptions): string[] {
  return ["run", opts.entry ?? MAIN_ENTRY, "serve", "--stdio", ...(opts.args ?? [])];
}

/** 隔离环境：HOME/NEO_* 全部指向临时目录，绝不读写真实 ~/.neo。 */
export function coreSpawnEnv(opts: CoreStartOptions): Record<string, string> {
  return {
    ...cleanBaseEnv(),
    HOME: opts.dirs.home,
    NEO_BASE_URL: opts.fake.baseUrl,
    NEO_MODEL: FAKE_MODEL,
    NEO_API_KEY: FAKE_API_KEY,
    NEO_PROVIDER: "fake",
    NEO_TIER: "default",
    NEO_MEMORY_DISABLE: "1",
    NEO_SESSIONS_DIR: opts.dirs.sessions,
    NEO_MAILBOX_DIR: opts.dirs.mailbox,
    NEO_LOG_DIR: opts.dirs.logs,
    NEO_MEMORY_DIR: opts.dirs.memory,
    NEO_RUN_DIR: opts.dirs.run,
    ...(opts.env ?? {}),
  };
}

/** 起 core 并等它自己退出（用于「预期启动失败」：锁冲突 / 坏配置）。 */
export async function runCoreToExit(
  opts: CoreStartOptions & { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  await writeSettings(opts.dirs, opts.fake.baseUrl);
  const proc = Bun.spawn({
    cmd: [process.execPath, ...coreSpawnArgs(opts)],
    cwd: opts.cwd ?? opts.dirs.work,
    env: coreSpawnEnv(opts),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const pumps = [
    pumpText(proc.stdout as ReadableStream<Uint8Array>, (s) => {
      stdout += s;
    }),
    pumpText(proc.stderr as ReadableStream<Uint8Array>, (s) => {
      stderr += s;
    }),
  ];
  const timeoutMs = opts.timeoutMs ?? 15000;
  const code = await Promise.race([proc.exited, sleep(timeoutMs).then(() => null)]);
  if (code === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await Promise.race([Promise.allSettled(pumps), sleep(1000)]);
  return { code: code ?? -1, stdout, stderr };
}

export class StdioCore {
  readonly dirs: TestDirs;
  readonly fake: FakeLlm;
  readonly args: string[];
  /** 收到的全部已解析帧 */
  readonly frames: Frame[] = [];
  /** stdout 里不是 JSON 的行（协议违规；测试断言为空） */
  readonly nonJsonStdout: string[] = [];
  /** stderr 日志 */
  stderrText = "";
  exitCode: number | null = null;

  private readonly proc: ReturnType<typeof Bun.spawn>;
  private stdoutBuffer = "";
  private readonly waiters: FrameWaiters;
  private exited = false;
  private readonly exitPromise: Promise<number>;
  private readonly pumps: Promise<void>[] = [];

  private constructor(proc: ReturnType<typeof Bun.spawn>, opts: CoreStartOptions) {
    this.proc = proc;
    this.dirs = opts.dirs;
    this.fake = opts.fake;
    this.args = opts.args ?? [];
    this.waiters = new FrameWaiters(
      () => this.frames,
      (since) => this.diag(since),
    );
    this.exitPromise = proc.exited.then((code: number) => {
      this.exitCode = code;
      this.exited = true;
      this.flushStdoutBuffer();
      this.waiters.rejectAll(`core 进程退出（exit=${String(code)}）\n${this.diag()}`);
      return code;
    }) as Promise<number>;
    this.pumps.push(this.pumpStdout(), this.pumpStderr());
  }

  static async start(opts: CoreStartOptions): Promise<StdioCore> {
    await writeSettings(opts.dirs, opts.fake.baseUrl);
    const proc = Bun.spawn({
      cmd: [process.execPath, ...coreSpawnArgs(opts)],
      cwd: opts.cwd ?? opts.dirs.work,
      env: coreSpawnEnv(opts),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const core = new StdioCore(proc, opts);
    await core.ready(opts.timeoutMs ?? 20000);
    return core;
  }

  /* ---------------------------- 帧读取 ---------------------------- */

  private async pumpStdout(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.onStdoutText(decoder.decode(value, { stream: true }));
      }
      this.onStdoutText(decoder.decode());
    } catch {
      /* 进程退出时流关闭 */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.stderrText += decoder.decode(value, { stream: true });
      }
      this.stderrText += decoder.decode();
    } catch {
      /* 进程退出时流关闭 */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private onStdoutText(text: string): void {
    this.stdoutBuffer += text;
    for (;;) {
      const i = this.stdoutBuffer.indexOf("\n");
      if (i < 0) break;
      const line = this.stdoutBuffer.slice(0, i).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(i + 1);
      if (line !== "") this.onStdoutLine(line);
    }
  }

  private flushStdoutBuffer(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (line !== "") this.onStdoutLine(line);
  }

  private onStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.nonJsonStdout.push(line);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.nonJsonStdout.push(line);
      return;
    }
    const frame = parsed as Frame;
    this.frames.push(frame);
    this.waiters.onFrame(frame);
  }

  /* ---------------------------- 等待工具 ---------------------------- */

  mark(): number {
    return this.frames.length;
  }

  framesSince(mark: number): Frame[] {
    return this.frames.slice(mark);
  }

  /** 等待第一个满足谓词的帧；since 之前的帧也会被检查（默认全历史）。 */
  awaitFrame(pred: (frame: Frame) => boolean, label: string, opts: AwaitOpts = {}): Promise<Frame> {
    return this.waiters.awaitFrame(pred, label, opts);
  }

  /** 等「多个候选之一」先到（不留下悬挂 waiter）。 */
  awaitEither(
    specs: { label: string; pred: (frame: Frame) => boolean }[],
    opts: AwaitOpts = {},
  ): Promise<{ index: number; frame: Frame }> {
    return this.waiters.awaitEither(specs, opts);
  }

  /** 等待指定 type 的事件帧（event.type）。 */
  awaitEvent(
    type: string,
    pred?: (event: any, frame: Frame) => boolean,
    opts: AwaitOpts = {},
  ): Promise<Frame> {
    return this.awaitFrame(
      (f) => f.kind === "event" && f.event?.type === type && (pred ? pred(f.event, f) : true),
      `event:${type}`,
      opts,
    );
  }

  /** 等窗口后断言没有出现某事件（用于 stats/turn.aborted 互斥等）。 */
  async expectNoEvent(type: string, opts: AwaitOpts & { windowMs?: number } = {}): Promise<void> {
    const since = opts.since ?? 0;
    const windowMs = opts.windowMs ?? 800;
    await sleep(windowMs);
    const hit = this.framesSince(since).find((f) => f.kind === "event" && f.event?.type === type);
    if (hit) {
      throw new Error(`不应出现的 ${type} 事件出现了：${JSON.stringify(hit.event)}\n${this.diag(since)}`);
    }
  }

  eventsSince(mark: number, type?: string): Frame[] {
    return this.framesSince(mark).filter(
      (f) => f.kind === "event" && (type ? f.event?.type === type : true),
    );
  }

  /* ---------------------------- 命令发送 ---------------------------- */

  private idSeq = 0;

  /** 发一条命令帧，返回 id（不等回执）。 */
  send(command: Record<string, unknown>): string {
    const id = `c${++this.idSeq}`;
    this.write({ v: 1, kind: "command", id, command });
    return id;
  }

  /** 发命令并等对应 result 回执（ok 或失败都返回）。 */
  async request(
    command: Record<string, unknown>,
    opts: AwaitOpts = {},
  ): Promise<Frame> {
    const id = this.send(command);
    return this.awaitResult(id, opts);
  }

  async awaitResult(id: string, opts: AwaitOpts = {}): Promise<Frame> {
    return this.awaitFrame(
      (f) => f.kind === "result" && f.id === id,
      `result:${id}`,
      { timeoutMs: 20000, ...opts },
    );
  }

  /** request 且要求 ok:true，失败直接抛错（带 error 与诊断）。 */
  async requestOk(
    command: Record<string, unknown>,
    opts: AwaitOpts = {},
  ): Promise<Frame> {
    const frame = await this.request(command, opts);
    if (frame.ok !== true) {
      throw new Error(
        `命令 ${String(command["type"])} 失败：${JSON.stringify(frame.error)}\n${this.diag()}`,
      );
    }
    return frame;
  }

  /** 发 turn.send 并等首个 turn.start（返回 turnId）。 */
  async startTurn(text: string, opts: { clientId?: string } = {}): Promise<{ turnId: string; frame: Frame }> {
    const mark = this.mark();
    await this.requestOk(
      { type: "turn.send", text, clientId: opts.clientId ?? `cli-${Math.random().toString(36).slice(2, 10)}` },
      { since: mark },
    );
    const frame = await this.awaitEvent("turn.start", undefined, { since: mark });
    return { turnId: frame.event.turnId as string, frame };
  }

  /** 等整轮收口：stats 或 turn.aborted 先到者。 */
  async awaitTurnEnd(since: number, timeoutMs = 20000): Promise<Frame> {
    return this.awaitFrame(
      (f) => f.kind === "event" && (f.event?.type === "stats" || f.event?.type === "turn.aborted"),
      "turn 终态(stats|turn.aborted)",
      { since, timeoutMs },
    );
  }

  /** ready 帧 */
  ready(timeoutMs = 20000): Promise<Frame> {
    return this.awaitFrame((f) => f.kind === "ready", "ready", { timeoutMs });
  }

  /* ---------------------------- 关闭 ---------------------------- */

  /** bun 的 spawn 返回类型把 stdin 推成 `number | FileSink`，这里统一窄化一次。 */
  private stdinSink(): { write(text: string): void; end(): void } {
    return this.proc.stdin as unknown as { write(text: string): void; end(): void };
  }

  private write(msg: unknown): void {
    if (this.exited) throw new Error(`core 已退出，无法写帧\n${this.diag()}`);
    try {
      this.stdinSink().write(`${JSON.stringify(msg)}\n`);
    } catch (e) {
      throw new Error(`写帧失败：${String(e)}\n${this.diag()}`);
    }
  }

  /** 直接发信号（用于 SIGTERM/SIGINT 的中断语义测试）。 */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.proc.kill(signal);
    } catch {
      /* 进程已退出 */
    }
  }

  /** 等进程退出；超时升级 SIGKILL 并返回 -1。 */
  async waitExit(timeoutMs = 10000): Promise<number> {
    const code = await Promise.race([this.exitPromise, sleep(timeoutMs).then(() => null)]);
    if (code === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await Promise.race([this.exitPromise, sleep(2000)]);
    }
    await Promise.race([Promise.allSettled(this.pumps), sleep(1000)]);
    return this.exitCode ?? -1;
  }

  /** 关 stdin（EOF）触发优雅关闭；超时则 SIGTERM/SIGKILL。 */
  async close(timeoutMs = 10000): Promise<number> {
    if (this.exited) {
      await Promise.allSettled(this.pumps);
      return this.exitCode ?? 0;
    }
    try {
      this.stdinSink().end();
    } catch {
      /* ignore */
    }
    const code = await Promise.race([this.exitPromise, sleep(timeoutMs).then(() => null)]);
    if (code === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const afterTerm = await Promise.race([this.exitPromise, sleep(3000).then(() => null)]);
      if (afterTerm === null) {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    await Promise.race([Promise.allSettled(this.pumps), sleep(3000)]);
    this.flushStdoutBuffer();
    return this.exitCode ?? 0;
  }

  /** 失败诊断：stderr + 最近帧 + 非 JSON stdout。 */
  diag(since = 0): string {
    const tail = this.framesSince(since).slice(-25).map((f) => JSON.stringify(f));
    const stderrTail = this.stderrText.split("\n").slice(-25).join("\n");
    return [
      `── core 诊断（cwd=${this.dirs.work}）──`,
      `exitCode=${String(this.exitCode)}`,
      `stderr(尾部):\n${stderrTail || "(空)"}`,
      `stdout 非 JSON 行: ${this.nonJsonStdout.length ? JSON.stringify(this.nonJsonStdout.slice(-5)) : "(无)"}`,
      `最近帧(${tail.length}):\n${tail.join("\n") || "(无)"}`,
    ].join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* WS 传输（非 stdio）：握手 / 鉴权 / 帧收发                           */
/* ------------------------------------------------------------------ */

export interface WsConnectOptions {
  url: string;
  token: string;
  /** 默认 ["neo.v1", "bearer.<token>"]（协议 §2 子协议） */
  protocols?: string[];
  timeoutMs?: number;
}

/** WS 客户端：帧语义与 StdioCore 一致（共用 FrameWaiters）。 */
export class WsClient {
  readonly frames: Frame[] = [];
  readonly nonJsonMessages: string[] = [];
  readonly url: string;
  closeInfo: { code: number; reason: string } | null = null;

  private readonly ws: WebSocket;
  private readonly waiters: FrameWaiters;
  private readonly closed: Promise<void>;
  private resolveClosed: () => void = () => {};
  private idSeq = 0;

  private constructor(ws: WebSocket, url: string) {
    this.ws = ws;
    this.url = url;
    this.closed = new Promise<void>((res) => {
      this.resolveClosed = res;
    });
    this.waiters = new FrameWaiters(
      () => this.frames,
      (since) => this.diag(since),
    );
    ws.addEventListener("message", (ev: MessageEvent) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.nonJsonMessages.push(text);
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        this.nonJsonMessages.push(text);
        return;
      }
      const frame = parsed as Frame;
      this.frames.push(frame);
      this.waiters.onFrame(frame);
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      this.closeInfo = { code: ev.code, reason: ev.reason };
      this.waiters.rejectAll(`WS 已关闭（code=${ev.code} ${ev.reason || ""}）\n${this.diag()}`);
      this.resolveClosed();
    });
  }

  static connect(opts: WsConnectOptions): Promise<WsClient> {
    const protocols = opts.protocols ?? ["neo.v1", `bearer.${opts.token}`];
    const ws = new WebSocket(opts.url, protocols);
    const client = new WsClient(ws, opts.url);
    return new Promise<WsClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WS 连接超时（${opts.timeoutMs ?? 15000}ms）：${opts.url}`));
      }, opts.timeoutMs ?? 15000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(client);
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`WS 连接失败（握手被拒）：${opts.url}`));
        },
        { once: true },
      );
    });
  }

  mark(): number {
    return this.frames.length;
  }

  framesSince(mark: number): Frame[] {
    return this.frames.slice(mark);
  }

  eventsSince(mark: number, type?: string): Frame[] {
    return this.framesSince(mark).filter((f) => f.kind === "event" && (type ? f.event?.type === type : true));
  }

  awaitFrame(pred: (frame: Frame) => boolean, label: string, opts: AwaitOpts = {}): Promise<Frame> {
    return this.waiters.awaitFrame(pred, label, opts);
  }

  awaitEither(
    specs: { label: string; pred: (frame: Frame) => boolean }[],
    opts: AwaitOpts = {},
  ): Promise<{ index: number; frame: Frame }> {
    return this.waiters.awaitEither(specs, opts);
  }

  awaitEvent(type: string, pred?: (event: any, frame: Frame) => boolean, opts: AwaitOpts = {}): Promise<Frame> {
    return this.awaitFrame(
      (f) => f.kind === "event" && f.event?.type === type && (pred ? pred(f.event, f) : true),
      `event:${type}`,
      opts,
    );
  }

  send(command: Record<string, unknown>): string {
    const id = `w${++this.idSeq}`;
    this.ws.send(JSON.stringify({ v: 1, kind: "command", id, command }));
    return id;
  }

  async awaitResult(id: string, opts: AwaitOpts = {}): Promise<Frame> {
    return this.awaitFrame((f) => f.kind === "result" && f.id === id, `result:${id}`, {
      timeoutMs: 20000,
      ...opts,
    });
  }

  async request(command: Record<string, unknown>, opts: AwaitOpts = {}): Promise<Frame> {
    return this.awaitResult(this.send(command), opts);
  }

  async requestOk(command: Record<string, unknown>, opts: AwaitOpts = {}): Promise<Frame> {
    const frame = await this.request(command, opts);
    if (frame.ok !== true) {
      throw new Error(`命令 ${String(command["type"])} 失败：${JSON.stringify(frame.error)}\n${this.diag()}`);
    }
    return frame;
  }

  /** 等整轮收口：stats 或 turn.aborted 先到者。 */
  awaitTurnEnd(since: number, timeoutMs = 20000): Promise<Frame> {
    return this.awaitFrame(
      (f) => f.kind === "event" && (f.event?.type === "stats" || f.event?.type === "turn.aborted"),
      "turn 终态(stats|turn.aborted)",
      { since, timeoutMs },
    );
  }

  ready(timeoutMs = 15000): Promise<Frame> {
    return this.awaitFrame((f) => f.kind === "ready", "ready", { timeoutMs });
  }

  async close(timeoutMs = 5000): Promise<void> {
    if (this.closeInfo) return;
    try {
      this.ws.close(1000, "test done");
    } catch {
      /* ignore */
    }
    await Promise.race([this.closed, sleep(timeoutMs)]);
  }

  diag(since = 0): string {
    const tail = this.framesSince(since).slice(-20).map((f) => JSON.stringify(f));
    return [
      `── ws 诊断（${this.url}）──`,
      `close=${this.closeInfo ? `${this.closeInfo.code} ${this.closeInfo.reason}` : "(open)"}`,
      `非 JSON 消息: ${this.nonJsonMessages.length ? JSON.stringify(this.nonJsonMessages.slice(-3)) : "(无)"}`,
      `最近帧(${tail.length}):\n${tail.join("\n") || "(无)"}`,
    ].join("\n");
  }
}

/** 预期握手失败（坏 token）：等 error 或 close，成功 open 反而算测试失败。 */
export function connectWsExpectFailure(opts: {
  url: string;
  token: string;
  protocols?: string[];
  timeoutMs?: number;
}): Promise<{ kind: "error" | "close"; code?: number; reason?: string }> {
  const protocols = opts.protocols ?? ["neo.v1", `bearer.${opts.token}`];
  const ws = new WebSocket(opts.url, protocols);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("预期握手失败，但既没有 error 也没有 close"));
    }, opts.timeoutMs ?? 10000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("坏 token 竟然握手成功（鉴权未生效）"));
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        resolve({ kind: "error" });
      },
      { once: true },
    );
    ws.addEventListener(
      "close",
      (ev: CloseEvent) => {
        clearTimeout(timer);
        resolve({ kind: "close", code: ev.code, reason: ev.reason });
      },
      { once: true },
    );
  });
}

export interface WsRunInfo {
  url: string;
  pid: number;
  tokenFile: string;
  sessionId: string;
  epoch: string;
  startedAt?: string;
}

export interface WsCore {
  readonly dirs: TestDirs;
  readonly fake: FakeLlm;
  readonly runInfo: WsRunInfo;
  readonly coreJsonPath: string;
  readToken(): Promise<string>;
  stderr(): string;
  waitExit(timeoutMs?: number): Promise<number>;
  stop(): Promise<number>;
}

/** 起 WS 模式 core（`serve --port 0`），等 core.json 落盘后返回发现信息。 */
export async function startWsCore(opts: CoreStartOptions): Promise<WsCore> {
  await writeSettings(opts.dirs, opts.fake.baseUrl);
  const cwd = opts.cwd ?? opts.dirs.work;
  const cmd = [
    process.execPath,
    "run",
    opts.entry ?? MAIN_ENTRY,
    "serve",
    "--port",
    "0",
    "--cwd",
    cwd,
    ...(opts.args ?? []),
  ];
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: coreSpawnEnv(opts),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  let stdout = "";
  const pumps = [
    pumpText(proc.stderr as ReadableStream<Uint8Array>, (s) => {
      stderr += s;
    }),
    pumpText(proc.stdout as ReadableStream<Uint8Array>, (s) => {
      stdout += s;
    }),
  ];
  const coreJsonPath = join(opts.dirs.run, "core.json");
  try {
    await waitFor(() => existsSync(coreJsonPath), {
      timeoutMs: opts.timeoutMs ?? 20000,
      intervalMs: 25,
      label: "core.json（WS 启动发现文件）",
    });
  } catch (e) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw new Error(`${String(e)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const runInfo = JSON.parse(await readFile(coreJsonPath, "utf8")) as WsRunInfo;

  const waitExit = async (timeoutMs = 10000): Promise<number> => {
    const code = await Promise.race([proc.exited, sleep(timeoutMs).then(() => null)]);
    if (code === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await Promise.race([proc.exited, sleep(2000)]);
    }
    return code ?? -1;
  };

  return {
    dirs: opts.dirs,
    fake: opts.fake,
    runInfo,
    coreJsonPath,
    async readToken() {
      return (await readFile(runInfo.tokenFile, "utf8")).trim();
    },
    stderr: () => stderr,
    waitExit,
    async stop() {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const code = await waitExit();
      await Promise.race([Promise.allSettled(pumps), sleep(1000)]);
      return code;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 场景包装：dirs + fake LLM + core 生命周期                            */
/* ------------------------------------------------------------------ */

export interface TestEnvOptions {
  scenario?: FakeScenario;
  /** core 额外参数（如 --resume） */
  args?: string[];
  /** core 额外 env（如 MATRIX_CORE_APPROVAL_TIMEOUT_MS） */
  env?: Record<string, string>;
}

export class TestEnv {
  readonly dirs: TestDirs;
  readonly fake: FakeLlm;
  readonly options: TestEnvOptions;
  private core: StdioCore | null = null;
  private cores: StdioCore[] = [];

  private constructor(dirs: TestDirs, fake: FakeLlm, options: TestEnvOptions) {
    this.dirs = dirs;
    this.fake = fake;
    this.options = options;
  }

  static async create(name: string, options: TestEnvOptions = {}): Promise<TestEnv> {
    const dirs = await makeDirs(name);
    const fake = await startFakeLlm(options.scenario ?? "tool-then-answer");
    return new TestEnv(dirs, fake, options);
  }

  /** 起（或重起）core；旧 core 若还活着会被优雅关掉。 */
  async startCore(overrides: { args?: string[]; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<StdioCore> {
    if (this.core) await this.core.close();
    const core = await StdioCore.start({
      dirs: this.dirs,
      fake: this.fake,
      args: overrides.args ?? this.options.args,
      env: { ...(this.options.env ?? {}), ...(overrides.env ?? {}) },
      timeoutMs: overrides.timeoutMs,
    });
    this.core = core;
    this.cores.push(core);
    return core;
  }

  /** 当前 core（未启动则抛错）。 */
  requireCore(): StdioCore {
    if (!this.core) throw new Error("core 尚未启动：先 await env.startCore()");
    return this.core;
  }

  async stopCore(): Promise<void> {
    if (!this.core) return;
    const core = this.core;
    this.core = null;
    await core.close();
  }

  /** 关 core + fake LLM + 删临时目录；KEEP_TMP=1 时保留目录并打印路径。 */
  async dispose(): Promise<void> {
    for (const core of this.cores) {
      try {
        await core.close();
      } catch {
        /* ignore */
      }
    }
    this.cores = [];
    this.core = null;
    await this.fake.stop();
    if (process.env["KEEP_TMP"] === "1") {
      console.error(`[tests] 保留临时目录：${this.dirs.root}`);
      return;
    }
    await rm(this.dirs.root, { recursive: true, force: true });
  }
}

/** 一个测试一个场景的样板：自动 dispose。 */
export async function withEnv(
  name: string,
  options: TestEnvOptions,
  fn: (env: TestEnv) => Promise<void>,
): Promise<void> {
  const env = await TestEnv.create(name, options);
  try {
    await fn(env);
  } finally {
    await env.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 服务可用性探测（实现未就绪时 skip，不阻塞）                          */
/* ------------------------------------------------------------------ */

let availabilityPromise: Promise<boolean> | null = null;

/**
 * `serve --stdio` 是否已实现并可用。
 * 结果缓存（同一进程内只探测一次）；探测用临时目录 + fake LLM，不碰真实 ~/.neo。
 */
export function serveStdioAvailable(): Promise<boolean> {
  availabilityPromise ??= probeServe();
  return availabilityPromise;
}

async function probeServe(): Promise<boolean> {
  // 快速路径：main.ts 还没接线 serve 子命令时直接判否（省一次子进程）。
  try {
    const mainSource = await readFile(MAIN_ENTRY, "utf8");
    if (!/case\s+"serve"/.test(mainSource)) return false;
    if (!existsSync(join(REPO_ROOT, "src", "core", "session-host.ts"))) return false;
  } catch {
    return false;
  }
  let env: TestEnv | null = null;
  try {
    env = await TestEnv.create("probe", { scenario: "tool-then-answer" });
    const core = await env.startCore({ timeoutMs: 20000 });
    await core.close(5000);
    return true;
  } catch {
    return false;
  } finally {
    if (env) await env.dispose().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* transcript 探测（分布/格式由 core 决定，测试按实际文件取证）           */
/* ------------------------------------------------------------------ */

/** 递归找某会话的 transcript .ndjson 文件（布局变动的容错）。 */
export async function findTranscript(dirs: TestDirs, sessionId: string): Promise<string | null> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ndjson")) hits.push(full);
    }
  };
  await walk(dirs.root);
  if (hits.length === 0) return null;
  const named = hits.find((p) => p.includes(sessionId));
  if (named) return named;
  for (const p of hits) {
    try {
      if ((await readFile(p, "utf8")).includes(sessionId)) return p;
    } catch {
      /* ignore */
    }
  }
  return hits[0] ?? null;
}

/** 读 transcript 全部行（不解析的坏行原样保留在 raw 里）。 */
export async function readTranscriptLines(
  path: string,
): Promise<{ raw: string; parsed: Record<string, any> | null }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((raw) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        return { raw, parsed: typeof parsed === "object" && parsed !== null ? parsed : null };
      } catch {
        return { raw, parsed: null };
      }
    });
}

/** 从一行 transcript 里取事件对象（兼容 {type,seq,...} 与 {seq,event:{type,...}} 两种写法）。 */
export function transcriptEventOf(parsed: Record<string, any> | null): Record<string, any> | null {
  if (!parsed) return null;
  if (typeof parsed["event"] === "object" && parsed["event"] !== null) {
    return parsed["event"] as Record<string, any>;
  }
  if (typeof parsed["type"] === "string") return parsed;
  return null;
}
