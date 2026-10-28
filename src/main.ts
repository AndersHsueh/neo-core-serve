#!/usr/bin/env bun
/**
 * matrix-core —— neo 的核心运行时服务。
 *
 * C0 骨架：只提供版本/帮助占位；serve/status/stop/doctor/import 在 C2 实现。
 */
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from "./protocol/types.ts";

const CORE_VERSION = "0.0.0";

const HELP = `matrix-core（Matrix-Core）

用法：
  matrix-core version          显示版本
  matrix-core serve [flags]   启动单会话服务（C2 实现）
  matrix-core status          查看运行状态（C2 实现）
  matrix-core stop            停止本机实例（C3 实现）
  matrix-core doctor          环境自检（C3 实现）
  matrix-core import <id>     只读导入旧会话（C2 实现）

退出码：0 成功 / 2 用法错误 / 1 运行失败。
`;

export function versionLine(): string {
  return `matrix-core ${CORE_VERSION} (protocol v${PROTOCOL_SEMVER}, wire v${PROTOCOL_VERSION})`;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
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
    default:
      process.stderr.write(`matrix-core: 未知命令 "${cmd}"（C0 只有 version/help）\n`);
      return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
