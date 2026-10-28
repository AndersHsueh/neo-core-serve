/**
 * tests/unit/batcher.test.ts — 每连接事件合批/背压策略（brief §2.3 / 协议 §9）。
 *
 * 直接单测 `src/serve/batcher.ts`（纯类，无 IO）：
 *  - 同 block 的 delta 合并（文本拼接、保留最新 seq）；
 *  - 16ms 定时 flush、4KB/64 帧阈值 flush、close() 冲刷；
 *  - 队列超限：先丢 ephemeral，仍超 → onOverflow（调用方负责 4408）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BATCHER = join(import.meta.dir, "../../src/serve/batcher.ts");
const available = existsSync(BATCHER);
if (!available) console.warn("[unit/batcher] src/serve/batcher.ts 尚未落地：已跳过");

type Frame = any;

async function loadBatcher(): Promise<new (opts: any) => any> {
  const mod = (await import(BATCHER)) as { EventBatcher: new (opts: any) => any };
  return mod.EventBatcher;
}

function delta(blockId: string, text: string, seq: number): Frame {
  return { v: 1, kind: "event", sessionId: "s", seq, event: { type: "assistant.delta", blockId, text } };
}
function durable(type: string, seq: number, extra: Record<string, unknown> = {}): Frame {
  return { v: 1, kind: "event", sessionId: "s", seq, event: { type, ...extra } };
}

describe.skipIf(!available)("EventBatcher", () => {
  test("同 block 的连续 delta 合并：一次发送、文本拼接、seq 取最新", async () => {
    const EventBatcher = await loadBatcher();
    const sent: Frame[] = [];
    const b = new EventBatcher({ send: (f: Frame) => sent.push(f), onOverflow: () => undefined });
    for (let i = 0; i < 50; i++) b.enqueue(delta("blk-a", `${i}.`, i + 1));
    b.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].seq).toBe(50);
    let expected = "";
    for (let i = 0; i < 50; i++) expected += `${i}.`;
    expect(sent[0].event.text).toBe(expected);
    expect(sent[0].event.blockId).toBe("blk-a");
  });

  test("不同 block / 非连续同 block 不合并", async () => {
    const EventBatcher = await loadBatcher();
    const sent: Frame[] = [];
    const b = new EventBatcher({ send: (f: Frame) => sent.push(f), onOverflow: () => undefined });
    b.enqueue(delta("blk-a", "a1", 1));
    b.enqueue(delta("blk-b", "b1", 2));
    b.enqueue(delta("blk-a", "a2", 3));
    b.flush();
    expect(sent.map((f) => f.event.blockId)).toEqual(["blk-a", "blk-b", "blk-a"]);
    expect(sent.map((f) => f.event.text)).toEqual(["a1", "b1", "a2"]);
  });

  test("16ms 定时 flush（不需要显式 flush）", async () => {
    const EventBatcher = await loadBatcher();
    const sent: Frame[] = [];
    const b = new EventBatcher({
      send: (f: Frame) => sent.push(f),
      onOverflow: () => undefined,
      flushMs: 15,
    });
    b.enqueue(durable("turn.start", 1, { turnId: "t1", blockId: "b1", n: 1, at: 1 }));
    expect(sent).toHaveLength(0);
    await Bun.sleep(60);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].event.type).toBe("turn.start");
  });

  test("4KB 阈值立即 flush；64 帧阈值立即 flush", async () => {
    const EventBatcher = await loadBatcher();
    const big: Frame[] = [];
    const b1 = new EventBatcher({ send: (f: Frame) => big.push(f), onOverflow: () => undefined });
    b1.enqueue(delta("blk-big", "x".repeat(5000), 1));
    expect(big.length, "超过 4KB 应同步 flush").toBe(1);
    b1.close();

    const many: Frame[] = [];
    const b2 = new EventBatcher({ send: (f: Frame) => many.push(f), onOverflow: () => undefined });
    for (let i = 0; i < 70; i++) b2.enqueue(durable("banner", i + 1, { blockId: `b${i}`, at: i, level: "info", text: `t${i}` }));
    expect(many.length, "达到 64 帧应同步 flush").toBeGreaterThan(0);
    b2.close();
  });

  test("close() 冲刷残留队列，并忽略之后的 enqueue", async () => {
    const EventBatcher = await loadBatcher();
    const sent: Frame[] = [];
    const b = new EventBatcher({ send: (f: Frame) => sent.push(f), onOverflow: () => undefined });
    b.enqueue(durable("turn.start", 1, { turnId: "t", blockId: "b", n: 1, at: 1 }));
    b.close();
    expect(sent).toHaveLength(1);
    b.enqueue(durable("stats", 2, { blockId: "s", at: 2, durationMs: 1, usage: {}, toolCalls: 0, iterations: 1, tier: "default" }));
    expect(sent).toHaveLength(1);
  });

  test("超限：先丢 ephemeral；durable 仍超限 → onOverflow（4408 由调用方关闭）", async () => {
    const EventBatcher = await loadBatcher();

    // 场景 A：ephemeral 撑爆队列 → 丢光 ephemeral，不触发 overflow。
    const sentA: Frame[] = [];
    let overflowA = 0;
    const a = new EventBatcher({
      send: (f: Frame) => sentA.push(f),
      onOverflow: () => overflowA++,
      maxFrames: 100,
      flushFrames: 10_000, // 避开 64 帧/4KB flush，专测「超限丢 ephemeral」
      flushBytes: 10_000_000,
      flushMs: 10_000,
    });
    // 队列里先有一个 durable，再灌 150 个「不合并」的 ephemeral；
    // 越过 maxFrames 时 ephemeral 应被成批丢弃、durable 保留下来的行为可观测。
    a.enqueue(durable("turn.start", 999, { turnId: "t", blockId: "b", n: 1, at: 1 }));
    for (let i = 0; i < 150; i++) a.enqueue(delta(`blk-${i}`, "x", i));
    a.flush();
    expect(overflowA, "丢 ephemeral 后不应 overflow").toBe(0);
    const deltaSent = sentA.filter((f) => f.event.type === "assistant.delta").length;
    expect(deltaSent, "超出 maxFrames 后应成批丢弃 ephemeral（不能 150 个全发）").toBeLessThan(150);
    expect(sentA.some((f) => f.event.type === "turn.start"), "durable 不能被丢").toBe(true);
    a.close();

    // 场景 B：durable 自己就超限 → onOverflow，且之后停止入队。
    const sentB: Frame[] = [];
    let overflowB = 0;
    const b = new EventBatcher({
      send: (f: Frame) => sentB.push(f),
      onOverflow: () => overflowB++,
      maxFrames: 50,
      flushFrames: 10_000, // 同理：先让 durable 自己把队列撑爆
      flushBytes: 10_000_000,
      flushMs: 10_000,
    });
    for (let i = 0; i < 80; i++) b.enqueue(durable("banner", i, { blockId: `b${i}`, at: i, level: "info", text: `t${i}` }));
    expect(overflowB, "durable 超限必须触发 onOverflow").toBe(1);
    const before = sentB.length;
    b.enqueue(durable("stats", 999, { blockId: "s", at: 1, durationMs: 1, usage: {}, toolCalls: 0, iterations: 1, tier: "default" }));
    expect(sentB.length).toBe(before);
  });

  test("8MB 字节上限同样触发丢 ephemeral / overflow", async () => {
    const EventBatcher = await loadBatcher();
    const sent: Frame[] = [];
    let overflow = 0;
    const b = new EventBatcher({
      send: (f: Frame) => sent.push(f),
      onOverflow: () => overflow++,
      maxBytes: 8 * 1024,
      maxFrames: 10_000,
      flushFrames: 10_000,
      flushBytes: 10_000_000, // 否则默认 4KB 先 flush，永远到不了 maxBytes
      flushMs: 10_000,
    });
    // 大 durable 帧（每帧 ~2KB）：4 帧就过 8KB 上限。
    for (let i = 0; i < 8; i++) {
      b.enqueue(durable("banner", i, { blockId: `b${i}`, at: i, level: "info", text: "y".repeat(2000) }));
    }
    b.flush();
    expect(overflow).toBe(1);
    expect(sent.every((f) => f.event.type !== "assistant.delta")).toBe(true);
  });
});
