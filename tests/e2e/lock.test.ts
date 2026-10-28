/**
 * tests/e2e/lock.test.ts — 单写者锁（架构 §13.1 / D15）。
 *
 * 验收：同一 NEO_SESSIONS_DIR/NEO_RUN_DIR 下，第二个 core 进程（--resume 同一会话）
 * 必须启动失败（退出码 2 + 明确冲突信息），且第一个进程不受影响（仍能 attach）；
 * 第一个退出后，锁释放，同 id 可以被重新打开。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TestEnv, runCoreToExit, serveStdioAvailable, type TestEnvOptions } from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/lock] serve 尚未可用：锁 e2e 已跳过");

const TIMEOUT = 30000;

describe.skipIf(!available)("单写者锁", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "第二个进程 --resume 同一会话 → 退出 2；第一个进程仍可 attach；释放后可重开",
    async () => {
      env = await TestEnv.create("lock", { scenario: "tool-then-answer" });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");

      const first = await env.startCore();
      const ready = await first.ready();
      const sessionId = ready.sessionId as string;

      // 先跑一轮，确保会话/transcript 真正落盘。
      const mark = first.mark();
      await first.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "lock-1" }, { since: mark });
      await first.awaitTurnEnd(mark);

      // 第二个进程：同目录 + --resume 同一 sessionId → 必须冲突退出。
      const second = await runCoreToExit({
        dirs: env.dirs,
        fake: env.fake,
        args: ["--resume", sessionId],
        timeoutMs: 20000,
      });
      expect(second.code, `第二个进程应退出 2，实际 ${second.code}；stderr=${second.stderr}`).toBe(2);
      expect(second.stderr).toMatch(/另一个进程|正在运行|conflict|锁/);
      // 失败进程不得输出 ready 帧（stdio 模式下 stdout 只出帧）。
      const secondFrames = second.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => {
          try {
            return JSON.parse(l) as { kind?: string };
          } catch {
            return null;
          }
        });
      expect(secondFrames.some((f) => f?.kind === "ready")).toBe(false);

      // 第一个进程不受影响：还能 attach + 跑命令。
      const mark2 = first.mark();
      await first.requestOk({ type: "session.attach" }, { since: mark2 });
      const snap = await first.awaitFrame((f) => f.kind === "snapshot", "第一个进程 snapshot", {
        since: mark2,
      });
      expect((snap.snapshot as any).meta.id).toBe(sessionId);
      const mark3 = first.mark();
      first.send({ type: "ping" });
      await first.awaitFrame((f) => f.kind === "pong", "第一个进程 pong", { since: mark3 });

      // 释放锁：第一个退出后，同 id 可被重新打开（--resume 成功拿到 ready）。
      await env.stopCore();
      const third = await env.startCore({ args: ["--resume", sessionId] });
      const ready3 = await third.ready();
      expect(ready3.sessionId).toBe(sessionId);
      expect(ready3.epoch).toBe(ready.epoch);
    },
    TIMEOUT,
  );
});
