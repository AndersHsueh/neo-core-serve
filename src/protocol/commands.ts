/**
 * protocol/commands.ts — 命令目录（commands.json）的 schema。
 *
 * C0 只定义形状；C1.7 由 core 的命令注册表生成 `commands.json`，
 * 客户端 vendor 后做内容/哈希守卫（禁止手写第二份命令表）。
 */
export const COMMANDS_SCHEMA_VERSION = 1 as const;

export type CommandGroup =
  | "session"
  | "model"
  | "tools"
  | "memory"
  | "wiki"
  | "mailbox"
  | "maintenance";

export interface CommandArgSpec {
  name: string;
  /** string | enum | number */
  type: "string" | "enum" | "number";
  required?: boolean;
  enum?: string[];
  description?: string;
}

export interface CommandCatalogEntry {
  name: string;
  aliases: string[];
  group: CommandGroup;
  args: CommandArgSpec[];
  /** 一句话说明（中英由客户端 i18n 负责翻译前的中文口径） */
  description: string;
  /** 该命令是否会改变会话状态（v1.2；客户端可在轮次运行中提前禁用） */
  mutates?: boolean;
  /** 协议版本：v1.1 起 */
  since?: string;
  /** false = 客户端专属（不进 core 目录） */
  core?: boolean;
}

export interface CommandCatalog {
  schemaVersion: typeof COMMANDS_SCHEMA_VERSION;
  /** ISO 日期；生成器写入 */
  generatedAt: string;
  commands: CommandCatalogEntry[];
}
