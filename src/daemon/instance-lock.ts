/**
 * daemon/instance-lock.ts — Hub/serve 单实例锁（~/.neo/run/core.lock/）。
 *
 * 复用会话锁的现成算法：mkdir 独占 + owner.json + pid 存活检查 + 陈旧锁 rename 回收。
 * 第二次 `hub` 遇到仍由活着的 hub 持有的锁时，调用方输出已有 url 并以 0 退出。
 * `serve`（非 --stdio）与 `hub` 互斥。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { instanceLockDir, runFile } from "../core/paths.ts";
import type { RunInfo } from "../serve/auth.ts";

export type InstanceKind = "hub" | "serve";

export interface InstanceOwner {
  pid: number;
  startedAt: string;
  kind: InstanceKind;
}

export type AcquireInstanceResult =
  | { ok: true; dir: string }
  | { ok: false; reason: "held"; owner: InstanceOwner; url: string | null };

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeOwner(dir: string, owner: InstanceOwner): void {
  const tmp = join(dir, "owner.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, join(dir, "owner.json"));
}

export function readInstanceOwner(dir: string): InstanceOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Partial<InstanceOwner>;
    if (typeof raw.pid !== "number") return null;
    const kind = raw.kind === "serve" ? "serve" : raw.kind === "hub" ? "hub" : null;
    if (!kind) return null;
    return {
      pid: raw.pid,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      kind,
    };
  } catch {
    return null;
  }
}

function readOwnerSettled(dir: string): InstanceOwner | null {
  const direct = readInstanceOwner(dir);
  if (direct) return direct;
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) {
    if (!existsSync(dir)) return null;
    sleepSync(10);
    const again = readInstanceOwner(dir);
    if (again) return again;
  }
  return readInstanceOwner(dir);
}

export function readRunningUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const raw = JSON.parse(readFileSync(runFile(env), "utf8")) as Partial<RunInfo>;
    return typeof raw.url === "string" && raw.url.length > 0 ? raw.url : null;
  } catch {
    return null;
  }
}

export function acquireInstanceLock(
  kind: InstanceKind,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): AcquireInstanceResult {
  const dir = instanceLockDir(env);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(dir), 0o700);
  } catch {
    /* 非 POSIX 忽略 */
  }
  const owner: InstanceOwner = {
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    kind,
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      writeOwner(dir, owner);
      const check = readInstanceOwner(dir);
      if (check?.pid === process.pid && check.kind === kind) return { ok: true, dir };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
    }

    const holder = readOwnerSettled(dir);
    if (holder) {
      if (holder.pid === process.pid && holder.kind === kind) return { ok: true, dir };
      if (isProcessAlive(holder.pid)) {
        return { ok: false, reason: "held", owner: holder, url: readRunningUrl(env) };
      }
    }

    const stale = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(dir, stale);
    } catch {
      continue;
    }
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      /* 残留名唯一，不影响下次 mkdir */
    }
  }
  throw new Error(`单实例锁竞争失败（${dir}）`);
}

/** 只释放本进程持有的锁（owner.pid 对得上才删）。 */
export function releaseInstanceLock(dir: string | null, pid = process.pid): void {
  if (!dir) return;
  try {
    const owner = readInstanceOwner(dir);
    if (owner && owner.pid !== pid) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export { isProcessAlive };
