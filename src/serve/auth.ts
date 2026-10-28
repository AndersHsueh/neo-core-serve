/**
 * serve/auth.ts — 本地鉴权与发现文件。
 *
 * - token：`~/.neo/run/core.token`（0600），可用 --token-file 覆盖；
 * - 发现：`~/.neo/run/core.json`（原子写，pid 校验）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RunInfo {
  url: string;
  pid: number;
  tokenFile: string;
  sessionId: string;
  epoch: string;
  startedAt: string;
}

export function runDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["NEO_RUN_DIR"] ?? join(homedir(), ".neo", "run");
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(runDir(env), "core.token");
}

export function runFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(runDir(env), "core.json");
}

export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw.length >= 16) return raw;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 非 POSIX 忽略 */
  }
  return token;
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
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
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
