/**
 * core/commands/registry.ts — 命令的**单表**（v0.0.2，brief §2.2）。
 *
 * v0.0.1 的问题：支持哪些命令散在三处（`runCommandInner` 的 switch、
 * `COMMAND_SUBSET` 数组、`HELP_TEXT` 文案），加一条命令要改三遍，还容易漂移。
 *
 * 现在只有这张表：
 *  - `runCommand` 用 `findCommand` 路由；
 *  - HELP 文案由 `commandHelpText()` 从表派生；
 *  - 未知命令文案里的「可用」列表由 `commandNames()` 派生；
 *  - `generateCommandsJson()` 供 Lead 的生成器写 `src/protocol/commands.json`。
 *
 * 约束：core 不 import serve 运行时；命令结果用协议 `ViewBlock`/`CommandChanges`
 * 的 **type-only** 形状，宿主（session-host）原样返回给 serve。
 */

import type {
  CommandChanges,
  ContextState,
  PermissionMode,
  SessionEvent,
  Tier,
  ViewBlock,
} from "../../protocol/types.ts";
import type { CommandCatalog, CommandCatalogEntry, CommandArgSpec, CommandGroup } from "../../protocol/commands.ts";
import { COMMANDS_SCHEMA_VERSION } from "../../protocol/commands.ts";
import type { Agent } from "../agent.ts";
import type { Config, ModelTier } from "../config.ts";
import {
  MODEL_TIERS,
  describeRoute,
  maskKey,
  normalizeTierName,
  switchProvider,
  switchTier,
  tierChoiceLabel,
  tierDisplayName,
} from "../config.ts";
import type { Classifier } from "../classifier/index.ts";
import { CLASSIFIER_NAMES, isClassifierName } from "../classifier/index.ts";
import { contentText } from "../llm.ts";
import { toolNames } from "../tools/index.ts";

/** 命令结果（与 serve/types.ts CommandOutcome 结构一致；不 import serve）。 */
export interface CommandResult {
  ok: boolean;
  blocks: ViewBlock[];
  changes?: CommandChanges;
  error?: { code: string; message: string };
}

/** 命令对宿主的依赖面（由 session-host 提供实现）。 */
export interface CommandContext {
  readonly cfg: Config;
  readonly agent: Agent;
  readonly classifier: Classifier;
  readonly sessionId: string;
  readonly mode: PermissionMode;
  now(): number;
  /** durable=true 时宿主分配 seq 并写 transcript。 */
  emit(event: SessionEvent, durable: boolean): void;
  emitMeta(): void;
  contextState(usageRatio?: number): ContextState;
  usageCostMicros(): number;
  /** /clear：重置上下文 + 持久化 + 发 session.cleared。 */
  clearSession(): void;
  setMode(mode: PermissionMode): Promise<void>;
  rename(title: string): void;
}

export interface CommandSpec {
  name: string;
  aliases: string[];
  group: CommandGroup;
  args: CommandArgSpec[];
  description: string;
  /** false = 只读；true/函数 = 轮次运行中必须拒绝（M2）。 */
  mutates: boolean | ((args: string[]) => boolean);
  run(ctx: CommandContext, args: string[]): Promise<CommandResult>;
}

/* ------------------------------------------------------------------ */
/* 结果构造                                                            */
/* ------------------------------------------------------------------ */

export function ok(blocks: ViewBlock[], changes?: CommandChanges): CommandResult {
  return { ok: true, blocks, ...(changes ? { changes } : {}) };
}

export function fail(code: string, message: string): CommandResult {
  return {
    ok: false,
    blocks: [{ kind: "notice", level: "error", text: message }],
    error: { code, message },
  };
}

/* ------------------------------------------------------------------ */
/* 命令表                                                              */
/* ------------------------------------------------------------------ */

const argTier: CommandArgSpec = {
  name: "tier",
  type: "enum",
  required: false,
  enum: ["fast", "balanced", "deep", "deep_reasoning", "default"],
  description: "目标档位",
};

const argMode: CommandArgSpec = {
  name: "mode",
  type: "enum",
  required: false,
  enum: ["ask", "auto-edit", "auto-all", "plan", "1", "2", "3", "4"],
  description: "权限模式（名称或序号）",
};

