/**
 * daemon/service.ts — 用户级 LaunchAgent / systemd --user 的生成、安装与生命周期。
 *
 * 测试通过 MATRIX_CORE_PLATFORM 与 MATRIX_CORE_SERVICE_BINDIR（假执行器目录）注入，
 * 绝不在测试里调用本机真实的 launchctl/systemctl。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { coreLogsDir, runFile } from "../core/paths.ts";
import { prepareDaemonLogFiles, stderrLogFile, stdoutLogFile } from "./logs.ts";

export const LAUNCHD_LABEL = "com.neo.core-serve";
export const SYSTEMD_UNIT = "neo-core-serve.service";
export const EXIT_TIMEOUT_SEC = 10;

export type DaemonPlatform = "darwin" | "linux";

export interface ServiceSpec {
  bunPath: string;
  entryPath: string;
  port: number;
  cwd: string;
  home: string;
  pathEnv: string;
  platform: DaemonPlatform;
}

export interface ServiceRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ServiceBin = "launchctl" | "systemctl" | "journalctl" | "id";

export interface ServiceRunner {
  run(bin: ServiceBin, args: string[]): Promise<ServiceRunResult>;
}

export function resolvePlatform(env: NodeJS.ProcessEnv = process.env): DaemonPlatform {
  const raw = (env["MATRIX_CORE_PLATFORM"] ?? "").trim().toLowerCase();
  if (raw === "darwin" || raw === "macos" || raw === "mac") return "darwin";
  if (raw === "linux") return "linux";
  return process.platform === "darwin" ? "darwin" : "linux";
}

export function defaultSpec(overrides: Partial<ServiceSpec> = {}, env: NodeJS.ProcessEnv = process.env): ServiceSpec {
  const home = overrides.home ?? env["HOME"] ?? homedir();
  const bunPath = overrides.bunPath ?? process.execPath;
  const entryPath = overrides.entryPath ?? defaultEntryPath();
  const pathEnv = overrides.pathEnv ?? buildPathEnv(bunPath, env);
  return {
    bunPath,
    entryPath,
    port: overrides.port ?? 0,
    cwd: overrides.cwd ?? home,
    home,
    pathEnv,
    platform: overrides.platform ?? resolvePlatform(env),
  };
}

export function defaultEntryPath(): string {
  return join(import.meta.dir, "..", "main.ts");
}

function buildPathEnv(bunPath: string, env: NodeJS.ProcessEnv): string {
  const current = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const bunDir = dirname(bunPath);
  const parts = current.split(":").filter(Boolean);
  if (!parts.includes(bunDir)) parts.unshift(bunDir);
  return parts.join(":");
}

export function launchAgentPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLaunchAgentPlist(spec: ServiceSpec): string {
  const logs = prepareLogPaths(spec);
  const args = [spec.bunPath, spec.entryPath, "hub", "--port", String(spec.port), "--cwd", spec.cwd];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(spec.pathEnv)}</string>
    <key>HOME</key>
    <string>${xmlEscape(spec.home)}</string>
    <key>MATRIX_CORE_DAEMON</key>
    <string>1</string>
  </dict>
  <key>ExitTimeOut</key>
  <integer>${EXIT_TIMEOUT_SEC}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.stderr)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [spec.bunPath, spec.entryPath, "hub", "--port", String(spec.port), "--cwd", spec.cwd]
    .map(escapeUnitArg)
    .join(" ");
  return `[Unit]
Description=neo-core-serve (Matrix-Core Hub)
After=default.target

[Service]
Type=simple
WorkingDirectory=${spec.cwd}
ExecStart=${exec}
Restart=on-failure
TimeoutStopSec=${EXIT_TIMEOUT_SEC}
KillMode=control-group
Environment=PATH=${spec.pathEnv}
Environment=HOME=${spec.home}
Environment=MATRIX_CORE_DAEMON=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function escapeUnitArg(s: string): string {
  if (/[\s"\\]/.test(s)) return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return s;
}

function prepareLogPaths(spec: ServiceSpec): { stdout: string; stderr: string } {
  // 服务文件里的日志路径跟用户 $HOME 走，不调用 os.homedir()（测试 HOME 是临时目录）。
  const dir = join(spec.home, ".neo", "logs", "core");
  return {
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
  };
}

export function createDefaultRunner(env: NodeJS.ProcessEnv = process.env): ServiceRunner {
  const bindir = env["MATRIX_CORE_SERVICE_BINDIR"]?.trim();
  return {
    async run(bin, args) {
      const exe = bindir ? join(bindir, bin) : bin;
      const proc = Bun.spawn([exe, ...args], {
        cwd: env["HOME"] ?? process.cwd(),
        env: env as Record<string, string>,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
}

function writeFile0600(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export async function installService(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<ServiceRunResult & { file: string }> {
  if (spec.platform === "darwin") {
    const logDir = join(spec.home, ".neo", "logs", "core");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, HOME: spec.home, NEO_HOME: join(spec.home, ".neo") } as NodeJS.ProcessEnv;
    prepareDaemonLogFiles(env);
    const file = launchAgentPath(spec.home);
    writeFile0600(file, renderLaunchAgentPlist(spec));
    const result = await runner.run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
    return { ...result, file };
  }
  const file = systemdUnitPath(spec.home);
  writeFile0600(file, renderSystemdUnit(spec));
  const userDir = dirname(file);
  // enable --now：登录后自启 + 立刻启动。默认不开 linger。
  const result = await runner.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  return { ...result, file, stdout: `${result.stdout}\n# unit written: ${file}\n# user dir: ${userDir}` };
}

export async function uninstallService(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<ServiceRunResult & { file: string }> {
  if (spec.platform === "darwin") {
    const file = launchAgentPath(spec.home);
    const result = await runner.run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    return { ...result, file };
  }
  const file = systemdUnitPath(spec.home);
  const stop = await runner.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  return { ...stop, file };
}

export async function startService(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<ServiceRunResult> {
  if (spec.platform === "darwin") {
    const file = launchAgentPath(spec.home);
    if (!existsSync(file)) {
      return { code: 2, stdout: "", stderr: `matrix-core: 未安装（缺少 ${file}），请先 daemon install\n` };
    }
    const boot = await runner.run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
    // 已加载时 bootstrap 可能非 0，继续 kickstart。
    const kick = await runner.run("launchctl", ["kickstart", `gui/${uid()}/${LAUNCHD_LABEL}`]);
    return { code: kick.code === 0 ? 0 : boot.code, stdout: boot.stdout + kick.stdout, stderr: boot.stderr + kick.stderr };
  }
  const file = systemdUnitPath(spec.home);
  if (!existsSync(file)) {
    return { code: 2, stdout: "", stderr: `matrix-core: 未安装（缺少 ${file}），请先 daemon install\n` };
  }
  return runner.run("systemctl", ["--user", "start", SYSTEMD_UNIT]);
}

export async function stopService(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<ServiceRunResult> {
  if (spec.platform === "darwin") {
    const file = launchAgentPath(spec.home);
    if (!existsSync(file)) {
      return { code: 1, stdout: "", stderr: `matrix-core: 未安装用户服务（${file}）\n` };
    }
    // bootout 卸载当前会话中的服务，plist 保留，下次登录仍会加载。
    return runner.run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  }
  const file = systemdUnitPath(spec.home);
  if (!existsSync(file)) {
    return { code: 1, stdout: "", stderr: `matrix-core: 未安装用户服务（${file}）\n` };
  }
  return runner.run("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
}

export async function restartService(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<ServiceRunResult> {
  if (spec.platform === "darwin") {
    const file = launchAgentPath(spec.home);
    if (!existsSync(file)) {
      return { code: 2, stdout: "", stderr: `matrix-core: 未安装（缺少 ${file}），请先 daemon install\n` };
    }
    return runner.run("launchctl", ["kickstart", "-k", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  }
  const file = systemdUnitPath(spec.home);
  if (!existsSync(file)) {
    return { code: 2, stdout: "", stderr: `matrix-core: 未安装（缺少 ${file}），请先 daemon install\n` };
  }
  return runner.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
}

export async function serviceManagerStatus(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
): Promise<{ installed: boolean; file: string; manager: ServiceRunResult | null }> {
  const file = spec.platform === "darwin" ? launchAgentPath(spec.home) : systemdUnitPath(spec.home);
  const installed = existsSync(file);
  if (!installed) return { installed, file, manager: null };
  if (spec.platform === "darwin") {
    const manager = await runner.run("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`]);
    return { installed, file, manager };
  }
  const manager = await runner.run("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager"]);
  return { installed, file, manager };
}

export async function readDaemonLogs(
  spec: ServiceSpec,
  runner: ServiceRunner = createDefaultRunner(),
  lines = 200,
): Promise<ServiceRunResult> {
  if (spec.platform === "darwin") {
    const env = {
      ...process.env,
      HOME: spec.home,
      NEO_HOME: process.env["NEO_HOME"] ?? join(spec.home, ".neo"),
    } as NodeJS.ProcessEnv;
    const files = [stderrLogFile(env), stdoutLogFile(env)].filter((f) => existsSync(f));
    if (files.length === 0) {
      return { code: 0, stdout: "matrix-core: 暂无日志文件\n", stderr: "" };
    }
    const chunks: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const tail = text.split("\n").slice(-lines).join("\n");
      chunks.push(`---- ${file} ----\n${tail}${tail.endsWith("\n") ? "" : "\n"}`);
    }
    return { code: 0, stdout: chunks.join(""), stderr: "" };
  }
  return runner.run("journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", String(lines), "--no-pager"]);
}

export function readCoreJson(env: NodeJS.ProcessEnv = process.env): {
  info: Record<string, unknown> | null;
  alive: boolean;
} {
  const file = runFile(env);
  if (!existsSync(file)) return { info: null, alive: false };
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    let alive = false;
    if (typeof info.pid === "number") {
      try {
        process.kill(info.pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    return { info, alive };
  } catch {
    return { info: null, alive: false };
  }
}
