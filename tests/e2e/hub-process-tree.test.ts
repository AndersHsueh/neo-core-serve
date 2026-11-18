/**
 * tests/e2e/hub-process-tree.test.ts — Hub 停止时「worker → shell → 孙进程」整条链的回收。
 *
 * 背景（为什么重写）：旧的 `daemon.test.ts`「SIGTERM hub 之后，worker 和孙进程不再写盘」
 * 是**假阳性**——
 *   1. 它靠 `MATRIX_CORE_WORKER_ARGS=--mode auto-all` 绕过审批，并且只等一个
 *      `tool.*` 事件就当作「shell 已经起来了」；任意 tool 事件（甚至 tool.start 之前的
 *      审批/规划事件）都可能在进程真正 spawn 之前到达，于是「孙进程没写 marker」既可能
 *      因为进程被杀，也可能因为进程压根没起来。
 *   2. 它用固定 `sleep(400)` / `sleep(7000)` 猜时序，没有 ready 握手，也没有观测 pid。
 *
 * 本文件的做法：
 *  - 走真实审批：显式等 `approval.request(tool=shell)` 再 `approval.resolve allow`，
 *    **不**用 auto-all 之类的环境变量（否则测的就不是默认路径了）。
 *  - 进程链用 pid 文件 + `ps -o pid=,ppid=,pgid=,stat=` 取证：
 *      worker（Hub 的 serve --stdio 子进程）
 *        └─ shell（工具子 shell，写 shell.pid + worker.pid=PPID）
 *             └─ grandchild（spawn /bin/sh grandchild-probe.sh，写 grandchild.pid + ready）
 *    孙进程等 gate 文件出现才写 marker；父 shell `wait` 孙进程。
 *  - 每个用例都等 ready 文件（带超时），不靠 sleep 猜启动。
 *  - 存活判据排除 `ps` 的 Z（zombie）状态。
 *  - 任何失败都在 finally 里用「已捕获的正 pid」逐个 SIGKILL（不按进程组杀，避免误伤
 *    测试进程组），再关客户端 / Hub / TestEnv。
 *
 * 三个用例：
 *  1. 不停 Hub：放 gate → 必须出现 marker（正向对照，证明整条链真的跑起来了）。
 *  2. 就绪后 SIGTERM Hub：等 hub.stop，观测三个 pid 存活状态并打日志，再放 gate；
 *     若孙进程仍活则等 marker 并记录；最后断言三者均不存活且 marker 不存在。
 *  3. 同 2，但孙进程把 SIGTERM 设成空 trap：验证 Hub 的 SIGKILL 兜底。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TestEnv,
  WsClient,
  serveStdioAvailable,
  sleep,
  startHub,
  waitFor,
  type HubCore,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/hub-process-tree] serve 尚未可用：已跳过");

const TIMEOUT = 120000;
/** 等 ready / 等 marker / 等进程消失的明确超时（不靠 sleep 猜启动）。 */
const READY_TIMEOUT_MS = 30000;
const MARKER_TIMEOUT_MS = 10000;
const GONE_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* 探针脚本（写在临时 cwd 里，不碰仓库）                                */
/* ------------------------------------------------------------------ */

/**
 * probe.sh —— **工具子 shell 本身**（由 core 的 shell 工具 spawn）。
 * 写 shell.pid 与 worker.pid（= PPID，即 serve --stdio worker 进程）。
 * 然后 spawn 孙进程，并 `wait` 它。
 */
const PROBE_SH = `#!/bin/sh
# 由 core 的 shell 工具执行（工具子 shell）。
# 注意：登录 shell 可能注入 PATH preamble，所以这里不依赖 set -e 的严格性。
echo $$ > shell.pid
# 工具子 shell 的父进程就是 worker（serve --stdio）。
ps -o ppid= -p $$ | tr -d ' ' > worker.pid
/bin/sh grandchild-probe.sh &
child=$!
wait "$child"
echo "probe-done" > probe.done
`;

