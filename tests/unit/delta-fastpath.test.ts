/**
 * tests/unit/delta-fastpath.test.ts — delta 快路径与 reducer 一致性（brief §2.2/验收 3）。
 *
 * coder 对 assistant.delta / reasoning.delta 做了「只改当前 block」的快路径优化；
 * 本文件从外部行为锁住它不能改变可观测结果：
 *  1. 长 delta 会话（BURST_FRAMES=200）：assistant.end.text 精确、delta 累积一致、
 *     快照里的 assistant 块正文与权威全文一致（多次跑不 flake）。
 *  2. 快照 blocks 必须等于「用 protocol reducer 重放 transcript」的结果
 *     （快路径与 durable reducer 两条路不能分叉）。
 *  3. reasoning 同理：reasoning.end.text 为权威全文、快照块文本一致。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEvents } from "../../src/protocol/index.ts";
import type { SessionState } from "../../src/protocol/index.ts";
import {
  TestEnv,
  findTranscript,
  readTranscriptLines,
  serveStdioAvailable,
  transcriptEventOf,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[unit/delta-fastpath] serve 尚未可用：已跳过");

const TIMEOUT = 40000;

/**
 * 重放校正（与 core 的实现同一条规则）：delta 是 ephemeral、不写 transcript，
 * 而 reducer 的 end 分支只收口、不消费权威 text。所以重放前必须把
 * assistant.end.text / reasoning.end.text 展开成一条全量 delta，才能得到与
 * 在线累加一致的视图。这里刻意在测试侧独立实现一遍，用于交叉验证。
 */
function expandReplay(events: any[]): any[] {
  const out: any[] = [];
  for (const event of events) {
    if (event.type === "assistant.end" && event.text) {
      out.push({ type: "assistant.delta", blockId: event.blockId, text: event.text });
    } else if (event.type === "reasoning.end" && event.text) {
      out.push({ type: "reasoning.delta", blockId: event.blockId, text: event.text });
    }
    out.push(event);
  }
  return out;
}

function expectedBurstText(frames: number): string {
  let text = "";
  for (let i = 0; i < frames; i++) text += `${i}.`;
  return `${text}END`;
}

