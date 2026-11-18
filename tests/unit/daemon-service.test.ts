/**
 * tests/unit/daemon-service.test.ts — 单实例锁、服务单元内容、token 轮换、日志轮转。
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstanceLock,
  readInstanceOwner,
  releaseInstanceLock,
} from "../../src/daemon/instance-lock.ts";
import { rotateIfNeeded, MAX_LOG_BYTES } from "../../src/daemon/logs.ts";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  defaultSpec,
  renderLaunchAgentPlist,
  renderSystemdUnit,
} from "../../src/daemon/service.ts";
import { rotateToken, writeRunInfo, runFile } from "../../src/serve/auth.ts";
import { killProcessGroup } from "../../src/hub/worker.ts";

async function withTempEnv<T>(fn: (home: string, env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "matrix-core-daemon-unit-"));
  const env = {
    ...process.env,
    HOME: home,
    NEO_HOME: join(home, ".neo"),
    NEO_RUN_DIR: join(home, ".neo", "run"),
    NEO_LOG_DIR: join(home, ".neo", "logs"),
  } as NodeJS.ProcessEnv;
  try {
    return await fn(home, env);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("单实例锁", () => {
  test("mkdir 独占；同进程可重入；释放后可再取", async () => {
    await withTempEnv((_home, env) => {
      const first = acquireInstanceLock("hub", env);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const owner = readInstanceOwner(first.dir);
      expect(owner?.pid).toBe(process.pid);
      expect(owner?.kind).toBe("hub");
      expect(typeof owner?.startedAt).toBe("string");

      const again = acquireInstanceLock("hub", env);
      expect(again.ok).toBe(true);

      releaseInstanceLock(first.dir);
      const third = acquireInstanceLock("serve", env);
      expect(third.ok).toBe(true);
      if (third.ok) releaseInstanceLock(third.dir);
    });
  });

  test("陈旧锁（pid 不存活）可回收", async () => {
    await withTempEnv((home, env) => {
      const dir = join(env.NEO_RUN_DIR!, "core.lock");
      mkdirSync(join(env.NEO_RUN_DIR!), { recursive: true, mode: 0o700 });
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(
        join(dir, "owner.json"),
        `${JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z", kind: "hub" })}\n`,
        { mode: 0o600 },
      );
      const got = acquireInstanceLock("hub", env);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const owner = readInstanceOwner(got.dir);
      expect(owner?.pid).toBe(process.pid);
      releaseInstanceLock(got.dir);
    });
  });
});

describe("用户服务单元内容", () => {
  test("LaunchAgent plist 字段正确", () => {
    const spec = defaultSpec({
      platform: "darwin",
      home: "/tmp/fake-home",
      cwd: "/tmp/fake-home",
      bunPath: "/opt/bun/bin/bun",
      entryPath: "/opt/neo-core-serve/src/main.ts",
      port: 0,
      pathEnv: "/opt/bun/bin:/usr/bin:/bin",
    });
    const plist = renderLaunchAgentPlist(spec);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/bun/bin/bun</string>");
    expect(plist).toContain("<string>/opt/neo-core-serve/src/main.ts</string>");
    expect(plist).toContain("<string>hub</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>0</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/bun/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>MATRIX_CORE_DAEMON</key>");
    expect(plist).toContain("<string>1</string>");
    expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>10</integer>");
    expect(plist).toContain("/tmp/fake-home/.neo/logs/core/stdout.log");
    expect(plist).not.toContain("enable-linger");
    expect(plist).not.toContain("dev-auth");
  });

  test("systemd user unit 字段正确；不含 linger", () => {
    const spec = defaultSpec({
      platform: "linux",
      home: "/tmp/fake-home",
      cwd: "/tmp/fake-home",
      bunPath: "/opt/bun/bin/bun",
      entryPath: "/opt/neo-core-serve/src/main.ts",
      port: 4377,
      pathEnv: "/opt/bun/bin:/usr/bin:/bin",
    });
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("TimeoutStopSec=10");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("ExecStart=/opt/bun/bin/bun /opt/neo-core-serve/src/main.ts hub --port 4377 --cwd /tmp/fake-home");
    expect(unit).toContain("Environment=MATRIX_CORE_DAEMON=1");
    expect(unit).toContain("Environment=PATH=/opt/bun/bin:/usr/bin:/bin");
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).not.toContain("linger");
    expect(unit).not.toContain("dev-auth");
    expect(SYSTEMD_UNIT).toBe("neo-core-serve.service");
  });
});

describe("token 轮换与发现文件权限", () => {
  test("rotateToken 每次都生成新值；文件 0600、目录 0700", async () => {
    await withTempEnv((_home, env) => {
      const tokenFile = join(env.NEO_RUN_DIR!, "core.token");
      const a = rotateToken(tokenFile);
      const b = rotateToken(tokenFile);
      expect(a).not.toBe(b);
      expect(a).toHaveLength(64);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(statSync(env.NEO_RUN_DIR!).mode & 0o777).toBe(0o700);
    });
  });

  test("writeRunInfo 把 core.json 写成 0600", async () => {
    await withTempEnv((_home, env) => {
      const file = runFile(env);
      writeRunInfo(file, {
        url: "ws://127.0.0.1:9/ws",
        pid: process.pid,
        tokenFile: join(env.NEO_RUN_DIR!, "core.token"),
        sessionId: "",
        epoch: "",
        startedAt: new Date().toISOString(),
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(env.NEO_RUN_DIR!).mode & 0o777).toBe(0o700);
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(Object.keys(raw).sort()).toEqual(
        ["epoch", "pid", "sessionId", "startedAt", "tokenFile", "url"].sort(),
      );
    });
  });
});

describe("日志按大小轮转", () => {
  test("超过上限时改名为 .1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-core-logrot-"));
    try {
      const file = join(dir, "stdout.log");
      writeFileSync(file, "old\n");
      chmodSync(file, 0o600);
      // 用很小的上限触发
      rotateIfNeeded(file, 2);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(readFileSync(`${file}.1`, "utf8")).toBe("old\n");
      expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("进程组回收", () => {
  test("kill(-pgid) 后 detached 的 sleep;touch 不再写盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-core-pgid-"));
    const marker = join(dir, "touched.txt");
    const child = Bun.spawn(["/bin/sh", "-c", `sleep 3; touch "${marker}"`], {
      cwd: dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    } as Parameters<typeof Bun.spawn>[1]);
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(150);
    killProcessGroup(pid, "SIGKILL");
    await Bun.sleep(200);
    try {
      child.kill(9);
    } catch {
      /* ignore */
    }
    await Bun.sleep(3500);
    expect(existsSync(marker)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 15000);
});
