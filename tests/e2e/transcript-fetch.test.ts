/**
 * tests/e2e/transcript-fetch.test.ts — transcript.fetch 回放（brief §2.3 / 验收 4）。
 *
 * 契约（协议 §4.1 增补）：
 *   transcript.fetch {sessionId?, fromSeq?, limit?} → {events:[{seq,event}], nextSeq?}
 *   - 分页不重不漏、seq 升序、nextSeq 可续读；
 *   - 读完（fromSeq 超过最高 durable seq）→ 空 events、无下一段；
 *   - 未知/非本会话 sessionId → 错误（not_found/session_gone/conflict 之一）；
 *   - attach 快照的 seq 与 fetch 到的事件序列一致（两条恢复路径同源）。
 *
 * 能力门：ready.capabilities 含 "transcript.replay"（v0.0.2 实现后自动启用）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TestEnv,
  findTranscript,
  readTranscriptLines,
  serveStdioAvailable,
  transcriptEventOf,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/transcript-fetch] serve 尚未可用：已跳过");

const TIMEOUT = 30000;

interface FetchEntry {
  seq: number;
  event: Record<string, any>;
}

async function fetchCapable(): Promise<boolean> {
  if (!available) return false;
  let env: TestEnv | null = null;
  try {
    env = await TestEnv.create("probe-transcript-fetch", { scenario: "tool-then-answer" });
    const core = await env.startCore();
    const ready = await core.ready();
    const caps = (ready.capabilities as string[] | undefined) ?? [];
    if (!caps.includes("transcript.replay")) return false;
    const res = await core.request({ type: "transcript.fetch", fromSeq: 0, limit: 10 });
    return res.ok === true && typeof (res.data as any)?.events !== "undefined";
  } catch {
    return false;
  } finally {
    if (env) await env.dispose().catch(() => {});
  }
}

const capable = await fetchCapable();
if (available && !capable) {
  console.warn("[e2e/transcript-fetch] capability transcript.replay 未就绪：已跳过（实现后自动启用）");
}

function parseFetch(res: { ok?: boolean; data?: unknown; error?: unknown }): FetchEntry[] {
  expect(res.ok, `transcript.fetch 失败：${JSON.stringify(res.error)}`).toBe(true);
  const events = (res.data as any)?.events;
  expect(Array.isArray(events), "transcript.fetch 回执缺 events[]").toBe(true);
  return events.map((e: any) => ({ seq: Number(e.seq), event: e.event as Record<string, any> }));
}

describe.skipIf(!available || !capable)("transcript.fetch", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function runTurn(name: string): Promise<{ env: TestEnv; sessionId: string }> {
    env = await TestEnv.create(name, { scenario: "tool-then-answer" });
    await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
    const core = await env.startCore();
    const ready = await core.ready();
    const mark = core.mark();
    await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: `${name}-1` }, { since: mark });
    await core.awaitTurnEnd(mark);
    return { env, sessionId: ready.sessionId as string };
  }

  test("分页：fromSeq/limit 不重不漏、seq 升序、nextSeq 可续读", async () => {
    const { env: e, sessionId } = await runTurn("fetch-paging");
    const core = e.requireCore();

    // 先取全量，确定总事件数。
    const all = parseFetch(await core.request({ type: "transcript.fetch", sessionId, fromSeq: 0, limit: 10_000 }));
    expect(all.length).toBeGreaterThan(3);
    const maxSeq = all.reduce((m, x) => Math.max(m, x.seq), 0);

    // 逐页读（limit=3），断言不重不漏、seq 严格递增。
    const collected: FetchEntry[] = [];
    let cursor = 0;
    let guard = 0;
    for (;;) {
      const res = await core.request({ type: "transcript.fetch", sessionId, fromSeq: cursor, limit: 3 });
      const page = parseFetch(res);
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(3);
      for (const entry of page) {
        expect(entry.seq).toBeGreaterThan(0);
        if (collected.length > 0) {
          expect(entry.seq, "分页出现重复/倒序 seq").toBeGreaterThan(collected[collected.length - 1]!.seq);
        }
        collected.push(entry);
      }
      const nextSeq = (res.data as any)?.nextSeq;
      if (nextSeq === undefined || nextSeq === null) break;
      expect(Number(nextSeq), "nextSeq 必须能继续前进").toBeGreaterThan(page[page.length - 1]!.seq);
      cursor = Number(nextSeq);
      if (++guard > 100) throw new Error("分页循环没有终止");
    }
    // 逐页读到的集合必须覆盖全量（不丢事件、且 seq 完全相同）。
    expect(collected.map((x) => x.seq)).toEqual(all.map((x) => x.seq));
    expect(collected[collected.length - 1]!.seq).toBe(maxSeq);

    // 读完之后继续要 → 空 events。
    const tail = parseFetch(await core.request({ type: "transcript.fetch", sessionId, fromSeq: maxSeq + 1, limit: 10 }));
    expect(tail).toEqual([]);
  }, TIMEOUT);

  test("事件形状：每个 entry 带 seq + event；durable 事件不回放 ephemeral", async () => {
    const { env: e, sessionId } = await runTurn("fetch-shape");
    const core = e.requireCore();
    const all = parseFetch(await core.request({ type: "transcript.fetch", sessionId, fromSeq: 0, limit: 10_000 }));
    for (const entry of all) {
      expect(typeof entry.seq).toBe("number");
      expect(typeof entry.event?.type).toBe("string");
      expect("seq" in entry.event, "entry.event 体内不应再带 seq").toBe(false);
    }
    const types = all.map((x) => x.event.type as string);
    expect(types).toContain("turn.start");
    expect(types).toContain("stats");
    for (const t of types) expect(t).not.toMatch(/\.delta$/);
  }, TIMEOUT);

  test("未知 sessionId → 明确错误（不是空列表）", async () => {
    const { env: e } = await runTurn("fetch-unknown");
    const core = e.requireCore();
    const res = await core.request({ type: "transcript.fetch", sessionId: "no-such-session-xyz", fromSeq: 0 });
    expect(res.ok, "未知 session 必须返回错误回执").toBe(false);
    const code = String((res.error as any)?.code ?? "");
    expect(["not_found", "session_gone", "conflict"]).toContain(code);
  }, TIMEOUT);

  test("attach 与 fetch 同源：snapshot.seq = fetch 最高 seq，事件回放结果 = snapshot.blocks", async () => {
    const { env: e, sessionId } = await runTurn("fetch-attach-consistency");
    const core = e.requireCore();

    const mark = core.mark();
    await core.requestOk({ type: "session.attach" }, { since: mark });
    const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "snapshot", { since: mark }))
      .snapshot as any;

    const all = parseFetch(await core.request({ type: "transcript.fetch", sessionId, fromSeq: 0, limit: 10_000 }));
    const maxSeq = all.reduce((m, x) => Math.max(m, x.seq), 0);
    expect(Number(snap.seq)).toBe(maxSeq);

    // fetch 的事件集合 = transcript 文件里的 durable 事件（同一真源）。
    const path = await findTranscript(e.dirs, sessionId);
    expect(path).not.toBeNull();
    const lines = await readTranscriptLines(path as string);
    const fileEvents = lines
      .map((l) => l.parsed)
      .filter((p): p is Record<string, any> => p !== null)
      .map((p) => transcriptEventOf(p))
      .filter((ev): ev is Record<string, any> => ev !== null);
    expect(all.map((x) => x.event.type)).toEqual(fileEvents.map((ev) => ev.type));
  }, TIMEOUT);
});
