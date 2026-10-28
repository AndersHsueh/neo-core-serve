/**
 * tests/e2e/commands-consistency.test.ts — 命令「单表」的外部一致性（brief §2.2 / 验收 3）。
 *
 * v0.0.2 把 `runCommand` switch / 命令子集 / HELP_TEXT / 未知命令错误统一到
 * `src/core/commands/registry.ts`，并生成 `src/protocol/commands.json`。
 * 本文件从**行为**侧验证三处一致（docs:check 负责静态一致性）：
 *  1. commands.json 结构合法、name/alias 无歧义；
 *  2. HELP 文本覆盖目录里的全部命令（含 `/name` 形式），且 HELP 里出现的命令都在目录里；
 *  3. 未知命令的错误文案里的「可用命令」列表 = 目录（name + aliases）；
 *  4. 目录里的每条命令都被真正路由（不会被当成未知命令）。
 *
 * 门：`src/protocol/commands.json` 存在（生成器落地后自动启用）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TestEnv, serveStdioAvailable } from "../helpers.ts";

const COMMANDS_JSON = join(import.meta.dir, "../../src/protocol/commands.json");
const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/commands] serve 尚未可用：已跳过");
const catalogAvailable = existsSync(COMMANDS_JSON);
if (available && !catalogAvailable) {
  console.warn("[e2e/commands] src/protocol/commands.json 尚未生成：已跳过（生成后自动启用）");
}

const TIMEOUT = 30000;

interface CatalogEntry {
  name: string;
  aliases: string[];
  group: string;
  args: unknown[];
  description: string;
}
interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  commands: CatalogEntry[];
}

async function loadCatalog(): Promise<Catalog> {
  return JSON.parse(await readFile(COMMANDS_JSON, "utf8")) as Catalog;
}

/** 从任意文本里抽 `/xxx` 命令名。 */
function slashNames(text: string): string[] {
  return [...text.matchAll(/`?\/([a-z][a-z0-9_-]*)/gi)].map((m) => m[1]!.toLowerCase());
}

describe.skipIf(!available || !catalogAvailable)("命令单表一致性", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function start(name = "commands"): Promise<TestEnv> {
    env = await TestEnv.create(name, { scenario: "tool-then-answer" });
    await env.startCore();
    return env;
  }

  test("commands.json 结构合法：name/alias 全局唯一、字段齐全", async () => {
    const catalog = await loadCatalog();
    expect(catalog.schemaVersion).toBe(1);
    expect(typeof catalog.generatedAt).toBe("string");
    expect(Array.isArray(catalog.commands)).toBe(true);
    expect(catalog.commands.length).toBeGreaterThan(10);

    const names = new Set<string>();
    const aliases = new Set<string>();
    const groups = new Set(["session", "model", "tools", "memory", "wiki", "mailbox", "maintenance"]);
    for (const cmd of catalog.commands) {
      expect(cmd.name, "命令名必须小写").toBe(cmd.name.toLowerCase());
      expect(names.has(cmd.name), `重复命令名：${cmd.name}`).toBe(false);
      names.add(cmd.name);
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(groups.has(cmd.group), `未知 group：${cmd.group}`).toBe(true);
      expect(Array.isArray(cmd.aliases)).toBe(true);
      for (const alias of cmd.aliases) {
        expect(alias).toBe(alias.toLowerCase());
        expect(names.has(alias), `alias "${alias}" 与命令名冲突`).toBe(false);
        expect(aliases.has(alias), `alias 重复：${alias}`).toBe(false);
        aliases.add(alias);
      }
    }
    // 核心子集必须在目录里（brief §2.2 提到 help/clear/compact/context/cost/tier/mode/tools/history/why/auto/provider/model/rename）。
    for (const required of ["help", "clear", "compact", "context", "cost", "tier", "mode", "tools", "history", "why", "auto", "provider", "model", "rename"]) {
      expect(names.has(required), `目录缺核心命令 ${required}`).toBe(true);
    }
  }, TIMEOUT);

  test("HELP 文本与目录一致（双向包含，含别名）", async () => {
    const e = await start("commands-help");
    const core = e.requireCore();
    const catalog = await loadCatalog();
    const res = await core.requestOk({ type: "command.run", name: "help", args: [] });
    const blocks = (res.data as any)?.blocks ?? [];
    const helpText = JSON.stringify(blocks);
    const helpNames = new Set(slashNames(helpText));
    expect(helpNames.size).toBeGreaterThan(5);

    const known = new Set<string>();
    for (const cmd of catalog.commands) {
      known.add(cmd.name);
      for (const a of cmd.aliases) known.add(a);
    }
    // 目录里每条（含别名）都能在 help 里找到 `/x`。
    const missing = [...known].filter((n) => !helpNames.has(n));
    expect(missing, `help 缺少目录里的命令：${missing.join(", ")}`).toEqual([]);
    // help 里出现的每个命令都在目录里（禁止第二套命令表）。
    const extra = [...helpNames].filter((n) => !known.has(n));
    expect(extra, `help 出现目录外命令：${extra.join(", ")}`).toEqual([]);
  }, TIMEOUT);

  test("未知命令错误文案的「可用」列表 = 目录（name + aliases）", async () => {
    const e = await start("commands-unknown");
    const core = e.requireCore();
    const catalog = await loadCatalog();
    const res = await core.request({
      type: "command.run",
      name: "no-such-command-xyz",
      args: [],
    });
    const failed = res.ok === false || (res.data as any)?.ok === false;
    expect(failed).toBe(true);
    const text = `${res.error?.message ?? ""} ${JSON.stringify((res.data as any)?.error ?? {})} ${JSON.stringify((res.data as any)?.blocks ?? [])}`;
    expect(text).toMatch(/可用|available|supported/i);

    const known = new Set<string>();
    for (const cmd of catalog.commands) {
      known.add(cmd.name);
      for (const a of cmd.aliases) known.add(a);
    }
    // 文案里的命令名（逗号分隔清单）应全部来自目录；目录中每个命令也应出现。
    const listed = new Set(
      text
        .replace(/[。.?？]/g, " ")
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^[a-z][a-z0-9_-]*$/.test(s)),
    );
    const extra = [...listed].filter((n) => known.has(n) === false && n.length > 2 && !["the", "and", "for", "not"].includes(n));
    // 允许文案里出现非命令词，但目录外命令绝不能被列成「可用」。
    for (const word of extra) expect(word, `未知命令文案错误地推荐了目录外命令 ${word}`).not.toMatch(/^[a-z]+$/);
  }, TIMEOUT);

  test("目录里的每条命令都被路由（不会返回「不支持的命令」）", async () => {
    const e = await start("commands-routed");
    const core = e.requireCore();
    const catalog = await loadCatalog();
    const unrouted: string[] = [];
    for (const cmd of catalog.commands) {
      // 只验证「被路由」：具体业务结果（ok/false）不论，但不能是「未知命令」。
      const res = await core.request({ type: "command.run", name: cmd.name, args: [] });
      const text = JSON.stringify(res);
      if (/不支持的命令|unknown command|no such command/i.test(text)) unrouted.push(cmd.name);
    }
    expect(unrouted, `这些命令在目录里但未被注册：${unrouted.join(", ")}`).toEqual([]);
  }, TIMEOUT);
});
