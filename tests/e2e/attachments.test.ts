/**
 * tests/e2e/attachments.test.ts — 图片附件端到端（brief §2.5 / 验收 6）。
 *
 * 链路：turn.send.attachments → host 解码落盘（sessions/attachments/<id>/img-N.*）
 *      → 用户消息带 image_url part → fake LLM `/_requests` 能观测到图片 → 会话 JSON 用
 *      $ref → --resume 后 hydrate 回 data URL（下一轮请求里仍能看到历史图片）。
 * 限制：≤5 张 / 单张 ≤5MB / 仅 png|jpeg|webp。
 *
 * 能力门：ready.capabilities 含 "attachments.image"（实现后自动启用）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TINY_PNG_BASE64,
  TestEnv,
  findAttachmentFiles,
  serveStdioAvailable,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/attachments] serve 尚未可用：已跳过");

const TIMEOUT = 40000;
const FIVE_MB_PLUS = 5 * 1024 * 1024 + 1;

async function attachmentsCapable(): Promise<boolean> {
  if (!available) return false;
  let env: TestEnv | null = null;
  try {
    env = await TestEnv.create("probe-attachments", { scenario: "image-detect" });
    const core = await env.startCore();
    const ready = await core.ready();
    return ((ready.capabilities as string[] | undefined) ?? []).includes("attachments.image");
  } catch {
    return false;
  } finally {
    if (env) await env.dispose().catch(() => {});
  }
}

const capable = await attachmentsCapable();
if (available && !capable) {
  console.warn("[e2e/attachments] capability attachments.image 未就绪：已跳过（实现后自动启用）");
}

function pngAttachment(): { kind: "image"; mime: "image/png"; dataBase64: string } {
  return { kind: "image", mime: "image/png", dataBase64: TINY_PNG_BASE64 };
}

/** 断言附件请求被拒：信封 error 或（兜底）后续 error 事件，错误码/文案可读。 */
async function expectRejected(
  core: { request: (c: Record<string, unknown>, o?: Record<string, unknown>) => Promise<any>; mark(): number; eventsSince(m: number): any[]; awaitTurnEnd(m: number, t?: number): Promise<any> },
  command: Record<string, unknown>,
  label: string,
): Promise<void> {
  const mark = core.mark();
  const res = await core.request(command, { since: mark });
  if (res.ok === false) {
    const code = String(res.error?.code ?? "");
    expect(["too_large", "protocol", "conflict", "forbidden"]).toContain(code);
    expect(String(res.error?.message ?? "").length).toBeGreaterThan(0);
    return;
  }
  // 兜底：某些实现选择先开轮再以 error 事件/ stats.error 收口。
  const end = await core.awaitTurnEnd(mark, 15000).catch(() => null);
  const events = core.eventsSince(mark);
  const errEvent = events.find((f) => f.event?.type === "error")?.event;
  const statsError = end?.event?.error;
  const message = JSON.stringify(errEvent ?? statsError ?? res.data ?? {});
  expect(
    Boolean(errEvent || statsError),
    `${label} 未被拒绝：result=${JSON.stringify(res).slice(0, 300)} events=${JSON.stringify(events.map((f) => f.event?.type))}`,
  ).toBe(true);
  expect(`${errEvent?.code ?? statsError?.code ?? ""} ${message}`).toMatch(/too_large|protocol|附件|图片|large|limit|count|mime|大小|张/i);
}

