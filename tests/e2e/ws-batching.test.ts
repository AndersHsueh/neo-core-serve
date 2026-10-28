/**
 * tests/e2e/ws-batching.test.ts — WS 合批的可观测行为（brief §2.3 / 验收 4）。
 *
 * 只测「可观测契约」，不依赖内部实现：
 *  - 高频 delta 在 WS 上被合批：收到的 assistant.delta 帧数显著少于模型 delta 数；
 *  - 合批不能丢文本：delta 拼接 == assistant.end.text（权威全文）；
 *  - durable 事件不被合并/丢失（turn.start/stats 各一份，顺序正确）；
 *  - 对照：stdio 不合并（逐 delta 转发），证明合批是 WS 传输层行为而非模型侧假象。
 *
 * 帧数上限/4408 的队列策略在 `tests/unit/batcher.test.ts` 直接单测（慢客户端
 * 在 Bun 客户端侧无法稳定模拟；队列策略是可注入的单测点）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TestEnv,
  WsClient,
  serveStdioAvailable,
  startWsCore,
  type WsCore,
} from "../helpers.ts";

const BATCHER = join(import.meta.dir, "../../src/serve/batcher.ts");
const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/ws-batching] serve 尚未可用：已跳过");
const batchingAvailable = existsSync(BATCHER);
if (available && !batchingAvailable) {
  console.warn("[e2e/ws-batching] src/serve/batcher.ts 尚未落地：已跳过");
}

const TIMEOUT = 40000;

function expectedBurstText(frames: number): string {
  let text = "";
  for (let i = 0; i < frames; i++) text += `${i}.`;
  return `${text}END`;
}

describe.skipIf(!available || !batchingAvailable)("WS 合批", () => {
  let env: TestEnv | null = null;
  let wsCore: WsCore | null = null;
  let client: WsClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (wsCore) {
      await wsCore.stop().catch(() => {});
      wsCore = null;
    }
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "高频 delta：WS 帧数 < delta 数且文本完整；durable 事件不丢",
    async () => {
      const frames = 150;
      env = await TestEnv.create("ws-batching", { scenario: "burst", fakeEnv: { BURST_FRAMES: String(frames) } });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
      wsCore = await startWsCore({ dirs: env.dirs, fake: env.fake });
      const token = await wsCore.readToken();
      client = await WsClient.connect({ url: wsCore.runInfo.url, token });
      const ready = await client.ready();
      expect(ready.v).toBe(1);

      const mark = client.mark();
      await client.requestOk({ type: "turn.send", text: "burst", clientId: "ws-batch-1" }, { since: mark });
      const end = await client.awaitTurnEnd(mark, 30000);
      expect(end.event.type).toBe("stats");
      const events = client.eventsSince(mark);
      const expected = expectedBurstText(frames);

      // 1) 合批可观察：delta 帧数远少于模型 delta 数。
      const deltaFrames = events.filter((f) => f.event?.type === "assistant.delta");
      expect(deltaFrames.length, "WS 完全没有收到 delta（合批不能吞掉增量）").toBeGreaterThan(0);
      expect(
        deltaFrames.length,
        `WS 未合批：收到 ${deltaFrames.length} 帧 / 模型 ${frames} 个 delta`,
      ).toBeLessThan(frames);
      // 2) 合批不丢文本。
      const deltaText = deltaFrames.map((f) => String(f.event.text ?? "")).join("");
      expect(deltaText).toBe(expected);
      // 3) 权威全文一致。
      const authoritative = events
        .filter((f) => f.event?.type === "assistant.end")
        .map((f) => String(f.event.text ?? ""))
        .join("");
      expect(authoritative).toBe(expected);
      // 4) durable 事件不被合并：turn.start / stats 各一份且顺序正确。
      const types = events.map((f) => f.event?.type as string);
      expect(types.filter((t) => t === "turn.start")).toHaveLength(1);
      expect(types.filter((t) => t === "stats")).toHaveLength(1);
      expect(types.indexOf("turn.start")).toBeLessThan(types.indexOf("stats"));
      // 事件 envelope seq 仍是 durable seq（合批只影响 ephemeral 的发送节奏）。
      for (const f of events) expect(typeof f.seq).toBe("number");
      expect(client.nonJsonMessages).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "对照：stdio 不合批（逐 delta 转发），证明合批是 WS 传输层行为",
    async () => {
      const frames = 150;
      env = await TestEnv.create("stdio-nobatch", { scenario: "burst", fakeEnv: { BURST_FRAMES: String(frames) } });
      const core = await env.startCore();
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "burst", clientId: "stdio-nb-1" }, { since: mark });
      await core.awaitTurnEnd(mark);
      const events = core.eventsSince(mark);
      const deltaFrames = events.filter((f) => f.event?.type === "assistant.delta");
      // stdio 按事件逐帧写；fake 的正文被切成 frames 个 chunk → 期望帧数接近 frames。
      expect(deltaFrames.length).toBeGreaterThanOrEqual(Math.floor(frames / 4));
      const text = deltaFrames.map((f) => String(f.event.text ?? "")).join("");
      expect(text).toBe(expectedBurstText(frames));
    },
    TIMEOUT,
  );
});
