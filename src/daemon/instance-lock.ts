/**
 * Kernel-backed single-instance lease. The SQLite rollback-mode EXCLUSIVE
 * transaction owns the mutex, NOT owner.json, PID liveness, or a timeout.
 * The permanent database inode is never renamed/unlinked. Process death closes
 * the lease in the kernel; metadata publication/recovery/release runs under it.
 * bun:sqlite is built into Bun (no native addon or external lock command).
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { instanceLockDir, runFile } from "../core/paths.ts";
import type { RunInfo } from "../serve/auth.ts";

export type InstanceKind = "hub" | "serve";
export interface InstanceOwner { pid: number; startedAt: string; kind: InstanceKind }
export type AcquireInstanceResult =
  | { ok: true; dir: string }
  | { ok: false; reason: "held"; owner: InstanceOwner; url: string | null };
const held = new Map<string, { db: Database; token: string }>();
const ownerPath = (dir: string): string => join(dir, "owner.json");

export function readInstanceOwner(dir: string): InstanceOwner | null {
  try {
    const raw = JSON.parse(readFileSync(ownerPath(dir), "utf8"));
    if (!Number.isInteger(raw.pid) || raw.pid <= 0 || !["hub", "serve"].includes(raw.kind)) return null;
    return { pid: raw.pid, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "", kind: raw.kind };
  } catch { return null; }
}
export function readRunningUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const raw = JSON.parse(readFileSync(runFile(env), "utf8")) as Partial<RunInfo>;
    return typeof raw.url === "string" && raw.url.length ? raw.url : null;
  } catch { return null; }
}
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export function acquireInstanceLock(
  kind: InstanceKind, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now,
): AcquireInstanceResult {
  const dir = instanceLockDir(env);
  if (held.has(dir)) return { ok: true, dir };
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dir), 0o700);
  // This guard must outlive all owner generations; never remove it on release.
  const db = new Database(`${dir}.sqlite`, { create: true });
  chmodSync(`${dir}.sqlite`, 0o600);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
    return {
      ok: false, reason: "held",
      // Metadata is advisory: an unpublished owner is busy, never stale.
      owner: readInstanceOwner(dir) ?? { pid: 0, startedAt: "", kind },
      url: readRunningUrl(env),
    };
  }
  const token = randomUUID();
  const tmp = join(dir, `.owner-${token}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString(), kind, token })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, ownerPath(dir));
    held.set(dir, { db, token });
    return { ok: true, dir };
  } catch (error) {
    rmSync(tmp, { force: true });
    db.close();
    throw error;
  }
}
export function releaseInstanceLock(dir: string | null, pid = process.pid): void {
  if (!dir || pid !== process.pid) return;
  const lease = held.get(dir);
  if (!lease) return; // Never delete another process/generation's metadata.
  try { rmSync(ownerPath(dir), { force: true }); }
  finally { held.delete(dir); lease.db.close(); }
}
