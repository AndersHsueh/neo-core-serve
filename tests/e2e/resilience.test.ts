/**
 * tests/e2e/resilience.test.ts — 中断/关闭/恢复的可靠性契约（质量评审补测）。
 *
 * 覆盖：
 *  1. SIGTERM mid-turn（stdio）：进程 0 退出、transcript 末尾补
 *     `turn.aborted{reason:"shutdown"}`（不是 user/crash）、锁释放后 --resume 成功。
 *  2. SIGTERM mid-turn（WS）：客户端在关闭前收到 `turn.aborted{reason:"shutdown"}`、
 *     退出码 0、core.json 清理、锁释放后可用同一 sessionId 重启。
 *  3. resume 幂等/不丢事件：完整一轮 → --resume+attach → transcript 原有事件一个不少、
 *     尾行仍可解析、同一 turn 终态唯一。
 *  4. 轮中 command.run clear → conflict（M2）：不得清空上下文，轮继续正常收口。
 *
 * 1/2/4 曾用探测式 skip 等 coder M1/M2；修复落地后门已拆除——现在是硬断言，
 * 实现回退会直接变红，而不是被 skip 掩盖。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TestEnv,
  WsClient,
  findTranscript,
  readTranscriptLines,
  serveStdioAvailable,
  startWsCore,
  transcriptEventOf,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/resilience] serve 尚未可用：全部跳过");

const TIMEOUT = 40000;

type JsonEvent = Record<string, any>;

function eventsOf(lines: { parsed: Record<string, any> | null }[]): JsonEvent[] {
  return lines.map((l) => transcriptEventOf(l.parsed)).filter((e): e is JsonEvent => e !== null);
}

function identity(e: JsonEvent): string {
  return [e["type"], e["turnId"] ?? "", e["blockId"] ?? "", e["seq"] ?? ""].join("|");
}

function countBy(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

describe.skipIf(!available)("中断/恢复可靠性", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test("SIGTERM mid-turn（stdio）：退出 0 + turn.aborted{shutdown} + 锁释放可 resume", async () => {
    env = await TestEnv.create("sigterm-stdio", { scenario: "slow" });
    const core = await env.startCore();
    const ready = await core.ready();
    const sessionId = ready.sessionId as string;
    const epoch = ready.epoch as string;

    const mark = core.mark();
    await core.requestOk({ type: "turn.send", text: "慢慢说", clientId: "sigterm-1" }, { since: mark });
    await core.awaitEvent("assistant.start", undefined, { since: mark });
    const turnId = core.eventsSince(mark).find((f) => f.event?.type === "turn.start")?.event.turnId;

    core.kill("SIGTERM");
    const code = await core.waitExit(15000);
    expect(code, `SIGTERM 后应 0 退出（优雅关闭），实际 ${code}；stderr=${core.stderrText}`).toBe(0);

    // transcript 尾行必须可解析，且该 turn 的终态是 aborted{shutdown}（不是 user/crash、不是 stats）。
    const path = await findTranscript(env.dirs, sessionId);
    expect(path, "找不到 transcript").not.toBeNull();
    const lines = await readTranscriptLines(path as string);
    expect(lines.at(-1)?.parsed, "transcript 尾行不可解析（含半行）").not.toBeNull();
    const events = eventsOf(lines);
    const terminals = events.filter(
      (e) => (e["type"] === "turn.aborted" || e["type"] === "stats") && e["turnId"] === turnId,
    );
    expect(terminals, `turn ${String(turnId)} 应恰有一个终态`).toHaveLength(1);
    expect(terminals[0]?.["type"]).toBe("turn.aborted");
    expect(terminals[0]?.["reason"]).toBe("shutdown");
    // 终态之后不得再有半轮残留（无未收口的 turn.start）。
    expect(events.some((e) => e["type"] === "session.cleared")).toBe(false);

    // 锁释放：同一 sessionId 可 --resume，且 epoch 保持（同一 transcript）。
    const resumed = await env.startCore({ args: ["--resume", sessionId] });
    const again = await resumed.ready();
    expect(again.sessionId).toBe(sessionId);
    expect(again.epoch).toBe(epoch);
    const mark2 = resumed.mark();
    await resumed.requestOk({ type: "session.attach" }, { since: mark2 });
    await resumed.awaitFrame((f) => f.kind === "snapshot", "resume snapshot", { since: mark2 });
  }, TIMEOUT);

  test(
    "SIGTERM mid-turn（WS）：客户端收到 turn.aborted{shutdown}、退出 0、core.json 清理、锁释放",
    async () => {
      env = await TestEnv.create("sigterm-ws", { scenario: "slow" });
      const core = await startWsCore({ dirs: env.dirs, fake: env.fake });
      const token = await core.readToken();
      const client = await WsClient.connect({ url: core.runInfo.url, token });
      const ready = await client.ready();
      const sessionId = ready.sessionId as string;
      const epoch = ready.epoch as string;

      const mark = client.mark();
      await client.requestOk({ type: "turn.send", text: "慢慢说", clientId: "ws-sigterm" }, { since: mark });
      await client.awaitEvent("assistant.start", undefined, { since: mark });

      const stopping = core.stop();
      const aborted = await client.awaitEvent("turn.aborted", (e) => e.reason === "shutdown", {
        since: mark,
        timeoutMs: 10000,
      });
      expect(aborted.event.reason).toBe("shutdown");
      const code = await stopping;
      expect(code, "SIGTERM 后应 0 退出").toBe(0);
      expect(existsSync(core.coreJsonPath), "SIGTERM 后 core.json 应被清理").toBe(false);
      await client.close();

      // 锁释放 + 可带同 sessionId 重启（epoch 不变）。
      const again = await startWsCore({ dirs: env.dirs, fake: env.fake, args: ["--resume", sessionId] });
      expect(again.runInfo.sessionId).toBe(sessionId);
      expect(again.runInfo.epoch).toBe(epoch);
      const code2 = await again.stop();
      expect(code2).toBe(0);
    },
    TIMEOUT,
  );

  test("resume 幂等：attach 不丢 transcript 事件、尾行不破坏、终态唯一", async () => {
    env = await TestEnv.create("resume-idempotent", { scenario: "tool-then-answer" });
    await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
    let core = await env.startCore();
    const ready = await core.ready();
    const sessionId = ready.sessionId as string;

    const mark = core.mark();
    await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "idem-1" }, { since: mark });
    const end = await core.awaitTurnEnd(mark);
    expect(end.event.type).toBe("stats");
    await core.close();

    const path = await findTranscript(env.dirs, sessionId);
    expect(path, "找不到 transcript").not.toBeNull();
    const beforeLines = await readTranscriptLines(path as string);
    const before = eventsOf(beforeLines);
    expect(before.length).toBeGreaterThan(0);
    const beforeIds = countBy(before.map(identity));
    const beforeMaxSeq = before.reduce((m, e) => Math.max(m, Number(e["seq"] ?? 0)), 0);
    const beforeTurns = new Set(before.map((e) => e["turnId"]).filter(Boolean));

    // resume + attach（attach 会重建视图，但不能改写/丢弃已有 durable 事件）。
    core = await env.startCore({ args: ["--resume", sessionId] });
    const ready2 = await core.ready();
    expect(ready2.sessionId).toBe(sessionId);
    expect(ready2.epoch).toBe(ready.epoch);
    const mark2 = core.mark();
    await core.requestOk({ type: "session.attach" }, { since: mark2 });
    const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "resume snapshot", { since: mark2 }))
      .snapshot as any;
    // 快照仍能重建上一轮消息（恢复不是空壳）。
    expect(JSON.stringify(snap.blocks)).toContain("看看 a.txt");
    await core.close();

    const afterLines = await readTranscriptLines(path as string);
    expect(afterLines.at(-1)?.parsed, "resume 后 transcript 尾行不可解析").not.toBeNull();
    const after = eventsOf(afterLines);
    const afterIds = countBy(after.map(identity));
    // 原有事件一个不少（允许 resume 期间追加 boot/repair 事件）。
    const missing: string[] = [];
    for (const [id, n] of beforeIds) {
      if ((afterIds.get(id) ?? 0) < n) missing.push(`${id} (期望 ${n}, 实际 ${afterIds.get(id) ?? 0})`);
    }
    expect(missing, `resume 丢失了 transcript 事件：${missing.join(", ")}`).toEqual([]);
    // 终态唯一：同一 turn 不得同时出现 stats 与 turn.aborted（也不得重复）。
    const terminalCounts = countBy(
      after
        .filter((e) => (e["type"] === "stats" || e["type"] === "turn.aborted") && e["turnId"])
        .map((e) => String(e["turnId"])),
    );
    for (const [turnId, count] of terminalCounts) {
      expect(count, `turn ${turnId} 出现 ${count} 个终态`).toBeLessThanOrEqual(1);
    }
    // 已完成的轮次不得被 resume 改写为另一种终态。
    for (const turnId of beforeTurns) {
      const beforeTerminal = before.find(
        (e) => e["turnId"] === turnId && (e["type"] === "stats" || e["type"] === "turn.aborted"),
      );
      if (!beforeTerminal) continue;
      const afterTerminal = after.find(
        (e) => e["turnId"] === turnId && (e["type"] === "stats" || e["type"] === "turn.aborted"),
      );
      expect(afterTerminal?.["type"]).toBe(beforeTerminal["type"]);
    }
    // seq 不倒退。
    const afterMaxSeq = after.reduce((m, e) => Math.max(m, Number(e["seq"] ?? 0)), 0);
    expect(afterMaxSeq).toBeGreaterThanOrEqual(beforeMaxSeq);
  }, TIMEOUT);

  test("轮中 command.run clear → conflict：不清空上下文，轮继续正常收口", async () => {
      env = await TestEnv.create("clear-mid-turn", { scenario: "slow" });
      const core = await env.startCore();
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "慢慢说", clientId: "clear-mid" }, { since: mark });
      await core.awaitEvent("assistant.start", undefined, { since: mark });

      const mark2 = core.mark();
      const res = await core.request({ type: "command.run", name: "clear", args: [] }, { since: mark2 });
      const failed = res.ok === false || (res.data as any)?.ok === false;
      expect(failed, `轮中 /clear 应失败，实际：${JSON.stringify(res)}`).toBe(true);
      const errorText = JSON.stringify(res);
      expect(errorText).toMatch(/conflict|运行中|working|忙碌|本轮/);
      expect(
        core.eventsSince(mark2).some((f) => f.event?.type === "session.cleared"),
        "轮中 /clear 不得发 session.cleared",
      ).toBe(false);

      // 轮继续：正常 stats 收口（不受命令失败影响）。
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");

      // 轮结束后 /clear 恢复可用。
      const mark3 = core.mark();
      const after = await core.request({ type: "command.run", name: "clear", args: [] }, { since: mark3 });
      expect(after.ok === true || (after.data as any)?.ok === true).toBe(true);
    await core.awaitEvent("session.cleared", undefined, { since: mark3 });
  }, TIMEOUT);
});
