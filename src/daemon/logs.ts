/**
 * daemon/logs.ts — daemon 日志落盘与按大小轮转（刻意保持简单）。
 *
 * macOS LaunchAgent 把 stdout/stderr 指到 ~/.neo/logs/core/；
 * 启动时若文件超过 5MB，改名为 *.1 再继续写。
 * Linux 交给 journald，本模块只负责读文件或调用 journalctl。
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { coreLogsDir } from "../core/paths.ts";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function stdoutLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(coreLogsDir(env), "stdout.log");
}

export function stderrLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(coreLogsDir(env), "stderr.log");
}

export function ensureCoreLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = coreLogsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  return dir;
}

/** 文件超过上限则改名为 `${file}.1`（只保留一代）。 */
export function rotateIfNeeded(file: string, maxBytes = MAX_LOG_BYTES): void {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < maxBytes) return;
    const rotated = `${file}.1`;
    try {
      rmSync(rotated, { force: true });
    } catch {
      /* ignore */
    }
    renameSync(file, rotated);
  } catch {
    /* 轮转失败不阻断启动 */
  }
}

export function prepareDaemonLogFiles(env: NodeJS.ProcessEnv = process.env): { stdout: string; stderr: string } {
  ensureCoreLogDir(env);
  const stdout = stdoutLogFile(env);
  const stderr = stderrLogFile(env);
  rotateIfNeeded(stdout);
  rotateIfNeeded(stderr);
  return { stdout, stderr };
}
