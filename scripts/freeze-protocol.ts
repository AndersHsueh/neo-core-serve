#!/usr/bin/env bun
/**
 * scripts/freeze-protocol.ts — 冻结协议：计算协议文件哈希写入 protocol.lock.json。
 *
 * 客户端仓 vendor 协议时以 lock 为准；docs:check 会校验文件未被悄悄改动。
 * 更新协议时：改代码/文档 → 跑 `bun run freeze:protocol` → 提交 lock。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from "../src/protocol/types.ts";

const ROOT = join(import.meta.dir, "..");
const FILES = [
  "src/protocol/types.ts",
  "src/protocol/guards.ts",
  "src/protocol/fixtures.ts",
  "src/protocol/reducer.ts",
  "src/protocol/commands.ts",
  "src/protocol/commands.json",
  "src/protocol/index.ts",
];

const files: Record<string, string> = {};
for (const rel of FILES) {
  const data = readFileSync(join(ROOT, rel));
  files[rel] = createHash("sha256").update(data).digest("hex");
}

const lock = {
  protocolVersion: PROTOCOL_SEMVER,
  wireVersion: PROTOCOL_VERSION,
  sourceRepo: "neo-agent-app/gui/src/protocol",
  sourceCommit: "a52f1f02d034ddfda14e9440ea1764eeea790d10",
  frozenAt: new Date().toISOString().slice(0, 10),
  files,
};

writeFileSync(join(ROOT, "protocol.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
console.log(`protocol locked: v${lock.protocolVersion} (${FILES.length} files)`);