describe.skipIf(!available)("delta 快路径一致性", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "长 delta 会话：权威全文/累积/快照三处一致，连续多轮不 flake",
    async () => {
      const frames = 200;
      env = await TestEnv.create("delta-burst", { scenario: "burst", fakeEnv: { BURST_FRAMES: String(frames) } });
      const core = await env.startCore();
      const expected = expectedBurstText(frames);

      // 连续 3 轮：每轮正文都必须精确等于期望（防「快路径漏拼接/错位」）。
      for (let turn = 1; turn <= 3; turn++) {
        const mark = core.mark();
        await core.requestOk(
          { type: "turn.send", text: `burst-${turn}`, clientId: `burst-${turn}` },
          { since: mark },
        );
        const end = await core.awaitTurnEnd(mark);
        expect(end.event.type).toBe("stats");
        const events = core.eventsSince(mark);
        const ends = events.filter((f) => f.event?.type === "assistant.end").map((f) => f.event);
        expect(ends.length).toBeGreaterThanOrEqual(1);
        const authoritative = ends.map((e: any) => String(e.text ?? "")).join("");
        expect(authoritative, `第 ${turn} 轮 assistant.end.text 不完整`).toBe(expected);

        // delta 累积（ephemeral，可能被合批）与权威全文一致。
        const deltas = events
          .filter((f) => f.event?.type === "assistant.delta")
          .map((f) => String(f.event.text ?? ""))
          .join("");
        if (deltas.length > 0) expect(deltas, `第 ${turn} 轮 delta 累积与权威全文不一致`).toBe(expected);
      }

      // 快照里的 assistant 块正文 = 权威全文（不能是半截）。
      const mark = core.mark();
      await core.requestOk({ type: "session.attach" }, { since: mark });
      const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "snapshot", { since: mark }))
        .snapshot as any;
      const assistantBlocks = (snap.blocks as any[]).filter((b) => b.kind === "assistant");
      expect(assistantBlocks.length).toBeGreaterThanOrEqual(3);
      for (const block of assistantBlocks) {
        const text = (block.segments as any[])
          .filter((s) => s.type === "p")
          .map((s) => String(s.text ?? ""))
          .join("");
        expect(text).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "快照 blocks === protocol reducer 重放 transcript 的结果（快路径不分叉）",
    async () => {
      env = await TestEnv.create("delta-replay", {
        scenario: "burst",
        fakeEnv: { BURST_FRAMES: "80" },
      });
      const core = await env.startCore();
      const ready = await core.ready();

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "一致性校验", clientId: "replay-1" }, { since: mark });
      await core.awaitTurnEnd(mark);

      const mark2 = core.mark();
      await core.requestOk({ type: "session.attach" }, { since: mark2 });
      const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "snapshot", { since: mark2 }))
        .snapshot as any;
      await core.close();

      const path = await findTranscript(env.dirs, ready.sessionId as string);
      expect(path, "找不到 transcript").not.toBeNull();
      const lines = await readTranscriptLines(path as string);
      const entries = lines
        .map((l) => l.parsed)
        .filter((p): p is Record<string, any> => p !== null);
      const pairs = entries
        .map((p) => ({
          seq: Number(p["seq"] ?? p["event"]?.["seq"] ?? 0),
          event: transcriptEventOf(p),
        }))
        .filter((x): x is { seq: number; event: Record<string, any> } => x.event !== null)
        .sort((a, b) => a.seq - b.seq);
      const events = pairs.map((p) => p.event) as any[];
      expect(events.length).toBeGreaterThan(0);

      const initial: SessionState = {
        meta: snap.meta,
        seq: 0,
        blocks: [],
        context: { used: 0, limit: 0, compactAt: 0.75 },
        streaming: { turnActive: false },
      };
      const replayed = applyEvents(initial, expandReplay(events));
      expect(JSON.stringify(replayed.blocks), "快照 blocks 与 transcript 重放结果不一致").toBe(
        JSON.stringify(snap.blocks),
      );
      // seq 由 host 分配（reducer 不负责），核对 snapshot.seq = transcript 最高 durable seq。
      const maxEventSeq = pairs.reduce((m, p) => Math.max(m, p.seq), 0);
      expect(Number(snap.seq)).toBe(maxEventSeq);
    },
    TIMEOUT,
  );

  test(
    "reasoning 快路径：reasoning.end.text 权威、delta 累积一致、快照块文本一致",
    async () => {
      env = await TestEnv.create("delta-reasoning", { scenario: "tool-then-answer" });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
      const core = await env.startCore();
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "reason-1" }, { since: mark });
      await core.awaitTurnEnd(mark);
      const events = core.eventsSince(mark);

      const rEnd = events.find((f) => f.event?.type === "reasoning.end")?.event as any;
      expect(rEnd, "缺 reasoning.end").toBeDefined();
      expect(typeof rEnd.text).toBe("string");
      expect(rEnd.text.length).toBeGreaterThan(0);
      const rDeltas = events
        .filter((f) => f.event?.type === "reasoning.delta")
        .map((f) => String(f.event.text ?? ""))
        .join("");
      if (rDeltas.length > 0) expect(rDeltas).toBe(rEnd.text);

      const mark2 = core.mark();
      await core.requestOk({ type: "session.attach" }, { since: mark2 });
      const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "snapshot", { since: mark2 }))
        .snapshot as any;
      const rBlock = (snap.blocks as any[]).find((b) => b.kind === "reasoning");
      expect(rBlock, "快照缺 reasoning 块").toBeDefined();
      expect(rBlock.text).toBe(rEnd.text);
      expect(rBlock.done).toBe(true);
    },
    TIMEOUT,
  );
});
