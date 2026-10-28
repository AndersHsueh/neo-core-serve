/**
 * tests/unit/sequence.test.ts — seq/epoch 不变量 + 协议帧契约（在真实 stdio 进程上取证）。
 *
 * 断言（协议 v1.2 §3 / §5）：
 *  - 每一帧都能被 protocol/guards.decodeServerMessage 接受（宽进严出的边界契约）。
 *  - durable 事件 seq 严格 +1；ephemeral 事件 seq = 当前最高 durable seq（不推进）。
 *  - 事件信封 sessionId、snapshot.epoch 与 ready 一致。
 *  - assistant.end.text 是权威全文 = delta 累积（v1.2 §5.1）。
 *
 * 用 stdio 子进程而非直连 Host：seq/epoch 是「跨进程 + 持久化」的契约，
 * 只有真实进程边界才能证明 host 没把 seq 分配漏到 serve 层。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeServerMessage } from "../../src/protocol/index.ts";
import {
  TestEnv,
  findTranscript,
  readTranscriptLines,
  serveStdioAvailable,
  transcriptEventOf,
  type Frame,
  type TestEnvOptions,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[unit/sequence] serve --stdio 尚未可用：跳过");

const DURABLE = new Set([
  "turn.start",
  "assistant.start",
  "assistant.end",
  "reasoning.start",
  "reasoning.end",
  "tool.start",
  "tool.end",
  "approval.request",
  "approval.resolve",
  "question.request",
  "question.resolve",
  "tier.switch",
  "stats",
  "banner",
  "session.meta",
  "session.status",
  "context",
  "peer.update",
  "error",
  "auth.expired",
  "turn.aborted",
  "compact.start",
  "compact.end",
  "command.result",
  "session.cleared",
]);

const TIMEOUT = 30000;

describe.skipIf(!available)("seq / epoch 不变量", () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function runTurn(name: string, options: TestEnvOptions = {}) {
    env = await TestEnv.create(name, options);
    await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
    const core = await env.startCore();
    const ready = await core.ready();
    const mark = core.mark();
    await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "seq-1" }, { since: mark });
    await core.awaitTurnEnd(mark);
    return { core, ready, mark };
  }

  test(
    "所有帧都能被 guards 接受；durable seq 严格 +1，ephemeral 不推进",
    async () => {
      const { core, ready } = await runTurn("seq-invariants");

      // 1) 边界契约：真实服务端产出的每一帧都必须过 guards。
      for (const [i, frame] of core.frames.entries()) {
        const decoded = decodeServerMessage(frame);
        expect(decoded.ok, `第 ${i} 帧被 guards 拒绝：${JSON.stringify(frame)}`).toBe(true);
      }
      expect(ready.v).toBe(1);
      expect(core.nonJsonStdout).toEqual([]);

      // 2) 信封一致性。
      const eventFrames = core.frames.filter((f) => f.kind === "event");
      expect(eventFrames.length).toBeGreaterThan(5);
      for (const f of eventFrames) {
        expect(f.sessionId).toBe(ready.sessionId);
        expect(typeof f.seq).toBe("number");
        expect(typeof f.event?.type).toBe("string");
        // seq 只属于信封：事件体内不得再带一份（协议 §3，serve 负责剥离）。
        expect("seq" in (f.event as object), `事件体内不应出现 seq：${JSON.stringify(f.event)}`).toBe(false);
      }

      // 3) seq 语义：durable 必须连续 +1；ephemeral 必须等于当前最高 durable seq。
      let lastDurable: number | null = null;
      for (const f of eventFrames) {
        const type = f.event.type as string;
        const seq = f.seq as number;
        if (lastDurable === null) {
          lastDurable = DURABLE.has(type) ? seq - 1 : seq;
        }
        if (DURABLE.has(type)) {
          expect(seq, `durable 事件 ${type} 的 seq 必须在上一个 durable 基础上 +1`).toBe(lastDurable + 1);
          lastDurable = seq;
        } else {
          expect(seq, `ephemeral 事件 ${type} 不得推进 seq`).toBe(lastDurable);
        }
      }
      expect(lastDurable ?? 0).toBeGreaterThan(0);

      // 4) snapshot.seq = 最高 durable seq，epoch 与 ready 一致。
      const mark2 = core.mark();
      await core.requestOk({ type: "session.attach" }, { since: mark2 });
      const snapFrame = await core.awaitFrame((f) => f.kind === "snapshot", "snapshot", { since: mark2 });
      const snap = snapFrame.snapshot as any;
      expect(snap.epoch).toBe(ready.epoch);
      expect(snapFrame.seq).toBe(lastDurable ?? -1);
      expect(snap.seq).toBe(lastDurable ?? -1);
      expect(snapFrame.sessionId).toBe(ready.sessionId);
    },
    TIMEOUT,
  );

  test(
    "assistant.end.text 是权威全文（= delta 累积），reasoning 同规则",
    async () => {
      const { core } = await runTurn("authoritative-text");
      const frames = core.frames;

      const deltas = new Map<string, string>();
      for (const f of frames) {
        if (f.kind !== "event" || f.event?.type !== "assistant.delta") continue;
        const id = f.event.blockId as string;
        deltas.set(id, (deltas.get(id) ?? "") + String(f.event.text ?? ""));
      }
      expect(deltas.size).toBeGreaterThanOrEqual(1);

      const ends = frames.filter((f) => f.kind === "event" && f.event?.type === "assistant.end");
      expect(ends.length).toBeGreaterThanOrEqual(1);
      for (const f of ends) {
        const id = f.event.blockId as string;
        if (typeof f.event.text !== "string") continue;
        if (!deltas.has(id)) continue;
        expect(deltas.get(id), `block ${id} 的 delta 累积与 assistant.end.text 不一致`).toBe(f.event.text);
      }

      // reasoning.end.text 同样是权威全文。
      const rDeltas = new Map<string, string>();
      for (const f of frames) {
        if (f.kind !== "event" || f.event?.type !== "reasoning.delta") continue;
        const id = f.event.blockId as string;
        rDeltas.set(id, (rDeltas.get(id) ?? "") + String(f.event.text ?? ""));
      }
      const rEnd = frames.find((f) => f.kind === "event" && f.event?.type === "reasoning.end");
      expect(rEnd).toBeDefined();
      if (typeof rEnd!.event.text === "string" && rDeltas.has(rEnd!.event.blockId)) {
        expect(rDeltas.get(rEnd!.event.blockId)).toBe(rEnd!.event.text);
      }
    },
    TIMEOUT,
  );

  test(
    "ephemeral 不写 transcript：transcript 里不得出现 */delta 事件",
    async () => {
      const { core } = await runTurn("ephemeral-transcript");
      const ready = core.frames.find((f) => f.kind === "ready") as Frame;
      await core.close();
      const path = await findTranscript(env!.dirs, ready.sessionId as string);
      expect(path).not.toBeNull();
      const lines = await readTranscriptLines(path as string);
      const events = lines.map((l) => transcriptEventOf(l.parsed)).filter((ev) => ev !== null) as Record<string, any>[];
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        expect(ev["type"], `transcript 不得持久化 ephemeral 事件`).not.toMatch(/\.delta$/);
      }
    },
    TIMEOUT,
  );
});
