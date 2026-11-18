/**
 * serve/auth.ts — 本地鉴权与发现文件。
 *
 * - token：`~/.neo/run/core.token`（0600），可用 --token-file 覆盖；
 *   每次成功启动/重启调用 rotateToken 生成新 token（与 docs/ops.md 一致）；
 * - 发现：`~/.neo/run/core.json`（原子写，权限 0600；目录 0700）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runDir as coreRunDir, runFile as coreRunFile, tokenFile as coreTokenFile } from "../core/paths.ts";

export interface RunInfo {
  url: string;
  pid: number;
  tokenFile: string;
  sessionId: string;
  epoch: string;
  startedAt: string;
}

export function runDir(env: NodeJS.ProcessEnv = process.env): string {
  return coreRunDir(env);
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return coreTokenFile(env);
}

export function runFile(env: NodeJS.ProcessEnv = process.env): string {
  return coreRunFile(env);
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ensurePrivateFile(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    /* 非 POSIX 忽略 */
  }
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 非 POSIX 忽略 */
  }
}

/** 每次成功启动/重启都生成新 token，客户端重读 core.json / core.token。 */
export function rotateToken(file: string): string {
  const token = randomToken();
  ensurePrivateFile(file, `${token}\n`);
  return token;
}

/** 仅在 token 文件尚不存在或过短时创建（doctor / 兼容路径）。启动必须走 rotateToken。 */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw.length >= 16) return raw;
  }
  return rotateToken(file);
}

/** 从 WS 子协议里取 bearer token */
export function tokenFromProtocols(protocols: string | string[] | undefined): string | null {
  const arr = typeof protocols === "string" ? protocols.split(",") : (protocols ?? []);
  for (const p of arr) {
    const s = p.trim();
    if (s.startsWith("bearer.")) return s.slice("bearer.".length);
  }
  return null;
}

export function tokenMatches(expected: string, got: string | null): boolean {
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function writeRunInfo(file: string, info: RunInfo): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    /* 非 POSIX 忽略 */
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 非 POSIX 忽略 */
  }
}

export function clearRunInfo(file: string, pid = process.pid): void {
  try {
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RunInfo>;
    if (raw.pid === pid) rmSync(file, { force: true });
  } catch {
    /* 损坏文件忽略 */
  }
}
