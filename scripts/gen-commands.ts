#!/usr/bin/env bun
/**
 * scripts/gen-commands.ts — 从 core 命令注册表生成 protocol/commands.json。
 *
 * 单一来源：命令实现在 src/core/commands/registry.ts；本脚本只做序列化。
 * `docs:check` 会校验生成物与注册表一致（commands 数组，不含 generatedAt）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCommandsJson } from "../src/core/commands/registry.ts";

const ROOT = join(import.meta.dir, "..");
const out = join(ROOT, "src/protocol/commands.json");
const catalog = generateCommandsJson(new Date().toISOString().slice(0, 10));
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`commands.json generated: ${catalog.commands.length} commands -> ${out}`);