/**
 * grandchild-probe.sh —— 孙进程。
 * 写 grandchild.pid 与 ready；等 gate 文件出现才写 marker。
 * 用例 3 会传入 trap 变体（把 SIGTERM 设成空 trap）。
 */
function grandchildScript(opts: { ignoreTerm: boolean }): string {
  const trapLine = opts.ignoreTerm
    ? "trap '' TERM\n"
    : "trap 'echo term > grandchild.term; exit 143' TERM\n";
  return `#!/bin/sh
# 孙进程：先报到，再等 gate；gate 出现才写 marker。
echo $$ > grandchild.pid
${trapLine}echo ready > grandchild.ready
i=0
while [ ! -f gate ]; do
  i=$((i + 1))
  if [ "$i" -gt 12000 ]; then
    echo "gate-timeout" > grandchild.timeout
    exit 124
  fi
  sleep 0.05
done
echo "grandchild-ran" > marker.txt
`;
}

/* ------------------------------------------------------------------ */
/* ps 取证                                                             */
/* ------------------------------------------------------------------ */

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
}

/** `ps -o pid=,ppid=,pgid=,stat= -p <pid>`；进程不存在返回 null。 */
async function psRow(pid: number): Promise<PsRow | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let proc;
  try {
    proc = Bun.spawn({
      cmd: ["ps", "-o", "pid=,ppid=,pgid=,stat=", "-p", String(pid)],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return null;
  const parts = out.split(/\s+/);
  const pidNum = Number(parts[0]);
  const ppidNum = Number(parts[1]);
  const pgidNum = Number(parts[2]);
  const stat = parts[3] ?? "";
  if (!Number.isInteger(pidNum) || !Number.isInteger(ppidNum) || !Number.isInteger(pgidNum)) return null;
  return { pid: pidNum, ppid: ppidNum, pgid: pgidNum, stat };
}

/** 存活判据：ps 有行，且状态首字母不是 Z（zombie 视为已死）。 */
function isAlive(row: PsRow | null): boolean {
  if (!row) return false;
  return row.stat.charAt(0) !== "Z";
}

/** 打一行 JSON 日志（不含 token；只含 pid/ppid/pgid/stat）。 */
function logRow(label: string, row: PsRow | null): void {
  const payload = row
    ? { phase: label, pid: row.pid, ppid: row.ppid, pgid: row.pgid, stat: row.stat, alive: isAlive(row) }
    : { phase: label, pid: null, ppid: null, pgid: null, stat: null, alive: false };
  console.log(`[hub-process-tree] ${JSON.stringify(payload)}`);
}

/** 轮询直到 pid 不再存活（排除 Z）；超时返回最后一次观测。 */
async function waitGone(pid: number, label: string, timeoutMs = GONE_TIMEOUT_MS): Promise<PsRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await psRow(pid);
    if (!isAlive(row)) return row;
    if (Date.now() > deadline) return row;
    await sleep(50);
  }
}

