/**
 * protocol 契约测试：fixtures 编解码 + 未知事件放行 + reducer 确定性。
 */
import { describe, expect, test } from "bun:test";
import {
  EVENT_FIXTURES,
  ENVELOPE_FIXTURES,
  FIXTURE_META,
  INVALID_FIXTURES,
  SNAPSHOT_FIXTURE,
} from "../../src/protocol/fixtures.ts";
import {
  applyEvents,
  decodeClientMessage,
  decodeServerMessage,
  hydrate,
  PROTOCOL_SEMVER,
  PROTOCOL_VERSION,
} from "../../src/protocol/index.ts";
import type { SessionState } from "../../src/protocol/index.ts";

const emptyState = (): SessionState => ({
  meta: { ...FIXTURE_META },
  seq: 0,
  blocks: [],
  context: { used: 0, limit: 0, compactAt: 0.75 },
  streaming: { turnActive: false },
});

describe("信封与事件 fixtures", () => {
  test("每条信封 fixture 都能被 decodeServerMessage 接受", () => {
    for (const fixture of ENVELOPE_FIXTURES) {
      const r = decodeServerMessage(JSON.parse(JSON.stringify(fixture)));
      expect(r.ok).toBe(true);
    }
  });

  test("坏样本必须被拒绝", () => {
    for (const bad of INVALID_FIXTURES) {
      const r = decodeServerMessage(JSON.parse(JSON.stringify(bad)));
      expect(r.ok).toBe(false);
    }
  });

  test("未知事件类型放行（客户端能力降级，不得断连）", () => {
    const future = {
      v: PROTOCOL_VERSION,
      kind: "event",
      sessionId: "s",
      seq: 1,
      event: { type: "future.thing", whatever: 1 },
    };
    expect(decodeServerMessage(future).ok).toBe(true);
  });

  test("snapshot 缺 epoch 必须拒绝", () => {
    const bad = { ...JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) } as Record<string, unknown>;
    delete bad.epoch;
    const r = decodeServerMessage({
      v: PROTOCOL_VERSION,
      kind: "snapshot",
      sessionId: "s",
      seq: 1,
      snapshot: bad,
    });
    expect(r.ok).toBe(false);
  });

  test("未知命令拒绝；mode.set 接受", () => {
    const bad = decodeClientMessage({
      v: PROTOCOL_VERSION,
      kind: "command",
      id: "r1",
      command: { type: "future.command" },
    });
    expect(bad.ok).toBe(false);
    const ok = decodeClientMessage({
      v: PROTOCOL_VERSION,
      kind: "command",
      id: "r2",
      command: { type: "mode.set", mode: "plan" },
    });
    expect(ok.ok).toBe(true);
  });

  test("协议版本与能力位", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_SEMVER).toBe("1.2");
  });
});

describe("reducer", () => {
  test("同一事件序列 → 同一状态（确定性）", () => {
    const a = applyEvents(emptyState(), EVENT_FIXTURES);
    const b = applyEvents(emptyState(), EVENT_FIXTURES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("视图块覆盖主要类型", () => {
    // session.cleared 会清空视图，单独测；这里取它之前的事件序列
    const state = applyEvents(
      emptyState(),
      EVENT_FIXTURES.filter((e) => e.type !== "session.cleared"),
    );
    const kinds = new Set(state.blocks.map((b) => b.kind));
    for (const k of ["turn", "user", "assistant", "tool", "approval", "question", "tierline", "stats", "banner", "error"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });

  test("session.cleared 清空视图但保留 meta", () => {
    const before = applyEvents(emptyState(), EVENT_FIXTURES);
    const after = applyEventOne(before, { type: "session.cleared", at: 1_793_100_200_000 });
    expect(after.blocks).toHaveLength(0);
    expect(after.meta.id).toBe(before.meta.id);
  });

  test("hydrate 从 snapshot.live 恢复 streaming 指针", () => {
    const snap = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) as typeof SNAPSHOT_FIXTURE;
    snap.live = {
      turnId: "t-live",
      assistant: { blockId: "b-live-a", text: "半句" },
      reasoning: { blockId: "b-live-r", text: "想" },
    };
    snap.meta.status = "working";
    const state = hydrate(snap);
    expect(state.streaming.assistantBlockId).toBe("b-live-a");
    expect(state.streaming.reasoningBlockId).toBe("b-live-r");
    expect(state.streaming.turnActive).toBe(true);
  });
});

function applyEventOne(state: SessionState, event: Parameters<typeof applyEvents>[1][number]): SessionState {
  return applyEvents(state, [event]);
}
