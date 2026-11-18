/**
 * tests/e2e/daemon.test.ts — S1 daemon 加固验收。
 *
 * 覆盖：
 *  1. 第二个 hub 启动时返回已有 url，exit 0
 *  2. 陈旧锁可回收（pid 不存活）
 *  3. core.json / core.token 权限 0600，目录 0700
 *  4. SIGTERM hub 之后 worker 与孙进程的回收（已迁至 tests/e2e/hub-process-tree.test.ts）
 *  5. 临时 HOME 下 install 生成的 plist/unit 正确；uninstall 清理干净（假执行器）
 *  6. 重启后 token 与旧 token 不同
 *  7. daemon 模式下 --dev-auth 被拒绝
 *  8. serve 与 hub 互斥
 *  9. 前台 SIGHUP 走退出码 129；daemon 模式忽略 SIGHUP
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAIN_ENTRY,
  TestEnv,
  coreSpawnEnv,
  serveStdioAvailable,
  sleep,
  startHub,
  startWsCore,
  waitFor,
  writeSettings,
  type HubCore,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/daemon] serve 尚未可用：已跳过");

const TIMEOUT = 60000;

async function runCli(
  env: TestEnv,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  await writeSettings(env.dirs, env.fake.baseUrl);
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", MAIN_ENTRY, ...args],
    cwd: env.dirs.work,
    env: { ...coreSpawnEnv({ dirs: env.dirs, fake: env.fake }), ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const timeoutMs = opts.timeoutMs ?? 20000;
  const code = await Promise.race([proc.exited, sleep(timeoutMs).then(() => null)]);
  if (code === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    return { code: -1, stdout, stderr };
  }
  return { code, stdout, stderr };
}

async function spawnHubRaw(
  env: TestEnv,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ proc: ReturnType<typeof Bun.spawn>; stdout: () => string; stderr: () => string }> {
  await writeSettings(env.dirs, env.fake.baseUrl);
  let stdout = "";
  let stderr = "";
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", MAIN_ENTRY, "hub", "--port", "0", "--cwd", env.dirs.work, ...extraArgs],
    cwd: env.dirs.work,
    env: { ...coreSpawnEnv({ dirs: env.dirs, fake: env.fake }), ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pumps = [
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) stdout += dec.decode(chunk, { stream: true });
    })(),
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr += dec.decode(chunk, { stream: true });
    })(),
  ];
  void Promise.allSettled(pumps);
  return { proc, stdout: () => stdout, stderr: () => stderr };
}

async function waitCoreJson(env: TestEnv, label: string): Promise<string> {
  const path = join(env.dirs.run, "core.json");
  await waitFor(() => existsSync(path), { timeoutMs: 20000, intervalMs: 25, label });
  return path;
}

describe.skipIf(!available)("daemon / 单实例 / 信号", () => {
  let env: TestEnv | null = null;
  let hub: HubCore | null = null;

  afterEach(async () => {
    if (hub) {
      await hub.stop().catch(() => {});
      hub = null;
    }
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "第二个 hub 启动时返回已有 url，exit 0",
    async () => {
      env = await TestEnv.create("daemon-second-hub");
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      const second = await runCli(env, ["hub", "--port", "0", "--cwd", env.dirs.work]);
      expect(second.code, `stderr=${second.stderr}\nstdout=${second.stdout}`).toBe(0);
      expect(second.stdout).toContain("already running");
      expect(second.stdout).toContain(hub.url);
    },
    TIMEOUT,
  );

  test(
    "陈旧锁可回收，hub 能启动",
    async () => {
      env = await TestEnv.create("daemon-stale-lock");
      const lockDir = join(env.dirs.run, "core.lock");
      mkdirSync(lockDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z", kind: "hub" })}\n`,
      );
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      expect(hub.url.startsWith("ws://127.0.0.1:")).toBe(true);
      const owner = JSON.parse(await Bun.file(join(lockDir, "owner.json")).text()) as { pid: number };
      expect(owner.pid).toBe(hub.runInfo.pid);
    },
    TIMEOUT,
  );

  test(
    "core.json / core.token 权限为 0600，run 目录 0700",
    async () => {
      env = await TestEnv.create("daemon-perms");
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      const jsonMode = statSync(hub.coreJsonPath).mode & 0o777;
      const tokenMode = statSync(hub.runInfo.tokenFile).mode & 0o777;
      const dirMode = statSync(env.dirs.run).mode & 0o777;
      expect(jsonMode).toBe(0o600);
      expect(tokenMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    },
    TIMEOUT,
  );

  test(
    "重启后 token 与旧 token 不同",
    async () => {
      env = await TestEnv.create("daemon-token-rotate");
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      const first = await hub.readToken();
      await hub.stop();
      hub = null;
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      const second = await hub.readToken();
      expect(second).not.toBe(first);
      expect(second).toHaveLength(64);
    },
    TIMEOUT,
  );

  test(
    "daemon 模式下 --dev-auth 被拒绝",
    async () => {
      env = await TestEnv.create("daemon-dev-auth");
      const result = await runCli(env, ["hub", "--port", "0", "--cwd", env.dirs.work, "--daemon", "--dev-auth"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/dev-auth/);
      expect(existsSync(join(env.dirs.run, "core.json"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "serve 与 hub 互斥",
    async () => {
      env = await TestEnv.create("daemon-mutex");
      hub = await startHub({ dirs: env.dirs, fake: env.fake });
      const serve = await runCli(env, ["serve", "--port", "0", "--cwd", env.dirs.work], { timeoutMs: 15000 });
      expect(serve.code, serve.stderr).toBe(2);
      expect(serve.stderr).toMatch(/互斥|已有 hub/);

      await hub.stop();
      hub = null;
      const ws = await startWsCore({ dirs: env.dirs, fake: env.fake });
      try {
        const secondHub = await runCli(env, ["hub", "--port", "0", "--cwd", env.dirs.work]);
        expect(secondHub.code, secondHub.stderr).toBe(2);
        expect(secondHub.stderr).toMatch(/互斥|已有 serve/);
        expect(secondHub.stdout).not.toMatch(/already running at/);
      } finally {
        await ws.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "前台 SIGHUP 以 129 退出；daemon 模式忽略 SIGHUP",
    async () => {
      env = await TestEnv.create("daemon-sighup");
      const fg = await spawnHubRaw(env);
      await waitCoreJson(env, "前台 hub core.json");
      const fgPid = fg.proc.pid;
      expect(fgPid).toBeGreaterThan(0);
      process.kill(fgPid, "SIGHUP");
      const fgCode = await Promise.race([fg.proc.exited, sleep(10000).then(() => null)]);
      expect(fgCode, `foreground SIGHUP: stdout=${fg.stdout()} stderr=${fg.stderr()}`).toBe(129);

      const daemon = await spawnHubRaw(env, ["--daemon"]);
      const jsonPath = await waitCoreJson(env, "daemon hub core.json");
      const daemonPid = daemon.proc.pid;
      process.kill(daemonPid, "SIGHUP");
      const still = await Promise.race([daemon.proc.exited.then((c) => c), sleep(800).then(() => "alive")]);
      expect(still, `daemon should ignore SIGHUP; stderr=${daemon.stderr()}`).toBe("alive");
      expect(existsSync(jsonPath)).toBe(true);
      process.kill(daemonPid, "SIGTERM");
      const termCode = await Promise.race([daemon.proc.exited, sleep(10000).then(() => null)]);
      expect(termCode).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "临时 HOME 下 install/uninstall 生成并清理 plist 与 unit（假执行器）",
    async () => {
      env = await TestEnv.create("daemon-install");
      const bindir = join(env.dirs.root, "bin");
      const log = join(env.dirs.root, "service-exec.log");
      await mkdir(bindir, { recursive: true });
      const stub = `#!/bin/sh
echo "$0 $*" >> "${log}"
exit 0
`;
      for (const name of ["launchctl", "systemctl", "journalctl"]) {
        const path = join(bindir, name);
        await writeFile(path, stub, { mode: 0o755 });
        await chmod(path, 0o755);
      }
      const commonEnv = { MATRIX_CORE_SERVICE_BINDIR: bindir, PATH: `${bindir}:${process.env.PATH ?? ""}` };

      const darwin = await runCli(env, ["daemon", "install", "--port", "0", "--cwd", env.dirs.work], {
        env: { ...commonEnv, MATRIX_CORE_PLATFORM: "darwin" },
      });
      expect(darwin.code, darwin.stderr + darwin.stdout).toBe(0);
      const plist = join(env.dirs.home, "Library", "LaunchAgents", "com.neo.core-serve.plist");
      expect(existsSync(plist)).toBe(true);
      const plistText = await Bun.file(plist).text();
      expect(plistText).toContain("<string>hub</string>");
      expect(plistText).toContain("<key>RunAtLoad</key>");
      expect(plistText).toContain("<key>SuccessfulExit</key>");
      expect(plistText).toContain("<false/>");
      expect(plistText).toContain("<key>ExitTimeOut</key>");
      expect(plistText).toContain("<integer>10</integer>");
      expect(plistText).toContain("MATRIX_CORE_DAEMON");
      expect(plistText).toContain("<key>PATH</key>");
      expect(plistText).toContain(MAIN_ENTRY);
      expect(plistText).not.toContain("dev-auth");
      const dLog = existsSync(log) ? await Bun.file(log).text() : "";
      expect(dLog).toContain("launchctl bootstrap");

      const uninstallD = await runCli(env, ["daemon", "uninstall"], {
        env: { ...commonEnv, MATRIX_CORE_PLATFORM: "darwin" },
      });
      expect(uninstallD.code, uninstallD.stderr).toBe(0);
      expect(existsSync(plist)).toBe(false);
      const dLog2 = await Bun.file(log).text();
      expect(dLog2).toContain("launchctl bootout");

      const linux = await runCli(env, ["daemon", "install", "--port", "4377", "--cwd", env.dirs.work], {
        env: { ...commonEnv, MATRIX_CORE_PLATFORM: "linux" },
      });
      expect(linux.code, linux.stderr + linux.stdout).toBe(0);
      const unit = join(env.dirs.home, ".config", "systemd", "user", "neo-core-serve.service");
      expect(existsSync(unit)).toBe(true);
      const unitText = await Bun.file(unit).text();
      expect(unitText).toContain("Restart=on-failure");
      expect(unitText).toContain("TimeoutStopSec=10");
      expect(unitText).toContain("KillMode=control-group");
      expect(unitText).toContain("--port 4377");
      expect(unitText).toContain("MATRIX_CORE_DAEMON=1");
      expect(unitText).not.toContain("linger");
      const lLog = await Bun.file(log).text();
      expect(lLog).toContain("systemctl --user enable --now neo-core-serve.service");

      const uninstallL = await runCli(env, ["daemon", "uninstall"], {
        env: { ...commonEnv, MATRIX_CORE_PLATFORM: "linux" },
      });
      expect(uninstallL.code, uninstallL.stderr).toBe(0);
      expect(existsSync(unit)).toBe(false);
      const lLog2 = await Bun.file(log).text();
      expect(lLog2).toContain("systemctl --user disable --now neo-core-serve.service");
    },
    TIMEOUT,
  );

  // 说明：原先这里有一条「SIGTERM hub 之后，worker 和孙进程不再写盘」的用例，已删除。
  // 它是**假阳性**：
  //  1. 用 MATRIX_CORE_WORKER_ARGS=--mode auto-all 绕过审批，测的不是默认路径；
  //  2. 只等一个 tool.* 事件就当作「shell 已启动」——任意 tool 事件都不等于进程已 spawn，
  //     于是「孙进程没写 marker」既可能因为被回收，也可能因为进程压根没起来；
  //  3. 用固定 sleep(400)/sleep(7000) 猜时序，没有 ready 握手，也没有观测 pid。
  // 替代用例见 tests/e2e/hub-process-tree.test.ts（显式审批 + pid 文件 + ps 取证 + ready 握手）。
});
