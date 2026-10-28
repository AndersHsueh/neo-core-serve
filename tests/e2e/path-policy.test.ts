/**
 * tests/e2e/path-policy.test.ts — PathPolicy 的工具层接线（brief §2.1 / 验收 2）。
 *
 * 单测（tests/unit/path-policy.test.ts）保证 PathPolicy 本体正确；这里保证
 * **工具真的接上了**：越界读 /etc/passwd、越界写 ../../escaped.txt 必须变成
 * 可见的工具错误（tool.end state=error，输出说明拒绝原因），且不产生副作用。
 *
 * 探针：`src/core/tools/index.ts` 出现 PathPolicy 接线才启用（v0.0.1 的
 * read_file 直接 resolve 后读，未做 cwd 约束，因此该用例在接线前必须红/跳过）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TestEnv, serveStdioAvailable } from "../helpers.ts";

const available = await serveStdioAvailable();
const TOOLS_FILE = join(import.meta.dir, "../../src/core/tools/index.ts");

async function pathPolicyIntegrated(): Promise<boolean> {
  if (!existsSync(join(import.meta.dir, "../../src/core/path.ts"))) return false;
  try {
    const src = await readFile(TOOLS_FILE, "utf8");
    return /PathPolicy|createPathPolicy|pathPolicy/.test(src);
  } catch {
    return false;
  }
}

const integrated = available ? await pathPolicyIntegrated() : false;
if (available && !integrated) {
  console.warn("[e2e/path-policy] PathPolicy 尚未接入 tools：工具层负样本已跳过（接线后自动启用）");
}

const TIMEOUT = 30000;

describe.skipIf(!available || !integrated)("PathPolicy 工具层", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "越界读 /etc/passwd：工具可见拒绝（tool.end=error），轮继续",
    async () => {
      env = await TestEnv.create("path-escape-read", { scenario: "path-escape" });
      const core = await env.startCore();
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "读个越界文件", clientId: "path-1" }, { since: mark });
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      expect((end.event as any).error ?? null).toBeNull();

      const events = core.eventsSince(mark);
      const toolStarts = events.filter((f) => f.event?.type === "tool.start").map((f) => f.event);
      expect(toolStarts.map((e) => e.name)).toContain("read_file");

      const readEnd = events.find(
        (f) =>
          f.event?.type === "tool.end" &&
          toolStarts.find((s) => s.blockId === f.event.blockId)?.name === "read_file",
      )?.event;
      expect(readEnd, "缺 read_file 的 tool.end").toBeDefined();
      expect(readEnd!.state, "越界读必须是错误终态，不能 ok").toBe("error");
      expect(String(readEnd!.output)).toMatch(/拒绝|denied|PathDenied|越界|out of|within|cwd/i);
      // 绝不能把 /etc/passwd 的内容泄露进工具输出。
      expect(String(readEnd!.output)).not.toMatch(/root:.*:0:0:/);

      // 模型继续拿到错误结果并给出最终回答（工具拒绝不是进程级失败）。
      const assistantText = events
        .filter((f) => f.event?.type === "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("越界操作都被拒了");
    },
    TIMEOUT,
  );

  test(
    "越界写 ../../escaped.txt：工具可见拒绝且文件未落盘",
    async () => {
      env = await TestEnv.create("path-escape-write", { scenario: "path-escape" });
      const core = await env.startCore();
      const escapedPath = resolve(env.dirs.work, "../../escaped.txt");
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "写个越界文件", clientId: "path-2" }, { since: mark });
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");

      const events = core.eventsSince(mark);
      const toolStarts = events.filter((f) => f.event?.type === "tool.start").map((f) => f.event);
      const writeStart = toolStarts.find((e) => e.name === "write_file");
      expect(writeStart, "缺 write_file 的 tool.start").toBeDefined();
      const writeEnd = events.find(
        (f) => f.event?.type === "tool.end" && f.event.blockId === writeStart!.blockId,
      )?.event;
      expect(writeEnd, "缺 write_file 的 tool.end").toBeDefined();
      expect(writeEnd!.state, "越界写必须是错误终态，不能 ok").toBe("error");
      expect(String(writeEnd!.output)).toMatch(/拒绝|denied|PathDenied|越界|outside|cwd/i);

      // 被拒路径绝不能落盘。
      expect(existsSync(escapedPath), `越界文件被创建了：${escapedPath}`).toBe(false);
    },
    TIMEOUT,
  );
});
