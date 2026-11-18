/**
 * Service-file ownership and no-clobber publication.
 * Never overwrite a checked pathname: claim its entry into a private quarantine,
 * then validate the CLAIMED inode. Publish/restore with link(2) (EEXIST, never
 * replace). A concurrent foreign entry is never overwritten or unlinked.
 * Reinstall has a brief missing-path window, not a partially-written file.
 * If restoration is obstructed, preserve the quarantined bytes and name them
 * in the error. This protects data, not against an attacker controlling HOME.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
export const MANAGED_MARKER = "managed-by=neo-core-serve";
export type FileCheck = { ok: true } | { ok: false; reason: string };
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";
const unique = (file: string, tag: string): string => join(dirname(file), `.${basename(file)}.${tag}-${randomUUID()}`);

export function inspectTarget(file: string): FileCheck {
  let fd: number | undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, reason: `${file} 不是普通托管文件（可能为符号链接）` };
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error("目标身份已改变");
    if (!readFileSync(fd, "utf8").includes(MANAGED_MARKER)) throw new Error("不是本应用管理的文件");
    return { ok: true };
  } catch (e) {
    if (missing(e)) return { ok: true };
    return { ok: false, reason: `${file}: ${(e as Error).message}` };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function restore(claim: string, file: string): void {
  try { linkSync(claim, file); unlinkSync(claim); }
  catch (e) { throw new Error(`目标发生竞争；原文件保留在 ${claim}；${String(e)}`); }
}
function claimTarget(file: string): string | null {
  const claim = unique(file, "saved");
  try { renameSync(file, claim); }
  catch (e) { if (missing(e)) return null; throw e; }
  const check = inspectTarget(claim);
  if (!check.ok) {
    // link never follows a symlink and never replaces an existing destination.
    restore(claim, file);
    throw new Error(check.reason);
  }
  return claim;
}
export function writeManagedFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const check = inspectTarget(file);
  if (!check.ok) throw new Error(check.reason);
  const tmp = unique(file, "tmp");
  writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
  let claim: string | null = null;
  let published = false;
  try {
    claim = claimTarget(file);
    linkSync(tmp, file); // atomic publication, NOREPLACE even after validation
    published = true;
  } finally {
    unlinkSync(tmp);
    if (claim) {
      if (published) unlinkSync(claim);
      else restore(claim, file);
    }
  }
}
export function removeManagedFile(file: string): FileCheck {
  const check = inspectTarget(file);
  if (!check.ok) return check;
  try {
    const claim = claimTarget(file);
    if (claim) unlinkSync(claim); // Only the validated, privately claimed inode.
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e) }; }
}
