# 命令目录（commands.json）schema 与生成规则

> 状态：draft · 2026-10-28 · 对应 C0.3 / C1.7
> 目标：CLI / GUI / core 三方共享**唯一命令目录**，不再手写第二份命令表。

## 1. 单一来源

- 实现源：core 的 `Command` 注册表（C1.7）。
- 生成物：`src/protocol/commands.json`（构建时生成，随协议一起冻结）。
- 客户端：vendor `commands.json` + 校验 `protocol.lock.json`；**禁止手写命令列表**。
- 漂移守卫：注册表 ↔ `commands.json` 内容必须一致（C1.7 起在 `docs:check` 里强制）。

## 2. schema

```ts
interface CommandCatalog {
  schemaVersion: 1;
  generatedAt: string;            // ISO 日期
  commands: CommandCatalogEntry[];
}

interface CommandCatalogEntry {
  name: string;                   // 规范名（不带 /）
  aliases: string[];              // 含别名（如 deep → tier deep_reasoning 的快捷）
  group: "session"|"model"|"tools"|"memory"|"wiki"|"mailbox"|"maintenance";
  args: { name: string; type: "string"|"enum"|"number"; required?: boolean; enum?: string[]; description?: string }[];
  description: string;
  since?: string;                 // 协议版本
  core?: boolean;                 // false = 客户端专属（help/last/exit/输入快捷键）
}
```

类型定义见 `src/protocol/commands.ts`（运行时无逻辑，只有类型与常量）。

## 3. 规则

1. 新增命令：先加注册表 + 实现，再生成 JSON；客户端同步后才会出现在补全/面板。
2. 别名只做折叠，不产生第二个实现（例：`/fast` → `/tier fast`）。
3. 客户端专属命令（`help`、`last`、`exit`、输入快捷键）标记 `core:false`，不要求 core 实现。
4. 任何命令的协议语义变更（参数/返回块）必须先改 `protocol-v1.md` + fixtures，再改实现。
5. C0 阶段允许 `commands.json` 不存在（`docs:check` 容忍）；C1.7 起必须存在且通过守卫。