/** 读 pid 文件（内容必须是正整数）。 */
async function readPidFile(path: string, label: string): Promise<number> {
  return await waitFor(
    async () => {
      const text = (await readFile(path, "utf8")).trim();
      const n = Number(text);
      return Number.isInteger(n) && n > 0 ? n : 0;
    },
    { timeoutMs: READY_TIMEOUT_MS, intervalMs: 25, label },
  );
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe.skipIf(!available)("Hub 停止：worker → shell → 孙进程回收", () => {
  let env: TestEnv | null = null;
  let hub: HubCore | null = null;
  let client: WsClient | null = null;
  /** 已捕获的每个正 pid：finally 里逐个 SIGKILL（不按进程组杀）。 */
  const captured = new Set<number>();

  afterEach(async () => {
    // 1) 先按已捕获 pid 清理（失败路径也要跑）。
    for (const pid of captured) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const row = await psRow(pid);
      if (!isAlive(row)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已经没了 */
      }
    }
    captured.clear();
    // 2) 关客户端 / Hub / TestEnv。
    const c = client;
    client = null;
    if (c) await c.close().catch(() => {});
    const h = hub;
    hub = null;
    if (h) await h.stop().catch(() => {});
    const current = env;
    env = null;
    if (current) await current.dispose().catch(() => {});
  });

  /**
   * 公共前置：起 Hub（默认 ask 模式，**不**注入 auto-all）→ 建会话 → attach →
   * 发一轮 → 显式审批 shell → 等孙进程 ready → ps 取证整条链。
   */
  async function startChain(name: string, opts: { ignoreTerm: boolean }): Promise<{
    dirs: TestEnv["dirs"];
    sessionId: string;
    workerPid: number;
    shellPid: number;
    grandchildPid: number;
    rows: { worker: PsRow | null; shell: PsRow | null; grandchild: PsRow | null };
  }> {
    const e = await TestEnv.create(name, {
      scenario: "shell-sleep",
      // fake LLM 的 shell-sleep 场景：第 0 轮调 shell，命令由 FAKE_SHELL_COMMAND 注入。
      fakeEnv: { FAKE_SHELL_COMMAND: "exec /bin/sh ./process-probe.sh" },
    });
    env = e;
    const work = e.dirs.work;

    // 探针脚本落在临时 cwd（会话 cwd = hub --cwd = work）。
    await writeFile(join(work, "process-probe.sh"), PROBE_SH, { mode: 0o755 });
    await writeFile(join(work, "grandchild-probe.sh"), grandchildScript(opts), { mode: 0o755 });

    // 注意：这里刻意不传 MATRIX_CORE_WORKER_ARGS=--mode auto-all。
    hub = await startHub({ dirs: e.dirs, fake: e.fake });
    const token = await hub.readToken();
    client = await WsClient.connect({ url: hub.url, token });
    await client.ready();

    const created = await client.requestOk({ type: "session.create", cwd: work, title: name });
    const sessionId = String((created.data as { sessionId?: string } | undefined)?.sessionId ?? "");
    expect(sessionId.length).toBeGreaterThan(0);

    const attachMark = client.mark();
    await client.requestOk({ type: "session.attach", sessionId }, { since: attachMark });
    const snapFrame = await client.awaitFrame((f) => f.kind === "snapshot", "hub snapshot", {
      since: attachMark,
      timeoutMs: 30000,
    });
    const snapCwd = (snapFrame.snapshot as { meta?: { cwd?: string } } | undefined)?.meta?.cwd;
    expect(snapCwd).toBe(work);

    const mark = client.mark();
    await client.requestOk({ type: "turn.send", text: "跑一条慢命令", clientId: name }, { since: mark });

    // 显式等审批：必须是 shell 工具的审批，且必须由测试 allow。
    const approval = await client.awaitEvent("approval.request", undefined, { since: mark, timeoutMs: 30000 });
    expect((approval.event as { tool?: string }).tool).toBe("shell");
    const blockId = String((approval.event as { blockId?: string }).blockId ?? "");
    expect(blockId.length).toBeGreaterThan(0);
    const resolveMark = client.mark();
    await client.requestOk({ type: "approval.resolve", blockId, decision: "allow" }, { since: resolveMark });
    const resolved = await client.awaitEvent(
      "approval.resolve",
      (ev) => ev.blockId === blockId,
      { since: resolveMark, timeoutMs: 15000 },
    );
    expect((resolved.event as { state?: string }).state).toBe("allowed");

    // 等孙进程 ready（文件握手，不靠 sleep）。
    await waitFor(() => existsSync(join(work, "grandchild.ready")), {
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: 25,
      label: "grandchild.ready",
    });

    const workerPid = await readPidFile(join(work, "worker.pid"), "worker.pid（shell 的 PPID）");
    const shellPid = await readPidFile(join(work, "shell.pid"), "shell.pid");
    const grandchildPid = await readPidFile(join(work, "grandchild.pid"), "grandchild.pid");
    captured.add(workerPid);
    captured.add(shellPid);
    captured.add(grandchildPid);

    const rows = {
      worker: await psRow(workerPid),
      shell: await psRow(shellPid),
      grandchild: await psRow(grandchildPid),
    };
    logRow("ready:worker", rows.worker);
    logRow("ready:shell", rows.shell);
    logRow("ready:grandchild", rows.grandchild);

    // 真实链路：worker → shell → grandchild，且三者都活着。
    expect(rows.worker, "worker 进程应存在").not.toBeNull();
    expect(rows.shell, "shell 进程应存在").not.toBeNull();
    expect(rows.grandchild, "grandchild 进程应存在").not.toBeNull();
    expect(isAlive(rows.worker)).toBe(true);
    expect(isAlive(rows.shell)).toBe(true);
    expect(isAlive(rows.grandchild)).toBe(true);
    // shell 的父进程就是 worker；孙进程的父进程就是 shell。
    expect(rows.shell!.ppid).toBe(workerPid);
    expect(rows.grandchild!.ppid).toBe(shellPid);
    // 同一探针对基线和 S1 使用相同前置条件；只记录是否 detached，不以此提前失败。
    expect(rows.worker!.ppid).toBe(hub!.runInfo.pid);
    expect(rows.shell!.pgid).toBe(rows.worker!.pgid);
    // 孙进程与 shell 同组（shell 未另开进程组）。
    expect(rows.grandchild!.pgid).toBe(rows.shell!.pgid);

    return { dirs: e.dirs, sessionId, workerPid, shellPid, grandchildPid, rows };
  }

  test(
    "正向对照：不停 Hub，放 gate 后孙进程必须写出 marker",
    async () => {
      const chain = await startChain("hub-tree-control", { ignoreTerm: false });
      const marker = join(chain.dirs.work, "marker.txt");
      expect(existsSync(marker)).toBe(false);

      await writeFile(join(chain.dirs.work, "gate"), "go\n");
      await waitFor(() => existsSync(marker), {
        timeoutMs: MARKER_TIMEOUT_MS,
        intervalMs: 25,
        label: "marker.txt（正向对照）",
      });
      expect(await readFile(marker, "utf8")).toContain("grandchild-ran");

      // 父 shell 的 wait 也返回了。
      await waitFor(() => existsSync(join(chain.dirs.work, "probe.done")), {
        timeoutMs: MARKER_TIMEOUT_MS,
        intervalMs: 25,
        label: "probe.done",
      });
    },
    TIMEOUT,
  );

  test(
    "SIGTERM Hub 后 worker/shell/孙进程均不存活，gate 也写不出 marker",
    async () => {
      const chain = await startChain("hub-tree-sigterm", { ignoreTerm: false });
      const marker = join(chain.dirs.work, "marker.txt");

      // 就绪后 SIGTERM Hub，等它真的退出。
      const h = hub;
      expect(h).not.toBeNull();
      const stopCode = await h!.stop();
      hub = null;
      console.log(`[hub-process-tree] ${JSON.stringify({ phase: "hub.stop", code: stopCode })}`);

      // 观测三个 pid 的存活状态并打日志（不输出 token）。
      const workerRow = await psRow(chain.workerPid);
      const shellRow = await psRow(chain.shellPid);
      const grandRow = await psRow(chain.grandchildPid);
      logRow("after-stop:worker", workerRow);
      logRow("after-stop:shell", shellRow);
      logRow("after-stop:grandchild", grandRow);

      // 放 gate：如果孙进程还活着，它会写 marker。
      await writeFile(join(chain.dirs.work, "gate"), "go\n");
      const grandStillAlive = isAlive(grandRow);
      if (grandStillAlive) {
        // 仍活：等它写 marker 并记录（这是「没被回收」的证据）。
        try {
          await waitFor(() => existsSync(marker), {
            timeoutMs: MARKER_TIMEOUT_MS,
            intervalMs: 25,
            label: "marker.txt（孙进程仍存活时）",
          });
        } catch {
          /* 超时也继续：下面统一断言 */
        }
        console.log(
          `[hub-process-tree] ${JSON.stringify({
            phase: "grandchild-survived-stop",
            pid: chain.grandchildPid,
            markerWritten: existsSync(marker),
          })}`,
        );
      }

      // 断言：三个进程都不存活（排除 Z），marker 不存在。
      const workerFinal = await waitGone(chain.workerPid, "worker");
      const shellFinal = await waitGone(chain.shellPid, "shell");
      const grandFinal = await waitGone(chain.grandchildPid, "grandchild");
      logRow("final:worker", workerFinal);
      logRow("final:shell", shellFinal);
      logRow("final:grandchild", grandFinal);

      expect(isAlive(workerFinal), `worker 仍存活：${JSON.stringify(workerFinal)}`).toBe(false);
      expect(isAlive(shellFinal), `shell 仍存活：${JSON.stringify(shellFinal)}`).toBe(false);
      expect(isAlive(grandFinal), `孙进程仍存活：${JSON.stringify(grandFinal)}`).toBe(false);
      expect(existsSync(marker), "孙进程在 Hub 停止后仍写出了 marker").toBe(false);
    },
    TIMEOUT,
  );

  test(
    "孙进程空 trap TERM 时，Hub 的 SIGKILL 兜底仍能回收",
    async () => {
      const chain = await startChain("hub-tree-sigkill", { ignoreTerm: true });
      const marker = join(chain.dirs.work, "marker.txt");

      const h = hub;
      expect(h).not.toBeNull();
      const stopCode = await h!.stop();
      hub = null;
      console.log(`[hub-process-tree] ${JSON.stringify({ phase: "hub.stop", code: stopCode })}`);

      const workerRow = await psRow(chain.workerPid);
      const shellRow = await psRow(chain.shellPid);
      const grandRow = await psRow(chain.grandchildPid);
      logRow("after-stop:worker", workerRow);
      logRow("after-stop:shell", shellRow);
      logRow("after-stop:grandchild", grandRow);

      await writeFile(join(chain.dirs.work, "gate"), "go\n");
      if (isAlive(grandRow)) {
        try {
          await waitFor(() => existsSync(marker), {
            timeoutMs: MARKER_TIMEOUT_MS,
            intervalMs: 25,
            label: "marker.txt（孙进程仍存活时）",
          });
        } catch {
          /* 超时也继续 */
        }
        console.log(
          `[hub-process-tree] ${JSON.stringify({
            phase: "grandchild-survived-stop",
            pid: chain.grandchildPid,
            markerWritten: existsSync(marker),
          })}`,
        );
      }

      const workerFinal = await waitGone(chain.workerPid, "worker");
      const shellFinal = await waitGone(chain.shellPid, "shell");
      const grandFinal = await waitGone(chain.grandchildPid, "grandchild");
      logRow("final:worker", workerFinal);
      logRow("final:shell", shellFinal);
      logRow("final:grandchild", grandFinal);

      expect(isAlive(workerFinal), `worker 仍存活：${JSON.stringify(workerFinal)}`).toBe(false);
      expect(isAlive(shellFinal), `shell 仍存活：${JSON.stringify(shellFinal)}`).toBe(false);
      // 空 trap 的孙进程只能靠 SIGKILL 收掉；它必须死。
      expect(isAlive(grandFinal), `孙进程（空 trap TERM）仍存活：${JSON.stringify(grandFinal)}`).toBe(false);
      expect(existsSync(marker), "TERM 忽略孙进程在 Hub 停止后仍写出了 marker").toBe(false);
    },
    TIMEOUT,
  );
});