const argName: CommandArgSpec = {
  name: "name",
  type: "string",
  required: false,
  description: "名称（留空 = 查看）",
};

const argTitle: CommandArgSpec = {
  name: "title",
  type: "string",
  required: true,
  description: "新标题",
};

/** 档位快切命令（/fast /balanced /deep /default）共用实现。 */
function tierShortcut(target: ModelTier): CommandSpec["run"] {
  return async (ctx) => switchTierTo(ctx, target);
}

async function switchTierTo(ctx: CommandContext, target: ModelTier): Promise<CommandResult> {
  const cfg = ctx.cfg;
  const from = cfg.modelTier as Tier;
  const r = switchTier(cfg, target);
  if (!r.ok) return fail("conflict", r.error);
  ctx.agent.noteModelChange(cfg);
  if (from !== (cfg.modelTier as Tier)) {
    ctx.emit(
      { type: "tier.switch", from, to: cfg.modelTier as Tier, reason: `命令切换档位`, at: ctx.now() },
      true,
    );
  }
  ctx.emitMeta();
  const blocks: ViewBlock[] = [
    { kind: "text", text: `档位 → ${tierChoiceLabel(cfg.modelTier)}（${cfg.providerName} / ${cfg.model}）` },
  ];
  if (r.degraded && r.note) blocks.push({ kind: "notice", level: "warn", text: r.note });
  return ok(blocks, { tier: cfg.modelTier as Tier, provider: cfg.providerName, model: cfg.model });
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    aliases: ["?"],
    group: "session",
    args: [],
    description: "列出可用命令",
    mutates: false,
    async run() {
      return ok([{ kind: "markdown", text: commandHelpText() }]);
    },
  },
  {
    name: "clear",
    aliases: [],
    group: "session",
    args: [],
    description: "清空上下文（保留系统提示与会话身份）",
    mutates: true,
    async run(ctx) {
      ctx.clearSession();
      return ok([{ kind: "text", text: "上下文已清空。" }]);
    },
  },
  {
    name: "compact",
    aliases: [],
    group: "session",
    args: [],
    description: "压缩历史上下文为结构化摘要",
    mutates: true,
    async run(ctx) {
      const done = await ctx.agent.compact();
      if (!done) return ok([{ kind: "text", text: "对话太短或压缩失败，未做处理。" }]);
      const pct = `${(ctx.agent.contextUsage() * 100).toFixed(1)}%`;
      return ok([{ kind: "text", text: `压缩完成。上下文使用率 ${pct}` }]);
    },
  },
  {
    name: "context",
    aliases: [],
    group: "session",
    args: [],
    description: "上下文窗口、估算用量与最近压缩",
    mutates: false,
    async run(ctx) {
      let usage = 0;
      try {
        usage = ctx.agent.contextUsage();
      } catch {
        usage = 0;
      }
      const cs = ctx.contextState(usage);
      const last = ctx.agent.lastCompactionInfo;
      const items = [
        { k: "model", v: `${ctx.cfg.providerName}/${ctx.cfg.model}` },
        { k: "window", v: `${cs.limit} tokens (${ctx.cfg.contextWindowSource ?? "config"})` },
        {
          k: "threshold",
          v: `${(ctx.cfg.compactThreshold * 100).toFixed(0)}% · ${Math.round(ctx.cfg.compactThreshold * cs.limit)} tokens`,
        },
        { k: "estimate", v: `${cs.used} tokens (${(usage * 100).toFixed(1)}%)` },
        { k: "messages", v: String(ctx.agent.messages.length) },
        { k: "last compact", v: last ? `${last.beforeTokens} → ${last.afterTokens} tokens` : "无" },
      ];
      return ok([{ kind: "kv", items }]);
    },
  },
  {
    name: "cost",
    aliases: [],
    group: "session",
    args: [],
    description: "模型、用量与计价（v0.0.x 未计价）",
    mutates: false,
    async run(ctx) {
      const cfg = ctx.cfg;
      const cum = ctx.agent.cumulative;
      const items = [
        { k: "provider", v: `${cfg.providerName} (${cfg.providerType})` },
        { k: "tier", v: tierDisplayName(cfg.modelTier) },
        { k: "model", v: cfg.model },
        { k: "endpoint", v: cfg.baseUrl },
        { k: "api key", v: maskKey(cfg.apiKey) },
        { k: "prompt", v: `${cum.prompt} tokens` },
        { k: "completion", v: `${cum.completion} tokens` },
        { k: "thinking", v: `${cum.reasoning} tokens` },
        {
          k: "cost",
          v: `$${(ctx.usageCostMicros() / 1_000_000).toFixed(6)}（未计价）`,
        },
      ];
      return ok([{ kind: "kv", items }]);
    },
  },
  {
    name: "history",
    aliases: [],
    group: "session",
    args: [],
    description: "最近 10 条用户消息",
    mutates: false,
    async run(ctx) {
      const turns = ctx.agent.messages.filter((m) => m.role === "user");
      const items = turns.slice(-10).map((m, i) => {
        const text = contentText(m.content) ?? "";
        const flat = text.replace(/\s+/g, " ").trim();
        return `${i + 1}. ${flat.length > 80 ? `${flat.slice(0, 80)}…` : flat}`;
      });
      if (items.length === 0) return ok([{ kind: "text", text: "还没有用户消息。" }]);
      return ok([{ kind: "list", items, ordered: true }]);
    },
  },
  {
    name: "why",
    aliases: [],
    group: "session",
    args: [],
    description: "最近一次档位判定（分类器）",
    mutates: false,
    async run(ctx) {
      const last = ctx.classifier.lastResult;
      const items: { k: string; v: string }[] = [
        { k: "分类器", v: ctx.classifier.name },
        { k: "判定档位", v: last?.tier ?? "（暂无判定）" },
        { k: "来源", v: last?.source ?? "-" },
        { k: "理由", v: last?.reason ?? "-" },
        { k: "当前生效", v: `${ctx.cfg.modelTier} → ${ctx.cfg.providerName} / ${ctx.cfg.model}` },
      ];
      const failure = ctx.classifier.lastFailure;
      if (failure) items.push({ k: "上次失败", v: failure });
      return ok([{ kind: "kv", items }]);
    },
  },
  {
    name: "auto",
    aliases: [],
    group: "session",
    args: [{ name: "classifier", type: "enum", required: false, enum: ["off", "rule", "llm"] }],
    description: "查看或切换自动档位分类器",
    mutates: (args) => (args[0] ?? "").trim() !== "",
    async run(ctx, args) {
      const arg = (args[0] ?? "").trim();
      if (!arg) {
        const items: { k: string; v: string }[] = [{ k: "自动分类", v: ctx.classifier.name }];
        for (const n of CLASSIFIER_NAMES) {
          items.push({ k: n === ctx.classifier.name ? `● ${n}` : `○ ${n}`, v: "" });
        }
        return ok([{ kind: "kv", items }]);
      }
      if (!isClassifierName(arg)) {
        return fail("protocol", `未知分类器 "${arg}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
      }
      try {
        ctx.classifier.use(arg, ctx.cfg);
      } catch (e) {
        return fail("internal", (e as Error).message);
      }
      return ok([{ kind: "text", text: `自动分类 → ${arg}` }]);
    },
  },
  {
    name: "rename",
    aliases: [],
    group: "session",
    args: [argTitle],
    description: "修改会话标题",
    mutates: true,
    async run(ctx, args) {
      const next = args.join(" ").trim();
      if (!next) return fail("protocol", "用法：/rename <title>");
      ctx.rename(next);
      return ok([{ kind: "text", text: `标题 → ${next}` }], { title: next });
    },
  },
  {
    name: "tier",
    aliases: [],
    group: "model",
    args: [argTier],
    description: "查看或切换模型档位",
    mutates: (args) => (args[0] ?? "").trim() !== "",
    async run(ctx, args) {
      const raw = (args[0] ?? "").trim();
      if (raw === "") {
        const items = MODEL_TIERS.map((t) => ({
          k: `${t === ctx.cfg.modelTier ? "●" : "○"} ${tierChoiceLabel(t)}`,
          v: describeRoute(ctx.cfg, t),
        }));
        return ok([{ kind: "kv", items }]);
      }
      const target = normalizeTierName(raw);
      if (!target) {
        return fail("protocol", `未知档位 "${raw}"。可选：${MODEL_TIERS.join(", ")}`);
      }
      return switchTierTo(ctx, target);
    },
  },
  {
    name: "fast",
    aliases: [],
    group: "model",
    args: [],
    description: "切换到 fast 档位",
    mutates: true,
    run: tierShortcut("fast"),
  },
  {
    name: "balanced",
    aliases: [],
    group: "model",
    args: [],
    description: "切换到 balanced 档位",
    mutates: true,
    run: tierShortcut("balanced"),
  },
  {
    name: "deep",
    aliases: ["deep_reasoning"],
    group: "model",
    args: [],
    description: "切换到 deep_reasoning 档位",
    mutates: true,
    run: tierShortcut("deep_reasoning"),
  },
  {
    name: "default",
    aliases: [],
    group: "model",
    args: [],
    description: "切换到 default 档位",
    mutates: true,
    run: tierShortcut("default"),
  },
  {
    name: "mode",
    aliases: [],
    group: "model",
    args: [argMode],
    description: "查看或切换权限模式",
    mutates: (args) => (args[0] ?? "").trim() !== "",
    async run(ctx, args) {
      const arg = (args[0] ?? "").trim();
      if (!arg) {
        return ok([
          {
            kind: "kv",
            items: [
              { k: "当前模式", v: ctx.mode },
              { k: "1", v: "ask — 写文件/执行命令都需批准" },
              { k: "2", v: "auto-edit — 自动批准写文件，命令仍需批准" },
              { k: "3", v: "auto-all — 全部自动批准（慎用）" },
              { k: "4", v: "plan — 只读，禁止一切写操作" },
            ],
          },
        ]);
      }
      const map: Record<string, PermissionMode> = {
        "1": "ask",
        ask: "ask",
        "2": "auto-edit",
        "auto-edit": "auto-edit",
        "3": "auto-all",
        "auto-all": "auto-all",
        "4": "plan",
        plan: "plan",
      };
      const next = map[arg];
      if (!next) return fail("protocol", `未知模式 ${arg}`);
      await ctx.setMode(next);
      return ok([{ kind: "text", text: `权限模式 → ${next}` }], { mode: next });
    },
  },
  {
    name: "provider",
    aliases: [],
    group: "model",
    args: [argName],
    description: "查看或切换 provider",
    mutates: (args) => (args[0] ?? "").trim() !== "",
    async run(ctx, args) {
      const arg = (args[0] ?? "").trim();
      const cfg = ctx.cfg;
      if (!arg) {
        const items = cfg.providers.map((p) => ({
          k: `${p.name === cfg.providerName ? "●" : "○"} ${p.name}`,
          v: `${p.type} → ${p.baseUrl}`,
        }));
        return ok([{ kind: "kv", items }]);
      }
      const r = switchProvider(cfg, arg);
      if (!r.ok) return fail("conflict", r.error);
      ctx.agent.noteModelChange(cfg);
      ctx.emitMeta();
      return ok(
        [
          { kind: "text", text: `provider → ${cfg.providerName}（${cfg.providerType}）` },
          {
            kind: "kv",
            items: [{ k: "model", v: `${cfg.model} [${tierDisplayName(cfg.modelTier)}]` }],
          },
        ],
        { provider: cfg.providerName, model: cfg.model },
      );
    },
  },
  {
    name: "model",
    aliases: [],
    group: "model",
    args: [argName],
    description: "查看或切换模型名",
    mutates: (args) => (args[0] ?? "").trim() !== "",
    async run(ctx, args) {
      const arg = args.join(" ").trim();
      const cfg = ctx.cfg;
      if (!arg) {
        return ok([
          {
            kind: "kv",
            items: [
              { k: "当前模型", v: `${cfg.model} (${cfg.modelTier})` },
              { k: "provider", v: cfg.providerName },
            ],
          },
        ]);
      }
      cfg.model = arg;
      ctx.agent.noteModelChange(cfg);
      ctx.emitMeta();
      return ok([{ kind: "text", text: `模型 → ${arg}` }], { model: arg });
    },
  },
  {
    name: "tools",
    aliases: [],
    group: "tools",
    args: [],
    description: "列出运行时可用工具",
    mutates: false,
    async run() {
      const names = toolNames();
      return ok([
        { kind: "kv", items: [{ k: "可用工具", v: String(names.length) }] },
        { kind: "list", items: names },
      ]);
    },
  },
];

/* ------------------------------------------------------------------ */
/* 查表与派生                                                          */
/* ------------------------------------------------------------------ */

/** 去掉前导 `/`，按 name/alias 查命令（大小写不敏感）。 */
export function findCommand(name: string): CommandSpec | undefined {
  const key = name.replace(/^\/+/, "").trim().toLowerCase();
  if (!key) return undefined;
  return COMMANDS.find((c) => c.name === key || c.aliases.includes(key));
}

/** 能否写成 `/alias`（目录里的机器可读别名只保留这种；`?` 是人工别名）。 */
function isSlashAlias(a: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(a);
}

/** 全部 name + aliases（用于未知命令文案与 tests）。 */
export function commandNames(): string[] {
  const out: string[] = [];
  for (const c of COMMANDS) {
    out.push(c.name, ...c.aliases);
  }
  return out;
}

/** HELP 文案：从表派生，按 group 分节；每条命令列出 name 与别名。 */
export function commandHelpText(): string {
  const groups: { id: CommandGroup; title: string }[] = [
    { id: "session", title: "会话" },
    { id: "model", title: "模型与权限" },
    { id: "tools", title: "工具" },
  ];
  const lines: string[] = ["## Matrix-Core 命令", ""];
  for (const g of groups) {
    const cmds = COMMANDS.filter((c) => c.group === g.id);
    if (cmds.length === 0) continue;
    lines.push(`### ${g.title}`, "");
    for (const c of cmds) {
      const names = [c.name, ...c.aliases.filter(isSlashAlias)]
        .map((n) => `/${n}`)
        .join(" / ");
      // HELP 是给人看的目录文本：描述里的 `a/b` 会被客户端/测试当成 `/b` 命令名，
      // 统一转成全角斜杠，保证「HELP 里出现的命令 === 目录」。
      const desc = c.description.replace(/\/(?=[A-Za-z])/g, "／");
      lines.push(`- ${names} — ${desc}`);
    }
    lines.push("");
  }
  lines.push("另外 `?` 与 `help` 等价。");
  lines.push("其余命令返回 ok:false（v0.0.2 只实现以上子集）。");
  return lines.join("\n");
}

/** 轮次运行中是否必须拒绝该命令（M2）。未知命令不拦（交给未知命令错误）。 */
export function isMutatingCommand(name: string, args: string[]): boolean {
  const spec = findCommand(name);
  if (!spec) return false;
  return typeof spec.mutates === "function" ? spec.mutates(args) : spec.mutates;
}

/** 未知命令结果：可用列表 = 表里的 name + aliases（单一真源）。 */
export function unsupportedCommand(name: string): CommandResult {
  return fail(
    "unsupported",
    `不支持的命令 /${name.replace(/^\/+/, "")}。可用命令：${commandNames().join(", ")}`,
  );
}

/** 生成 `src/protocol/commands.json` 的内容（Lead 的生成器只负责写文件）。 */
export function generateCommandsJson(generatedAt: string = new Date().toISOString()): CommandCatalog {
  const commands: CommandCatalogEntry[] = COMMANDS.map((c) => ({
    name: c.name,
    // 目录是机器可读的 `/命令` 清单：`?` 这类无法写成 `/x` 的人工别名不进目录，
    // 但 findCommand/help 仍支持（单表本身仍只有一份）。
    aliases: c.aliases.filter(isSlashAlias),
    group: c.group,
    args: c.args.map((a) => ({
      name: a.name,
      type: a.type,
      ...(a.required !== undefined ? { required: a.required } : {}),
      ...(a.enum ? { enum: [...a.enum] } : {}),
      ...(a.description ? { description: a.description } : {}),
    })),
    description: c.description,
    // 客户端可在轮次运行中提前禁用会改状态的命令（true 含「条件变化」保守取值）。
    mutates: typeof c.mutates === "function" ? true : c.mutates,
    since: "1.2",
    core: true,
  }));
  return { schemaVersion: COMMANDS_SCHEMA_VERSION, generatedAt, commands };
}
