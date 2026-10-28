#!/usr/bin/env bun
/**
 * matrix-core —— neo 的核心运行时服务（v0.0.1 单会话）。
 *
 * 子命令：
 *   serve   启动核心服务（默认 WS；--stdio 走行分隔帧）
 *   status  查看 ~/.neo/run/core.json
 *   stop    停掉本机实例（SIGTERM）
 *   doctor  环境自检
 *   version / help
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionHost } from "./core/session-host.ts";
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from "./protocol/types.ts";
import { clearRunInfo, defaultTokenFile, loadOrCreateToken, runFile, runDir, writeRunInfo } from "./serve/auth.ts";
import { runStdio } from "./serve/stdio.ts";
import { startWsServer } from "./serve/ws.ts";

const CORE_VERSION = "0.0.1";

const HELP = `matrix-core（Matrix-Core）v${CORE_VERSION}

用法：
  matrix-core serve [--cwd DIR] [--resume ID] [--mode MODE] [--tier TIER]
                    [--port N] [--stdio] [--dev-auth] [--token-file PATH]
  matrix-core status
  matrix-core stop
  matrix-core doctor
  matrix-core version | help

说明：
  serve 默认监听 127.0.0.1 的随机端口，写 ~/.neo/run/core.json；
  --stdio 用于测试/PTY（stdout 只出协议帧，日志走 stderr）。
  MODE: ask | auto-edit | auto-all | plan；TIER: default | balanced | deep_reasoning | fast。
`;

interface ServeArgs {
  cwd: string;
  resume: string | null;
  mode: "ask" | "auto-edit" | "auto-all" | "plan" | null;
  tier: string | null;
  port: number;
  stdio: boolean;
  devAuth: boolean;
  tokenFile: string;
}

function parseServeArgs(argv: string[]): ServeArgs {
  const out: ServeArgs = {
    cwd: process.cwd(),
    resume: null,
    mode: null,
    tier: null,
    port: 0,
    stdio: false,
    devAuth: false,
    tokenFile: defaultTokenFile(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i] ?? "";
    const next = (): string => argv[++i] ?? "";
    switch (v) {
      case "--cwd": out.cwd = resolve(next()); break;
      case "--resume": out.resume = next(); break;
      case "--mode": {
        const m = next();
        if (!["ask", "auto-edit", "auto-all", "plan"].includes(m)) throw new Error(`非法 --mode: ${m}`);
        out.mode = m as ServeArgs["mode"];
        break;
      }
      case "--tier": out.tier = next(); break;
      case "--port": out.port = Number(next()); break;
      case "--stdio": out.stdio = true; break;
      case "--dev-auth": out.devAuth = true; break;
      case "--token-file": out.tokenFile = resolve(next()); break;
      case "-h":
      case "--help": throw new Error("help");
      default:
        if (v.startsWith("-")) throw new Error(`未知参数: ${v}`);
        break;
    }
  }
  return out;
}

async function cmdServe(argv: string[]): Promise<number> {
  const args = parseServeArgs(argv);
  const host = await createSessionHost({
    cwd: args.cwd,
    resume: args.resume,
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.tier ? { tier: args.tier } : {}),
    coreVersion: CORE_VERSION,
  });

  if (args.stdio) {
    let closingStdio = false;
    const shutdownStdio = async (code: number): Promise<void> => {
      if (closingStdio) return;
      closingStdio = true;
      try {
        await Promise.race([host.close(), new Promise<void>((r) => setTimeout(r, 2000))]);
      } catch (error) {
        process.stderr.write(`matrix-core: host close failed: ${(error as Error).message}\n`);
      }
      process.exit(code);
    };
    process.on("SIGINT", () => void shutdownStdio(130));
    process.on("SIGTERM", () => void shutdownStdio(0));
    return await runStdio(host, { coreVersion: CORE_VERSION });
  }

  const token = loadOrCreateToken(args.tokenFile);
  const ws = startWsServer({
    host,
    coreVersion: CORE_VERSION,
    port: args.port,
    token,
    devAuth: args.devAuth,
  });
  const info = {
    url: ws.url,
    pid: process.pid,
    tokenFile: args.tokenFile,
    sessionId: host.sessionId,
    epoch: host.epoch,
    startedAt: new Date().toISOString(),
  };
  writeRunInfo(runFile(), info);
  process.stderr.write(
    `matrix-core v${CORE_VERSION} session=${host.sessionId} epoch=${host.epoch}\n` +
      `  ws=${ws.url}\n  token=${args.tokenFile}\n  run=${runFile()}\n`,
  );

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    // 顺序很重要：先让 host 收口（此时 WS 还活着，turn.aborted{shutdown} 能送到客户端），
    // 再关闭 WS/清理 core.json；反过来客户端会在终态事件前被断开。
    try {
      await Promise.race([host.close(), new Promise<void>((r) => setTimeout(r, 2000))]);
    } catch (error) {
      process.stderr.write(`matrix-core: host close failed: ${(error as Error).message}\n`);
    }
    try {
      await Promise.race([ws.stop(), new Promise<void>((r) => setTimeout(r, 1200))]);
    } catch (error) {
      process.stderr.write(`matrix-core: ws stop failed: ${(error as Error).message}\n`);
    }
    try {
      clearRunInfo(runFile());
    } catch {
      /* 清理失败不阻塞退出 */
    }
    process.exit(code);
  };
  const onSignal = (code: number): void => {
    void shutdown(code);
  };
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGTERM", () => onSignal(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`matrix-core: uncaught: ${error.message}\n`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`matrix-core: unhandled rejection: ${String(reason)}\n`);
    void shutdown(1);
  });

  // 常驻：等待信号
  await new Promise<void>(() => {
    /* never resolves; shutdown() exits */
  });
  return 0;
}

