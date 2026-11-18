/**
 * tests/guards/core-boundary.test.ts — core 层的机械边界守卫（架构 §3「依赖规则」）。
 *
 * 只允许一种「自觉」：`src/core/ui/**` 是 v0.0.1 的终端兼容层（agent/tools 编译期需要），
 * 允许触碰 process.stdout；其余 core 代码必须无终端假设：
 *  - 禁止 `process.exit(`（退出只允许在 main.ts 白名单）；
 *  - 禁止 `process.stdout.isTTY`（流式与否由组合根注入 streaming）；
 *  - 禁止 `console.log(`（日志走注入的 Logger / stderr）；
 *  - 禁止运行时 `import ... from "...serve/..."`（serve 依赖 core，不能反向；
 *    只允许 `import type ... from "../serve/types.ts"` 这种类型端口）。
 *
 * 扫描前先剥离注释：`agent.ts` 的文档注释里提到 `process.stdout.isTTY` 是解释性文字，
 * 不是代码（守卫不该逼人删掉解释）。
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORE_DIR = join(ROOT, "src", "core");

async function listCoreFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  };
  await walk(CORE_DIR);
  return out;
}

/** 剥掉 `//` 与 `/* *\/` 注释，只留代码行（行号不变）。 */
function codeLines(text: string): { no: number; code: string }[] {
  const out: { no: number; code: string }[] = [];
  let inBlock = false;
  for (const [idx, raw] of text.split("\n").entries()) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    for (;;) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, start);
        break;
      }
      line = `${line.slice(0, start)} ${line.slice(end + 2)}`;
    }
    out.push({ no: idx + 1, code: line });
  }
  return out;
}

interface ImportStmt {
  from: string;
  typeOnly: boolean;
  line: number;
}

function scanImports(text: string): ImportStmt[] {
  const lines = text.split("\n");
  const out: ImportStmt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^\s*import\b/.test(line)) continue;
    const typeOnly = /^\s*import\s+type\b/.test(line);
    let stmt = line;
    let j = i;
    while (!/from\s+["'][^"']+["']/.test(stmt) && !/^\s*import\s+["'][^"']+["']/.test(stmt) && j + 1 < lines.length && j - i < 40) {
      j += 1;
      stmt += `\n${lines[j] ?? ""}`;
    }
    const from = /from\s+["']([^"']+)["']/.exec(stmt) ?? /^\s*import\s+["']([^"']+)["']/.exec(stmt);
    if (from?.[1]) out.push({ from: from[1], typeOnly, line: i + 1 });
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** core 里「终端兼容层」：v0.0.1 保留，v0.0.2 清理（见 release notes 的偏差说明）。 */
function isUiCompat(file: string): boolean {
  return rel(file).startsWith("src/core/ui/");
}

describe("core 边界守卫", () => {
  test("core（不含 ui 兼容层）禁止 process.exit / process.stdout.isTTY / console.log", async () => {
    const files = (await listCoreFiles()).filter((f) => !isUiCompat(f));
    expect(files.length, "没扫到 core 文件：守卫会空转").toBeGreaterThan(20);

    const rules: { name: string; re: RegExp }[] = [
      { name: "process.exit(", re: /process\.exit\s*\(/ },
      { name: "process.stdout.isTTY", re: /process\.stdout\.isTTY/ },
      { name: "console.log(", re: /console\.log\s*\(/ },
    ];
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const { no, code } of codeLines(text)) {
        for (const rule of rules) {
          if (rule.re.test(code)) violations.push(`${rel(file)}:${no} 出现 ${rule.name} —— ${code.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("core Agent 模块不得再使用 process.stdout.isTTY（流式由 streaming 注入）", async () => {
    const agentFiles = (await listCoreFiles()).filter((f) => {
      const r = rel(f);
      return r === "src/core/agent.ts" || r.startsWith("src/core/agent/");
    });
    expect(agentFiles.length, "没扫到 agent 模块").toBeGreaterThan(1);
    const hits: string[] = [];
    let hasStreamingOpt = false;
    for (const file of agentFiles) {
      const text = await readFile(file, "utf8");
      hits.push(
        ...codeLines(text)
          .filter(({ code }) => /process\.stdout\.isTTY/.test(code))
          .map(({ no, code }) => `${rel(file)}:${no} —— ${code.trim()}`),
      );
      if (codeLines(text).some(({ code }) => /streaming\??\s*:/.test(code))) hasStreamingOpt = true;
    }
    expect(hits).toEqual([]);
    // 反过来确认注入点还在：streaming 选项是唯一开关（类型已抽到 agent/types.ts）。
    expect(hasStreamingOpt).toBe(true);
  });

  test("core 不得 import neo-cli / 外部 TUI，也不得 value-import Console 具体类", async () => {
    const files = await listCoreFiles();
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const imp of scanImports(text)) {
        const spec = imp.from;
        if (
          spec === "neo" ||
          spec === "neo-cli" ||
          spec.startsWith("neo/") ||
          spec.startsWith("neo-cli/") ||
          spec.includes("neo-tui") ||
          spec.includes("neo-agent/")
        ) {
          violations.push(`${rel(file)}:${imp.line} import ${spec}`);
        }
        // 具体 Console 类：只允许类型注释里提，不允许 value import。
        // ui 兼容层自身也不实现 Console（Console 在 neo-cli）。
        const head = text.split("\n")[imp.line - 1] ?? "";
        if (!imp.typeOnly && /\bConsole\b/.test(head) && /\bimport\b/.test(head)) {
          violations.push(`${rel(file)}:${imp.line} value-import Console from ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("core 不得运行时 import serve/（只允许 `import type ... serve/types.ts`）", async () => {
    const files = await listCoreFiles();
    const violations: string[] = [];
    const allowed: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const imp of scanImports(text)) {
        if (!/(^|\/)serve\//.test(imp.from)) continue;
        if (imp.typeOnly) allowed.push(`${rel(file)}:${imp.line} -> ${imp.from}`);
        else violations.push(`${rel(file)}:${imp.line} 运行时 import ${imp.from}`);
      }
    }
    expect(violations).toEqual([]);
    // 类型端口是 serve ⇄ core 的唯一合法通道；有实现时它应存在。
    expect(allowed.length).toBeGreaterThan(0);
  });

  test("ui 兼容层存在且被显式豁免（v0.0.2 清理项，防止悄悄扩散）", async () => {
    const uiFiles = (await listCoreFiles()).filter(isUiCompat);
    expect(uiFiles.length).toBeGreaterThan(0);
    // 终端 API 只允许出现在这个兼容层里。
    const leaks: string[] = [];
    for (const file of (await listCoreFiles()).filter((f) => !isUiCompat(f))) {
      const text = await readFile(file, "utf8");
      if (codeLines(text).some(({ code }) => /process\.stdout/.test(code))) leaks.push(rel(file));
    }
    expect(leaks).toEqual([]);
  });
});
