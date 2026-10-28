#!/usr/bin/env bun
/**
 * scripts/deps-scan.ts — 传递依赖扫描：找出最终依赖 ui/tui/input 的模块。
 *
 * 用法：
 *   bun run scripts/deps-scan.ts                 # 扫 neo/src（默认）
 *   bun run scripts/deps-scan.ts <dir> [--json]
 *
 * C0.1 用它证明「哪些模块不能直接搬」；C0b 用它核对纯模块清单。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((a) => !a.startsWith("--"));
const ROOT = resolve(positional[0] ?? join(import.meta.dir, "..", "..", "neo", "src"));

type Node = { path: string; imports: string[] };
const nodes = new Map<string, Node>();

const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (entry.name.endsWith(".ts")) nodes.set(abs, { path: abs, imports: [] });
  }
};
walk(ROOT);

const resolveSpec = (from: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, base.replace(/\.ts$/, "") + ".ts", join(base, "index.ts")]) {
    if (nodes.has(cand)) return cand;
  }
  return null;
};

for (const [path, node] of nodes) {
  const text = readFileSync(path, "utf8");
  for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
    const target = resolveSpec(path, m[1] ?? "");
    if (target) node.imports.push(target);
  }
}

const uiDir = join(ROOT, "ui") + "/";
const tuiDir = join(ROOT, "tui") + "/";
const inputDir = join(ROOT, "input") + "/";
const entryLike = (p: string): boolean =>
  p === join(ROOT, "index.ts") || p === join(ROOT, "agent.ts");

const reaches = (start: string): boolean => {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur.startsWith(uiDir) || cur.startsWith(tuiDir) || cur.startsWith(inputDir)) return true;
    for (const next of nodes.get(cur)?.imports ?? []) stack.push(next);
  }
  return false;
};

const affected: string[] = [];
const direct: string[] = [];
for (const node of nodes.values()) {
  const text = readFileSync(node.path, "utf8");
  if (/from\s+"\.\.?\/(ui|tui|input)\//.test(text)) direct.push(node.path);
  if (!node.path.startsWith(uiDir) && !node.path.startsWith(tuiDir) && !node.path.startsWith(inputDir) && reaches(node.path)) {
    affected.push(node.path);
  }
}

const rel = (p: string): string => relative(ROOT, p);
if (json) {
  console.log(JSON.stringify({ root: ROOT, direct: direct.map(rel), affected: affected.map(rel) }, null, 2));
} else {
  console.log(`root: ${ROOT}`);
  console.log(`direct ui/tui/input imports (${direct.length}):`);
  for (const p of direct.map(rel).sort()) console.log(`  ${p}`);
  console.log(`\nmodules whose transitive closure reaches ui/tui/input (${affected.length}):`);
  for (const p of affected.map(rel).sort()) console.log(`  ${p}`);
  console.log(`\nentry-like: ${[...nodes.keys()].filter(entryLike).map(rel).join(", ") || "(none)"}`);
}
