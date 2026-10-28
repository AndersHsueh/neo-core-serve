/**
 * tests/e2e/allow-session.test.ts — allow-session 语义（架构 §8.3）。
 *
 * 契约：
 *  - `allow-session` 只对 write_file/edit_file 生效（内存 allowlist，不落盘）；
 *  - 同 tool 的后续调用不再发 approval.request；
 *  - **shell 永不内存放行**：即使本轮已 allow-session 过，shell 仍要每次审批。
 *
 * fake-llm 的 `allow-session` 场景在一轮里依次调用：write_file(a.txt) →
 * write_file(b.txt) → shell（echo）→ 最终回答，正好覆盖上面三条。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TestEnv, serveStdioAvailable } from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/allow-session] serve 尚未可用：已跳过");

const TIMEOUT = 40000;

describe.skipIf(!available)("allow-session", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "write_file allow-session 后同工具免审批；shell 仍要求审批",
    async () => {
      env = await TestEnv.create("allow-session", { scenario: "allow-session" });
      const core = await env.startCore();

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "写两个文件再跑命令", clientId: "as-1" }, { since: mark });

      // 逐个处理审批：第一个 write_file 用 allow-session，此后一律 allow。
      const decisions: { tool: string; decision: string }[] = [];
      let since = mark;
      for (;;) {
        const { index, frame } = await core.awaitEither(
          [
            {
              label: "approval.request",
              pred: (f) => f.kind === "event" && f.event?.type === "approval.request",
            },
            {
              label: "turn end",
              pred: (f) =>
                f.kind === "event" && (f.event?.type === "stats" || f.event?.type === "turn.aborted"),
            },
          ],
          { since, timeoutMs: 25000 },
        );
        if (index !== 0) break; // 轮收口
        const ev = frame.event;
        const decision = decisions.length === 0 ? "allow-session" : "allow";
        decisions.push({ tool: ev.tool as string, decision });
        since = core.mark();
        await core.requestOk({ type: "approval.resolve", blockId: ev.blockId, decision }, { since });
        since = core.mark();
      }

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");

      // 三个工具调用，但只有两次审批：write a + shell；write b 被 allow-session 放行。
      const events = core.eventsSince(mark);
      const toolStarts = events.filter((f) => f.event?.type === "tool.start").map((f) => f.event);
      expect(toolStarts.map((e) => e.name)).toEqual(["write_file", "write_file", "shell"]);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toEqual({ tool: "write_file", decision: "allow-session" });
      expect(decisions[1]).toEqual({ tool: "shell", decision: "allow" });

      // 两次审批的 resolve 事件：第一次 by=user（allow-session 也记 by user）。
      const resolves = events.filter((f) => f.event?.type === "approval.resolve");
      expect(resolves).toHaveLength(2);
      expect(resolves.every((f) => f.event.by === "user")).toBe(true);
      expect(resolves.every((f) => f.event.state === "allowed")).toBe(true);

      // 两个文件都真的写了（allow-session 不是「假装放行」）。
      expect(await readFile(join(env.dirs.work, "a.txt"), "utf8")).toContain("allow-session A");
      expect(await readFile(join(env.dirs.work, "b.txt"), "utf8")).toContain("allow-session B");

      // shell 真的执行了（而不是被静默跳过）。
      const shellEnd = events.find((f) => f.event?.type === "tool.end" && f.event.blockId === toolStarts[2]!.blockId);
      expect((shellEnd!.event as any).state).toBe("ok");
      expect(String((shellEnd!.event as any).output)).toContain("allow-session-shell");

      // 最终回答来自工具轮之后。
      const assistantText = events
        .filter((f) => f.event?.type === "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("全部完成");
    },
    TIMEOUT,
  );
});
