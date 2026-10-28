#!/usr/bin/env bun
/**
 * scripts/e2e-stdio.ts — stdio 端到端单跑入口（供 verify.sh / CI / 本地排查）。
 *
 * 跑 `bun test tests/e2e tests/unit`，并额外保证：
 *  - 输出实时透传（失败信息不丢）；
 *  - `E2E_REQUIRE=1` 时，出现任何 skip 即失败（防止「实现没就绪 → 全 skip → 假绿」）；
 *  - 失败时打印可直接复现的最小命令。
 *
 * 用法：
 *   bun run scripts/e2e-stdio.ts                 # 单跑 e2e + 服务契约单测
 *   E2E_REQUIRE=1 bun run scripts/e2e-stdio.ts   # 闸门模式：不许 skip
 *   bun run scripts/e2e-stdio.ts -t 审批         # 透传 bun test 的 -t 过滤
 *
 * 不需要网络/真实 LLM：测试会自起 scripts/fake-llm.ts，并把 NEO_* 指到临时目录。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REQUIRE = process.env["E2E_REQUIRE"] === "1";

const passthrough = process.argv.slice(2);
const cmd = [process.execPath, "test", join(ROOT, "tests", "e2e"), join(ROOT, "tests", "unit"), ...passthrough];

if (!existsSync(join(ROOT, "src", "serve", "stdio.ts")) || !existsSync(join(ROOT, "src", "core", "session-host.ts"))) {
  console.error("[e2e] 警告：serve/stdio 或 session-host 尚未落地，e2e 会被 skip。");
}

const proc = Bun.spawn({
  cmd,
  cwd: ROOT,
  env: {
    ...process.env,
    // 防止宿主环境把测试引到真实 ~/.neo 或真实 LLM；具体值由测试 harness 覆盖。
    NEO_MEMORY_DISABLE: process.env["NEO_MEMORY_DISABLE"] ?? "1",
  },
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});

let skipCount = 0;
let failCount = 0;
let output = "";

async function pump(stream: ReadableStream<Uint8Array>, to: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const text = decoder.decode(value, { stream: true });
      output += text;
      if (text.includes("(skip)")) skipCount += 1;
      if (/\(fail\)/.test(text)) failCount += 1;
      to(text);
    }
    const tail = decoder.decode();
    if (tail) {
      output += tail;
      to(tail);
    }
  } catch {
    /* 进程退出时流关闭 */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, (t) => process.stdout.write(t)), pump(proc.stderr as ReadableStream<Uint8Array>, (t) => process.stderr.write(t))]);
const code = await proc.exited;

// 汇总：bun test 的尾部 summary 更权威，这里只做「不许 skip」的闸门。
const skipped = /(\d+)\s+skip/.exec(output);
const totalSkip = skipped?.[1] ?? String(skipCount);
const failed = /(\d+)\s+fail/.exec(output);

if (code !== 0) {
  console.error("\n[e2e] 失败。最小复现：");
  console.error("  bun test tests/e2e/stdio.test.ts -t '<用例名>'");
  console.error("  调试时设 KEEP_TMP=1 保留临时目录（路径见错误信息）。");
  process.exit(code);
}

if (REQUIRE && (totalSkip !== "0" || skipCount > 0)) {
  console.error(`\n[e2e] E2E_REQUIRE=1 但出现 skip（${totalSkip} 个）：实现可能未就绪，拒绝假绿。`);
  process.exit(1);
}

console.log(`\n[e2e] OK（skip=${totalSkip}${failed ? `, fail=${failed[1]}` : ""}）`);
process.exit(0);