function cmdStatus(): number {
  const file = runFile();
  if (!existsSync(file)) {
    process.stdout.write("matrix-core: 未运行（无 core.json）\n");
    return 0;
  }
  const info = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; url?: string };
  let alive = false;
  if (typeof info.pid === "number") {
    try {
      process.kill(info.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  process.stdout.write(`${JSON.stringify({ ...info, alive }, null, 2)}\n`);
  return alive ? 0 : 1;
}

function cmdStop(): number {
  const file = runFile();
  if (!existsSync(file)) {
    process.stdout.write("matrix-core: 未运行\n");
    return 0;
  }
  const info = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
  if (typeof info.pid !== "number") return 1;
  try {
    process.kill(info.pid, "SIGTERM");
    process.stdout.write(`matrix-core: sent SIGTERM to ${info.pid}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`matrix-core: stop failed: ${(error as Error).message}\n`);
    return 1;
  }
}

function cmdDoctor(): number {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const rd = runDir();
  checks.push({ name: "run Dir", ok: true, detail: rd });
  checks.push({
    name: "token",
    ok: existsSync(defaultTokenFile()),
    detail: defaultTokenFile(),
  });
  checks.push({ name: "core.json", ok: existsSync(runFile()), detail: runFile() });
  for (const name of ["NEO_SESSIONS_DIR", "NEO_MAILBOX_DIR"]) {
    if (process.env[name]) checks.push({ name, ok: true, detail: process.env[name] });
  }
  const ok = checks.every((c) => c.ok);
  process.stdout.write(`${JSON.stringify({ ok, coreVersion: CORE_VERSION, checks }, null, 2)}\n`);
  return ok ? 0 : 1;
}

export function versionLine(): string {
  return `matrix-core ${CORE_VERSION} (protocol v${PROTOCOL_SEMVER}, wire v${PROTOCOL_VERSION})`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  try {
    switch (cmd) {
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(HELP);
        return 0;
      case "-v":
      case "--version":
      case "version":
        process.stdout.write(`${versionLine()}\n`);
        return 0;
      case "serve":
        return await cmdServe(rest);
      case "status":
        return cmdStatus();
      case "stop":
        return cmdStop();
      case "doctor":
        return cmdDoctor();
      default:
        process.stderr.write(`matrix-core: 未知命令 "${cmd}"\n`);
        return 2;
    }
  } catch (error) {
    if ((error as Error).message === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`matrix-core: ${(error as Error).message}\n`);
    return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
