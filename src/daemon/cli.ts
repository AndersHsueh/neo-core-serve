/**
 * daemon/cli.ts — `matrix-core daemon install|uninstall|status|start|stop|restart|logs`
 *
 * 与顶层 status/stop 协调：发现文件仍是 ~/.neo/run/core.json；
 * 未安装用户服务时，daemon stop 回退为向 core.json 中的 pid 发 SIGTERM。
 */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defaultTokenFile, runFile } from "../serve/auth.ts";
import {
  createDefaultRunner,
  defaultSpec,
  readCoreJson,
  readDaemonLogs,
  installService,
  restartService,
  serviceManagerStatus,
  startService,
  stopService,
  uninstallService,
  type DaemonPlatform,
  type ServiceSpec,
} from "./service.ts";

export const DAEMON_HELP = `matrix-core daemon — 用户级常驻服务（登录后自启，不开 linger）

用法：
  matrix-core daemon install [--port N] [--cwd DIR]
  matrix-core daemon uninstall | start | stop | restart | status | logs
  neo-core-serve daemon …          # 与 matrix-core 同一入口

说明：
  macOS：~/Library/LaunchAgents/com.neo.core-serve.plist
  Linux：~/.config/systemd/user/neo-core-serve.service
  端口默认随机（--port 0），可指定固定端口。
  发现文件位置与字段不变：~/.neo/run/core.json、~/.neo/run/core.token。
`;

function parseDaemonFlags(argv: string[]): { port: number; cwd: string | null } {
  const out = { port: 0, cwd: null as string | null };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i] ?? "";
    const next = (): string => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${v} 缺少参数`);
      return value;
    };
    if (v === "--port") out.port = Number(next());
    else if (v === "--cwd") out.cwd = next();
    else if (v === "-h" || v === "--help") throw new Error("help");
    else throw new Error(`未知参数: ${v}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error(`非法 --port: ${out.port}`);
  return out;
}

function specFrom(flags: { port: number; cwd: string | null }): ServiceSpec {
  const spec = defaultSpec({ port: flags.port });
  const cwd = realpathSync(resolve(flags.cwd ?? spec.cwd));
  if (!statSync(cwd).isDirectory()) throw new Error(`--cwd 不是目录: ${cwd}`);
  return { ...spec, cwd };
}

function writeOut(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeErr(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function alreadyRunningLine(): string | null {
  const { info, alive } = readCoreJson();
  if (!alive || !info) return null;
  const url = typeof info.url === "string" ? info.url : "";
  return url ? `matrix-core: already running at ${url}` : "matrix-core: already running";
}

export async function cmdDaemon(argv: string[]): Promise<number> {
  const [sub = "help", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    writeOut(DAEMON_HELP);
    return 0;
  }
  const runner = createDefaultRunner();
  try {
    switch (sub) {
      case "install": {
        const flags = parseDaemonFlags(rest);
        const spec = specFrom(flags);
        const result = await installService(spec, runner);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon install 失败（exit ${result.code}）`);
          if (result.stdout) writeOut(result.stdout);
          return 1;
        }
        writeOut(`matrix-core: 已安装 ${result.file}`);
        if (result.stdout.trim()) writeOut(result.stdout.trim());
        return 0;
      }
      case "uninstall": {
        const spec = defaultSpec();
        const result = await uninstallService(spec, runner);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon uninstall 失败（exit ${result.code}）`);
          if (result.stdout) writeOut(result.stdout);
          return 1;
        }
        writeOut(`matrix-core: 已卸载 ${result.file}`);
        if (result.stdout.trim()) writeOut(result.stdout.trim());
        if (result.stderr.trim()) writeErr(result.stderr.trim());
        return 0;
      }
      case "start": {
        const existing = alreadyRunningLine();
        if (existing) {
          writeOut(existing);
          return 0;
        }
        const result = await startService(defaultSpec(), runner);
        if (result.stdout) writeOut(result.stdout);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon start 失败（exit ${result.code}）`);
          return 1;
        }
        writeOut("matrix-core: daemon start 已发出");
        return 0;
      }
      case "stop": {
        const spec = defaultSpec();
        const result = await stopService(spec, runner);
        if (result.code !== 0 && /未安装/.test(result.stderr)) {
          // 未安装用户服务：回退为向发现文件里的 pid 发 SIGTERM，与顶层 stop 一致。
          return fallbackStop();
        }
        if (result.stdout) writeOut(result.stdout);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon stop 失败（exit ${result.code}）`);
          return 1;
        }
        writeOut("matrix-core: daemon stop 已发出");
        return 0;
      }
      case "restart": {
        const result = await restartService(defaultSpec(), runner);
        if (result.stdout) writeOut(result.stdout);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon restart 失败（exit ${result.code}）`);
          return 1;
        }
        writeOut("matrix-core: daemon restart 已发出");
        return 0;
      }
      case "status": {
        const spec = defaultSpec();
        const mgr = await serviceManagerStatus(spec, runner);
        const run = readCoreJson();
        const payload = {
          platform: spec.platform,
          installed: mgr.installed,
          file: mgr.file,
          coreJson: runFile(),
          tokenFile: defaultTokenFile(),
          url: run.info && typeof run.info.url === "string" ? run.info.url : null,
          pid: run.info && typeof run.info.pid === "number" ? run.info.pid : null,
          alive: run.alive,
          managerExit: mgr.manager?.code ?? null,
          manager: (mgr.manager?.stdout || mgr.manager?.stderr || "").trim() || null,
        };
        writeOut(JSON.stringify(payload, null, 2));
        if (mgr.manager && mgr.manager.code !== 0) return 1;
        return run.alive || mgr.installed ? 0 : 1;
      }
      case "logs": {
        const result = await readDaemonLogs(defaultSpec(), runner);
        if (result.stdout) writeOut(result.stdout);
        if (result.code !== 0) {
          writeErr(result.stderr || `matrix-core: daemon logs 失败（exit ${result.code}）`);
          return 1;
        }
        return 0;
      }
      default:
        writeErr(`matrix-core: 未知 daemon 子命令 "${sub}"`);
        return 2;
    }
  } catch (error) {
    if ((error as Error).message === "help") {
      writeOut(DAEMON_HELP);
      return 0;
    }
    writeErr(`matrix-core: ${(error as Error).message}`);
    return 2;
  }
}

function fallbackStop(): number {
  const { info, alive } = readCoreJson();
  if (!info || typeof info.pid !== "number" || !alive) {
    writeOut("matrix-core: 未运行");
    return 0;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    writeOut(`matrix-core: sent SIGTERM to ${info.pid}`);
    return 0;
  } catch (error) {
    writeErr(`matrix-core: stop failed: ${(error as Error).message}`);
    return 1;
  }
}

export function isDaemonMode(args: { daemon?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.daemon) return true;
  if (env["MATRIX_CORE_DAEMON"] === "1") return true;
  if (env["INVOCATION_ID"]) return true;
  if (env["LAUNCH_JOB_LABEL"]) return true;
  return false;
}

export type { DaemonPlatform };