describe.skipIf(!available || !capable)("图片附件", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "PNG 全链路：fake LLM 收到 image_url → 附件落盘 → 会话 $ref → resume 后 hydrate",
    async () => {
      env = await TestEnv.create("attachments-flow", { scenario: "image-detect" });
      const core = await env.startCore();
      const ready = await core.ready();
      const sessionId = ready.sessionId as string;

      const mark = core.mark();
      await core.requestOk(
        {
          type: "turn.send",
          text: "看看这张图",
          clientId: "att-1",
          attachments: [pngAttachment()],
        },
        { since: mark },
      );
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      expect((end.event as any).error ?? null).toBeNull();

      // 1) 图片真的进了发给模型的 messages（fake 的 /_requests 是唯一可信观测点）。
      const recorded = await env.fake.requests();
      const last = recorded.records[recorded.records.length - 1];
      const withImages = last?.messages.filter((m) => (m.images?.length ?? 0) > 0) ?? [];
      expect(withImages.length, "fake LLM 没收到 image_url part").toBeGreaterThan(0);
      expect(withImages[0]!.images![0]!.mime).toBe("image/png");
      expect(withImages[0]!.images![0]!.approxBytes).toBeGreaterThan(0);

      // 2) 模型能感知图片数量（fake 回显 SAW_IMAGES_n）。
      const assistantText = core
        .eventsSince(mark)
        .filter((f) => f.event?.type === "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("SAW_IMAGES_1");

      // 3) 附件文件落盘 + 会话 JSON 用 $ref（不内联 base64）。
      const files = await findAttachmentFiles(env.dirs, sessionId);
      expect(files.length, "attachments 目录里没有落盘文件").toBeGreaterThan(0);
      const fileContents = await readFile(files[0]!, "utf8").catch(() => "");
      void fileContents;
      const sessionJson = await readFile(join(env.dirs.sessions, `${sessionId}.json`), "utf8");
      expect(sessionJson).toMatch(/"\$ref"|attachments\//);
      expect(sessionJson).not.toContain(TINY_PNG_BASE64);

      // 4) --resume 后 hydrate：再跑一轮，历史 user 消息里的图片仍在请求里。
      await core.close();
      const resumed = await env.startCore({ args: ["--resume", sessionId] });
      const ready2 = await resumed.ready();
      expect(ready2.sessionId).toBe(sessionId);
      const mark2 = resumed.mark();
      await resumed.requestOk({ type: "turn.send", text: "继续", clientId: "att-2" }, { since: mark2 });
      await resumed.awaitTurnEnd(mark2);
      const recorded2 = await env.fake.requests();
      const last2 = recorded2.records[recorded2.records.length - 1];
      const hydrated = last2?.messages.filter((m) => (m.images?.length ?? 0) > 0) ?? [];
      expect(hydrated.length, "resume 后历史图片未被 hydrate 回请求").toBeGreaterThan(0);
      expect(hydrated[0]!.images![0]!.mime).toBe("image/png");
    },
    TIMEOUT,
  );

  test("超 5 张被拒", async () => {
    env = await TestEnv.create("attachments-too-many", { scenario: "image-detect" });
    const core = await env.startCore();
    await expectRejected(
      core,
      {
        type: "turn.send",
        text: "六张图",
        clientId: "att-many",
        attachments: Array.from({ length: 6 }, () => pngAttachment()),
      },
      "6 张附件",
    );
  }, TIMEOUT);

  test("单张 >5MB 被拒", async () => {
    env = await TestEnv.create("attachments-too-large", { scenario: "image-detect" });
    const core = await env.startCore();
    const bigBase64 = Buffer.alloc(FIVE_MB_PLUS).toString("base64");
    await expectRejected(
      core,
      {
        type: "turn.send",
        text: "超大图",
        clientId: "att-large",
        attachments: [{ kind: "image", mime: "image/png", dataBase64: bigBase64 }],
      },
      "5MB+ 附件",
    );
  }, TIMEOUT);

  test("非图片 mime 被拒（image/gif 不在白名单）", async () => {
    env = await TestEnv.create("attachments-bad-mime", { scenario: "image-detect" });
    const core = await env.startCore();
    await expectRejected(
      core,
      {
        type: "turn.send",
        text: "gif",
        clientId: "att-mime",
        attachments: [{ kind: "image", mime: "image/gif" as any, dataBase64: TINY_PNG_BASE64 }],
      },
      "image/gif",
    );
  }, TIMEOUT);
});
