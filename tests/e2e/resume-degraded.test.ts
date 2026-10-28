/**
 * tests/e2e/resume-degraded.test.ts — 旧会话（有 messages、无 transcript）的恢复路径。
 *
 * 架构 §7.3：旧会话没有 transcript → 从 messages **有损重建** blocks，标 degraded、
 * 生成新 epoch；服务必须能起来、能 attach，并且还能继续跑新轮。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TestEnv, serveStdioAvailable } from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/resume-degraded] serve 尚未可用：已跳过");

const TIMEOUT = 30000;

describe.skipIf(!available)("旧会话 degraded 恢复", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "无 transcript 的旧会话 --resume：ready 正常、blocks 有损重建、可继续新轮",
    async () => {
      env = await TestEnv.create("resume-degraded", { scenario: "tool-then-answer" });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");

      // 手工造一个 v0.4.x 形态的旧会话：只有 <id>.json（messages），没有 transcript。
      const id = "20261028-120000-legacy";
      const nowIso = new Date().toISOString();
      const sessionFile = {
        version: 1,
        meta: {
          id,
          path: join(env.dirs.sessions, `${id}.json`),
          createdAt: nowIso,
          updatedAt: nowIso,
          model: "fake-model",
          cwd: env.dirs.work,
          turns: 1,
        },
        messages: [
          { role: "user", content: "旧问题：这是什么？" },
          { role: "assistant", content: "旧回答：这是一个旧会话。" },
        ],
      };
      await writeFile(join(env.dirs.sessions, `${id}.json`), JSON.stringify(sessionFile, null, 2), "utf8");

      const core = await env.startCore({ args: ["--resume", id] });
      const ready = await core.ready();
      expect(ready.sessionId).toBe(id);
      expect(typeof ready.epoch).toBe("string");
      expect((ready.epoch as string).length).toBeGreaterThanOrEqual(8);

      // attach：blocks 由 messages 有损重建（user + assistant 文本块）。
      const mark = core.mark();
      await core.requestOk({ type: "session.attach" }, { since: mark });
      const snapFrame = await core.awaitFrame((f) => f.kind === "snapshot", "degraded snapshot", {
        since: mark,
      });
      const snap = snapFrame.snapshot as any;
      expect(snap.meta.id).toBe(id);
      expect(snap.epoch).toBe(ready.epoch);
      const blocksText = JSON.stringify(snap.blocks);
      expect(blocksText).toContain("旧问题：这是什么？");
      expect(blocksText).toContain("旧回答：这是一个旧会话。");
      // 有损重建要有明确标记（banner 落进视图），不能假装无损。
      expect(`${blocksText}${JSON.stringify(core.frames)}`).toMatch(/degraded|有损重建/);

      // 还能继续跑新轮（旧会话恢复不是只读摆件）。
      const mark2 = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "degraded-1" }, { since: mark2 });
      const end = await core.awaitTurnEnd(mark2);
      expect(end.event.type).toBe("stats");
      expect((end.event as any).error ?? null).toBeNull();

      // 新轮之后 transcript 应已生成（下次恢复不再 degraded）。
      const turned = core.eventsSince(mark2).map((f) => f.event?.type);
      expect(turned).toContain("turn.start");
    },
    TIMEOUT,
  );
});
