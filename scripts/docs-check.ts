#!/usr/bin/env bun
/**
 * scripts/docs-check.ts — 文档/协议一致性闸门（C0 最小版）。
 *
 * 检查：
 *  1. protocol.lock.json 与 protocol 文件哈希一致；
 *  2. protocol 目录只允许内部相对 import（零外部依赖）；
 *  3. 文档/README/AGENTS/wiki 的 markdown 链接可解析；
 *  4. wiki 主题页有摘要 + 日期戳；[[wiki]] 链接指向存在的页面；
 *  5. package.json version 与 src/main.ts CORE_VERSION 一致；
 *  6. commands.json 若存在，校验基本 schema（C1.7 前允许不存在）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const failures: string[] = [];
const fail = (msg: string): void => {
  failures.push(msg);
};

/* 1. protocol lock -------------------------------------------------- */
const lockPath = join(ROOT, "protocol.lock.json");
if (!existsSync(lockPath)) {
  fail("protocol.lock.json 不存在（先跑 bun run freeze:protocol）");
} else {
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    files?: Record<string, string>;
  };
  for (const [rel, expected] of Object.entries(lock.files ?? {})) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      fail(`lock 中的文件不存在：${rel}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (actual !== expected) fail(`协议文件已改但 lock 未更新：${rel}`);
  }
}

/* 2. protocol purity ------------------------------------------------ */
const protocolDir = join(ROOT, "src/protocol");
for (const name of readdirSync(protocolDir).filter((n) => n.endsWith(".ts"))) {
  const text = readFileSync(join(protocolDir, name), "utf8");
  for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = m[1] ?? "";
    if (!spec.startsWith("./")) fail(`protocol/${name} 出现非内部 import：${spec}`);
  }
  if (/\bDate\.now\(|\bMath\.random\(/.test(text)) fail(`protocol/${name} 含非确定性调用（Date.now/Math.random）`);
}

/* 3+4. markdown links & wiki --------------------------------------- */
const mdFiles: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (entry.name.endsWith(".md")) mdFiles.push(abs);
  }
};
for (const dir of ["docs", ".neo/wiki/wiki"]) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
for (const f of ["README.md", "AGENTS.md"]) if (existsSync(join(ROOT, f))) mdFiles.push(join(ROOT, f));

for (const file of mdFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    const target = m[1] ?? "";
    if (target.startsWith("http")) continue;
    if (!existsSync(normalize(join(dirname(file), target)))) {
      fail(`${relative(ROOT, file)} 断链 → ${target}`);
    }
  }
  if (file.includes("/.neo/wiki/wiki/")) {
    const name = basename(file, ".md");
    if (!["INDEX", "log"].includes(name)) {
      if (!/^## 摘要/m.test(text)) fail(`wiki/${name} 缺「## 摘要」`);
      if (!/^> 最后更新:\d{4}-\d{2}-\d{2}/m.test(text)) fail(`wiki/${name} 缺日期戳`);
    }
    for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = (m[1] ?? "").trim();
      if (!existsSync(join(ROOT, ".neo/wiki/wiki", `${target}.md`))) {
        fail(`wiki/${name} [[${target}]] 指向不存在的页面`);
      }
    }
  }
}

/* 5. versions ------------------------------------------------------- */
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
const mainText = readFileSync(join(ROOT, "src/main.ts"), "utf8");
const coreVersion = /const CORE_VERSION = "([^"]+)"/.exec(mainText)?.[1];
if (!coreVersion || coreVersion !== pkg.version) {
  fail(`版本不一致：package.json=${pkg.version} main.ts=${coreVersion}`);
}

/* 6. commands.json (optional in C0) -------------------------------- */
const catalogPath = join(ROOT, "src/protocol/commands.json");
if (existsSync(catalogPath)) {
  const cat = JSON.parse(readFileSync(catalogPath, "utf8")) as { commands?: unknown };
  if (!Array.isArray(cat.commands)) fail("commands.json 缺少 commands 数组");
}

if (failures.length > 0) {
  console.error(`docs:check FAILED（${failures.length}）`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(`docs:check OK（${mdFiles.length} 个 md，${readdirSync(protocolDir).length} 个协议文件）`);
