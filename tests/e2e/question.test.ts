/**
 * tests/e2e/question.test.ts — 提问的 v1.1 扩展：多选（keys）与自定义（custom）。
 *
 * 协议 §4.1/§5.1：question.answer 兼容 `key`，支持 `keys[]` 与 `custom`；
 * question.resolve 回 `keys/custom/answerLabel`，由 core 负责把选项标签映射成
 * `o1..on` 的 key。单选场景在 stdio.test.ts 覆盖，这里只测多选与自由输入。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { TestEnv, serveStdioAvailable } from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/question] serve 尚未可用：已跳过");

const TIMEOUT = 30000;

describe.skipIf(!available)("提问：多选 / 自定义", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function ask(name: string) {
    env = await TestEnv.create(name, { scenario: "ask-user-multi" });
    const core = await env.startCore();
    const mark = core.mark();
    await core.requestOk({ type: "turn.send", text: "问我个多选题", clientId: name }, { since: mark });
    const req = await core.awaitEvent("question.request", undefined, { since: mark, timeoutMs: 15000 });
    return { core, mark, ev: req.event as any };
  }

  test(
    "多选：question.request.multiSelect=true，keys[] 回答后 resolve 带 keys/answerLabel",
    async () => {
      const { core, mark, ev } = await ask("question-multi");
      expect(ev.multiSelect).toBe(true);
      expect(ev.allowCustom).not.toBe(false);
      expect(Array.isArray(ev.options)).toBe(true);
      expect(ev.options.length).toBe(3);
      const [first, , third] = ev.options as { key: string; label: string }[];

      const keys = [first!.key, third!.key];
      const res = await core.requestOk({ type: "question.answer", blockId: ev.blockId, keys });
      expect((res.data as any)?.answered).toEqual(keys);

      const resolved = await core.awaitEvent("question.resolve", (e) => e.blockId === ev.blockId, {
        since: mark,
      });
      expect(resolved.event.by).toBe("user");
      expect(resolved.event.keys).toEqual(keys);
      expect(resolved.event.key).toBe(first!.key); // 兼容旧客户端的首选项
      expect(String(resolved.event.answerLabel)).toContain(first!.label);
      expect(String(resolved.event.answerLabel)).toContain(third!.label);
      expect(resolved.event.custom).toBeUndefined();

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const assistantText = core
        .eventsSince(mark)
        .filter((f) => f.event?.type === "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("MULTI_OK");
    },
    TIMEOUT,
  );

  test(
    "自定义回答：question.answer.custom → resolve.custom（不传 key 也能收口）",
    async () => {
      const { core, mark, ev } = await ask("question-custom");
      const custom = "我选自定义：全都要";
      const res = await core.requestOk({ type: "question.answer", blockId: ev.blockId, custom });
      expect((res.data as any)?.answered).toEqual([]);

      const resolved = await core.awaitEvent("question.resolve", (e) => e.blockId === ev.blockId, {
        since: mark,
      });
      expect(resolved.event.by).toBe("user");
      expect(resolved.event.custom).toBe(custom);
      expect(resolved.event.keys ?? []).toEqual([]);
      expect(String(resolved.event.answerLabel)).toContain(custom);

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
    },
    TIMEOUT,
  );
});
