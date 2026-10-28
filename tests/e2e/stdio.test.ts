/**
 * tests/e2e/stdio.test.ts — 通过 `matrix-core serve --stdio` 跑真实子进程的端到端测试。
 *
 * 覆盖（v0.0.1 验收）：
 *  - ready（user/coreVersion/protocolVersion/capabilities/sessionId/epoch）
 *  - session.list / session.attach snapshot
 *  - turn.send 完整轮（turn/assistant/reasoning/tool/stats + usage）
 *  - 审批 allow / deny / timeout（超时后轮继续，by="timeout"）
 *  - 提问单选回答 / 超时取消
 *  - turn.abort（turn.aborted 与 stats 互斥）
 *  - /clear（session.cleared，视图清空、meta 保留）
 *  - --resume（同 sessionId/epoch，消息恢复）+ transcript 尾行修复
 *
 * 全部走临时 NEO_* 目录 + fake LLM，不写真实 ~/.neo、不依赖外网。
 * 服务未就绪时整组 skip（探测见 tests/helpers.ts serveStdioAvailable）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
if (!available) {
  // 不静默：让跑测试的人知道是「实现未就绪」而不是「没有 e2e」。
  console.warn("[e2e] serve --stdio 尚未可用：stdio e2e 已跳过（实现落地后自动启用）");
}

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

function ok(frame: Frame): Frame {
  expect(frame.ok, `命令失败：${JSON.stringify(frame.error)}`).toBe(true);
  return frame;
}

function eventOf(frames: Frame[], type: string): Frame[] {
  return frames.filter((f) => f.kind === "event" && f.event?.type === type);
}

function eventTypes(frames: Frame[]): string[] {
  return frames.filter((f) => f.kind === "event").map((f) => f.event.type as string);
}

describe.skipIf(!available)("stdio e2e", () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function setup(name: string, options: TestEnvOptions = {}): Promise<TestEnv> {
    env = await TestEnv.create(name, options);
    return env;
  }

  /* ------------------------------ ready ------------------------------ */

  test(
    "ready：首帧含 user/coreVersion/protocolVersion/capabilities/sessionId/epoch；stdout 只有帧",
    async () => {
      const e = await setup("ready");
      const core = await e.startCore();
      const ready = await core.ready();

      expect(ready.v).toBe(1);
      expect(ready.user).toMatchObject({ id: "local", role: "owner" });
      expect(typeof ready.user.email).toBe("string");
      expect(typeof ready.user.displayName).toBe("string");
      expect(typeof ready.coreVersion).toBe("string");
      expect(ready.coreVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(ready.protocolVersion).toBe("1.1");
      expect(Array.isArray(ready.capabilities)).toBe(true);
      for (const cap of ["turn.aborted", "command.structured", "snapshot.live", "mode.set"]) {
        expect(ready.capabilities).toContain(cap);
      }
      expect(typeof ready.sessionId).toBe("string");
      expect((ready.sessionId ?? "").length).toBeGreaterThan(0);
      expect(typeof ready.epoch).toBe("string");
      expect((ready.epoch ?? "").length).toBeGreaterThanOrEqual(8);

      // ready 必须是首帧（前面不能有别的帧）。
      expect(core.frames[0]?.kind).toBe("ready");
      // stdout 只出帧：不允许日志/广告词混进来。
      expect(core.nonJsonStdout).toEqual([]);
    },
    TIMEOUT,
  );

  /* --------------------------- list / attach -------------------------- */

  test(
    "session.list + session.attach：meta 形状与 snapshot 一致",
    async () => {
      const e = await setup("list-attach");
      const core = await e.startCore();
      const ready = await core.ready();
      const sessionId = ready.sessionId as string;

      const mark = core.mark();
      const list = ok(await core.request({ type: "session.list" }, { since: mark }));
      const listed = (list.data as any)?.sessions as any[];
      expect(Array.isArray(listed)).toBe(true);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: sessionId,
        ownerId: "local",
        status: "idle",
        unread: 0,
      });
      expect(typeof listed[0].title).toBe("string");
      expect(["deep_reasoning", "balanced", "fast", "default"]).toContain(listed[0].tier);
      expect(["ask", "auto-edit", "auto-all", "plan"]).toContain(listed[0].mode);
      expect(typeof listed[0].provider).toBe("string");
      expect(typeof listed[0].model).toBe("string");
      // 协议 §3：sessions/usage/settings 三种 kind 只用于服务端主动推送；
      // session.list 的查询结果只放 result.data（v0.0.1 不推 sessions 帧）。
      expect(core.framesSince(mark).some((f) => f.kind === "sessions")).toBe(false);

      const mark2 = core.mark();
      const attach = ok(await core.request({ type: "session.attach", sessionId }, { since: mark2 }));
      expect(attach.data).toMatchObject({ role: "owner" });
      const snapFrame = await core.awaitFrame((f) => f.kind === "snapshot", "snapshot 帧", { since: mark2 });
      const snap = snapFrame.snapshot as any;
      expect(snapFrame.sessionId).toBe(sessionId);
      expect(snap.meta.id).toBe(sessionId);
      expect(snap.epoch).toBe(ready.epoch);
      expect(typeof snap.seq).toBe("number");
      expect(Array.isArray(snap.blocks)).toBe(true);
      expect(snap.context).toMatchObject({ used: expect.any(Number), limit: expect.any(Number) });
      expect(snapFrame.seq).toBe(snap.seq);
    },
    TIMEOUT,
  );

  test("ping → pong（协议 v1.1：只回 pong 帧，不带 result）", async () => {
    const e = await setup("ping");
    const core = await e.startCore();
    const mark = core.mark();
    core.send({ type: "ping" });
    const pong = await core.awaitFrame((f) => f.kind === "pong", "pong", { since: mark });
    expect(pong.v).toBe(1);
  }, TIMEOUT);

  /* ----------------------------- 完整一轮 ---------------------------- */

  test(
    "turn.send 完整轮：reasoning/assistant/tool/stats 齐全，usage 非零",
    async () => {
      const e = await setup("full-turn");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk(
        { type: "turn.send", text: "看看 a.txt", clientId: "turn-1" },
        { since: mark },
      );
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type, `整轮应以 stats 收口，实际：${JSON.stringify(end.event)}`).toBe("stats");

      const frames = core.framesSince(mark);
      const types = eventTypes(frames);
      for (const t of [
        "turn.start",
        "reasoning.start",
        "reasoning.end",
        "assistant.start",
        "assistant.end",
        "tool.start",
        "tool.end",
        "stats",
      ]) {
        expect(types, `缺事件 ${t}；实际序列=${types.join(",")}`).toContain(t);
      }

      const turnStart = eventOf(frames, "turn.start")[0]!.event;
      expect(turnStart.userText).toBe("看看 a.txt");
      expect(turnStart.source).toBe("user");
      expect(turnStart.clientId).toBe("turn-1");
      expect(typeof turnStart.turnId).toBe("string");
      expect(typeof turnStart.msgCount).toBe("number");
      expect(typeof turnStart.n).toBe("number");

      // reasoning 必须成对，且落在同一 blockId 上。
      const rStart = eventOf(frames, "reasoning.start")[0]!.event;
      const rEnd = eventOf(frames, "reasoning.end")[0]!.event;
      expect(rEnd.blockId).toBe(rStart.blockId);

      // assistant.end 的 text 是权威全文；本场景有两段正文（工具前/工具后）。
      const assistantEnds = eventOf(frames, "assistant.end").map((f) => f.event);
      expect(assistantEnds.length).toBeGreaterThanOrEqual(2);
      expect(assistantEnds.map((e: any) => e.text).join("")).toContain("读完了");
      for (const e of assistantEnds) expect(typeof e.blockId).toBe("string");
      // assistant.start 与 assistant.end 的 blockId 一一对应。
      const assistantStarts = eventOf(frames, "assistant.start").map((f) => f.event.blockId as string);
      for (const e of assistantEnds) expect(assistantStarts).toContain(e.blockId);

      // 工具块：read_file 成功（a.txt 存在），预览含内容。
      const toolStart = eventOf(frames, "tool.start")[0]!.event;
      expect(toolStart.name).toBe("read_file");
      expect(typeof toolStart.arg).toBe("string");
      const toolEnd = eventOf(frames, "tool.end")[0]!.event;
      expect(toolEnd.blockId).toBe(toolStart.blockId);
      expect(toolEnd.state).toBe("ok");
      expect(String(toolEnd.output)).toContain("hello");

      const stats = end.event;
      expect(typeof stats.turnId).toBe("string");
      expect(stats.toolCalls).toBeGreaterThanOrEqual(1);
      expect(stats.iterations).toBeGreaterThanOrEqual(2);
      expect(stats.usage.promptTokens).toBeGreaterThan(0);
      expect(stats.usage.completionTokens).toBeGreaterThan(0);
      expect(stats.error ?? null).toBeNull();
      expect(typeof stats.durationMs).toBe("number");
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);

      // 用量回执：一轮结束应有记录，costMicros 在 v0.0.1 固定为 0（未计价）。
      const usageFrame = ok(await core.request({ type: "usage.summary", range: "session" }));
      const usageData = usageFrame.data as any;
      expect(Array.isArray(usageData.records)).toBe(true);
      expect(usageData.records.length).toBeGreaterThanOrEqual(1);
      expect(usageData.totals.costMicros).toBe(0);
      expect(usageData.totals.promptTokens).toBeGreaterThan(0);

      expect(core.nonJsonStdout).toEqual([]);
    },
    TIMEOUT,
  );

  /* ------------------------------ 审批 ------------------------------- */

  test(
    "审批 allow：write_file 允许后工具执行、文件落盘、轮正常收口",
    async () => {
      const e = await setup("approval-allow", { scenario: "write-then-answer" });
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk(
        { type: "turn.send", text: "写个文件", clientId: "approval-allow" },
        { since: mark },
      );
      const req = await core.awaitEvent("approval.request", undefined, { since: mark });
      const blockId = req.event.blockId as string;
      expect(blockId.length).toBeGreaterThan(0);
      expect(req.event.tool).toBe("write_file");
      // path/detail 是 v1.1 可选字段：有就必须指向 a.txt。
      if (req.event.path !== undefined) expect(String(req.event.path)).toContain("a.txt");

      const resolveRes = ok(await core.request({ type: "approval.resolve", blockId, decision: "allow" }));
      expect((resolveRes.data as any)?.resolved).toBe("allow");
      const resolved = await core.awaitEvent("approval.resolve", (ev) => ev.blockId === blockId, { since: mark });
      expect(resolved.event.state).toBe("allowed");
      expect(resolved.event.by).toBe("user");

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const toolEnd = eventOf(core.framesSince(mark), "tool.end")[0]!.event;
      expect(toolEnd.state).toBe("ok");

      const written = await readFile(join(e.dirs.work, "a.txt"), "utf8").catch(() => null);
      expect(written).toContain("written by matrix-core");
    },
    TIMEOUT,
  );

  test(
    "审批 deny：拒绝后 tool.end=denied、轮继续（stats 收口）",
    async () => {
      const e = await setup("approval-deny", { scenario: "write-then-answer" });
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk(
        { type: "turn.send", text: "写个文件", clientId: "approval-deny" },
        { since: mark },
      );
      const req = await core.awaitEvent("approval.request", undefined, { since: mark });
      ok(await core.request({ type: "approval.resolve", blockId: req.event.blockId, decision: "deny" }));

      const resolved = await core.awaitEvent("approval.resolve", undefined, { since: mark });
      expect(resolved.event.state).toBe("denied");
      expect(resolved.event.by).toBe("user");

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const toolEnd = eventOf(core.framesSince(mark), "tool.end")[0]!.event;
      expect(toolEnd.state).toBe("denied");

      // 拒绝后不得落盘。
      const written = await readFile(join(e.dirs.work, "a.txt"), "utf8").catch(() => null);
      expect(written).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "审批 timeout：MATRIX_CORE_APPROVAL_TIMEOUT_MS 生效，by=timeout、轮继续、会话不卡死",
    async () => {
      const e = await setup("approval-timeout", {
        scenario: "write-then-answer",
        env: { MATRIX_CORE_APPROVAL_TIMEOUT_MS: "300" },
      });
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk(
        { type: "turn.send", text: "写个文件", clientId: "approval-timeout" },
        { since: mark },
      );
      const req = await core.awaitEvent("approval.request", undefined, { since: mark, timeoutMs: 15000 });
      // deadlineAt 可选，但有就必须是未来时间戳。
      if (req.event.deadlineAt !== undefined) {
        expect(typeof req.event.deadlineAt).toBe("number");
      }

      // 不回答：等 host 自己按超时收敛。
      const resolved = await core.awaitEvent("approval.resolve", (ev) => ev.blockId === req.event.blockId, {
        since: mark,
        timeoutMs: 15000,
      });
      expect(resolved.event.state).toBe("denied");
      expect(resolved.event.by).toBe("timeout");

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const toolEnd = eventOf(core.framesSince(mark), "tool.end")[0]!.event;
      expect(toolEnd.state).toBe("denied");

      // 会话必须回到 idle，并且还能接下一轮（不卡死）。
      await core.awaitEvent("session.status", (ev) => ev.status === "idle", { since: mark, timeoutMs: 10000 });
      const mark2 = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: mark2 }));
      await core.awaitFrame((f) => f.kind === "snapshot", "超时后 snapshot", { since: mark2 });
    },
    TIMEOUT,
  );

  /* ------------------------------ 提问 ------------------------------- */

  test(
    "question 单选：question.request → 回答 key → question.resolve → 轮继续",
    async () => {
      const e = await setup("question", { scenario: "ask-user" });
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "问我个问题", clientId: "question" }, { since: mark });
      const req = await core.awaitEvent("question.request", undefined, { since: mark, timeoutMs: 15000 });
      const question = req.event;
      expect(typeof question.prompt).toBe("string");
      expect(Array.isArray(question.options)).toBe(true);
      expect(question.options.length).toBeGreaterThanOrEqual(2);
      for (const opt of question.options) {
        expect(typeof opt.key).toBe("string");
        expect(typeof opt.label).toBe("string");
      }
      const picked = question.options[0];

      ok(await core.request({ type: "question.answer", blockId: question.blockId, key: picked.key }));
      const resolved = await core.awaitEvent("question.resolve", (ev) => ev.blockId === question.blockId, {
        since: mark,
      });
      expect(resolved.event.key).toBe(picked.key);
      expect(resolved.event.by).toBe("user");
      if (resolved.event.answerLabel !== undefined) {
        expect(resolved.event.answerLabel).toBe(picked.label);
      }

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const assistantText = eventOf(core.framesSince(mark), "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("ANSWER_OK");
    },
    TIMEOUT,
  );

  test(
    "question timeout：无人回答时 question.resolve by=timeout、轮继续",
    async () => {
      const e = await setup("question-timeout", {
        scenario: "ask-user",
        env: { MATRIX_CORE_QUESTION_TIMEOUT_MS: "500" },
      });
      const core = await e.startCore();

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "问我个问题", clientId: "question-timeout" }, { since: mark });
      const req = await core.awaitEvent("question.request", undefined, { since: mark, timeoutMs: 15000 });
      const resolved = await core.awaitEvent("question.resolve", (ev) => ev.blockId === req.event.blockId, {
        since: mark,
        timeoutMs: 15000,
      });
      expect(resolved.event.by).toBe("timeout");

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
    },
    TIMEOUT,
  );

  /* ------------------------------ abort ------------------------------ */

  test(
    "turn.abort：turn.aborted 终止轮，且不再发 stats / 会话回到 idle",
    async () => {
      const e = await setup("abort", { scenario: "slow" });
      const core = await e.startCore();

      const mark = core.mark();
      const { turnId } = await core.startTurn("慢慢说");
      // 等到模型确实开始流式输出，再中断。
      await core.awaitEvent("assistant.start", undefined, { since: mark });

      const abortRes = ok(await core.request({ type: "turn.abort", turnId }));
      expect((abortRes.data as any)?.aborted).toBe(true);

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type, "中断轮必须以 turn.aborted 收口").toBe("turn.aborted");
      expect(end.event.turnId).toBe(turnId);
      expect(end.event.reason).toBe("user");

      // 终态互斥：中断后不得再补 stats。
      await core.expectNoEvent("stats", { since: mark, windowMs: 800 });
      await core.awaitEvent("session.status", (ev) => ev.status === "idle", { since: mark, timeoutMs: 10000 });

      // snapshot 不应残留 live 相位。
      const mark2 = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: mark2 }));
      const snapFrame = await core.awaitFrame((f) => f.kind === "snapshot", "abort 后 snapshot", { since: mark2 });
      expect((snapFrame.snapshot as any).live).toBeUndefined();
    },
    TIMEOUT,
  );

  /* ------------------------------ clear ------------------------------ */

  test(
    "command.run clear → session.cleared，快照视图清空但 meta 保留",
    async () => {
      const e = await setup("clear");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      const core = await e.startCore();
      const ready = await core.ready();
      const sessionId = ready.sessionId as string;

      // 先跑完整一轮，确认视图里确实有内容。
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "clear-1" }, { since: mark });
      await core.awaitTurnEnd(mark);
      const markSnap = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: markSnap }));
      const beforeSnap = (await core.awaitFrame((f) => f.kind === "snapshot", "clear 前 snapshot", {
        since: markSnap,
      })).snapshot as any;
      expect(beforeSnap.blocks.length).toBeGreaterThan(0);

      const mark2 = core.mark();
      const res = ok(await core.request({ type: "command.run", name: "clear", args: [] }, { since: mark2 }));
      expect((res.data as any)?.ok).toBe(true);
      const cleared = await core.awaitEvent("session.cleared", undefined, { since: mark2 });

      // 清空后 snapshot：blocks 空，meta 保留（id/title/tier）。
      const mark3 = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: mark3 }));
      const afterSnap = (await core.awaitFrame((f) => f.kind === "snapshot", "clear 后 snapshot", {
        since: mark3,
      })).snapshot as any;
      expect(afterSnap.blocks).toEqual([]);
      expect(afterSnap.meta.id).toBe(sessionId);
      expect(afterSnap.meta.title).toBe(beforeSnap.meta.title);
      expect(afterSnap.seq).toBeGreaterThanOrEqual(beforeSnap.seq);
      expect(cleared.event.at).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  /* ------------------------------ resume ----------------------------- */

  test(
    "--resume：同 sessionId/epoch，snapshot 恢复上一轮消息，下一轮上下文可继续",
    async () => {
      const e = await setup("resume");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      let core = await e.startCore();
      const ready = await core.ready();
      const sessionId = ready.sessionId as string;
      const epoch = ready.epoch as string;

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "resume-1" }, { since: mark });
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const statsSeq = end.seq ?? 0;
      const assistantText = eventOf(core.framesSince(mark), "assistant.end")
        .map((f) => f.event.text as string)
        .join("");
      expect(assistantText).toContain("读完了");

      await core.close();
      core = await e.startCore({ args: ["--resume", sessionId] });
      const ready2 = await core.ready();
      expect(ready2.sessionId).toBe(sessionId);
      expect(ready2.epoch).toBe(epoch);

      const mark2 = core.mark();
      ok(await core.request({ type: "session.attach", sessionId }, { since: mark2 }));
      const snap = (await core.awaitFrame((f) => f.kind === "snapshot", "resume 后 snapshot", { since: mark2 }))
        .snapshot as any;
      expect(snap.epoch).toBe(epoch);
      // seq 从最后一个 durable 事件继续，不能回退。
      expect(snap.seq).toBeGreaterThanOrEqual(statsSeq);
      const blocksText = JSON.stringify(snap.blocks);
      expect(blocksText).toContain("看看 a.txt");
      expect(blocksText).toContain("读完了");

      // 恢复后的下一轮：模型能拿到上一轮历史（fake LLM 留痕佐证）。
      const mark3 = core.mark();
      await core.requestOk({ type: "turn.send", text: "继续", clientId: "resume-2" }, { since: mark3 });
      await core.awaitTurnEnd(mark3);
      const recorded = await e.fake.requests();
      const last = recorded.records[recorded.records.length - 1];
      const history = (last?.messages ?? []).map((m) => m.content).join("\n");
      expect(history).toContain("看看 a.txt");
      expect(history).toContain("读完了");
    },
    TIMEOUT,
  );

  test(
    "transcript 尾部修复：坏尾行丢弃 + 半轮 turn.start 补 turn.aborted{crash}，可 attach",
    async () => {
      const e = await setup("transcript-repair");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      let core = await e.startCore();
      const ready = await core.ready();
      const sessionId = ready.sessionId as string;
      const epoch = ready.epoch as string;

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "repair-1" }, { since: mark });
      await core.awaitTurnEnd(mark);
      await core.close();

      const transcriptPath = await findTranscript(e.dirs, sessionId);
      expect(transcriptPath, "找不到 transcript 文件（core 未落盘？）").not.toBeNull();

      const lines = await readTranscriptLines(transcriptPath as string);
      const events = lines.map((l) => transcriptEventOf(l.parsed)).filter((ev) => ev !== null);
      expect(events.length).toBeGreaterThan(0);
      const maxSeq = lines.reduce((max, l) => {
        const seq = (l.parsed?.seq as number | undefined) ?? (l.parsed?.event?.seq as number | undefined) ?? 0;
        return Math.max(max, seq);
      }, 0);
      const turnStart = [...events].reverse().find((ev) => ev!["type"] === "turn.start");
      expect(turnStart, "transcript 里应有 turn.start").toBeDefined();

      // 用真实 turn.start 行克隆一个「有头无尾」的半轮，再追加 torn 尾行。
      const lastTurnStartLine = [...lines].reverse().find((l) => transcriptEventOf(l.parsed)?.["type"] === "turn.start");
      expect(lastTurnStartLine).toBeDefined();
      const baseEvent = transcriptEventOf(lastTurnStartLine!.parsed)!;
      const crashSeq = maxSeq + 1;
      const crashTurnId = `t-crash-${Date.now()}`;
      const crashEvent = {
        ...baseEvent,
        turnId: crashTurnId,
        blockId: `b-crash-${Date.now()}`,
        at: Date.now(),
        n: Number(baseEvent["n"] ?? 0) + 100,
        seq: crashSeq,
      };
      let crashLine: string;
      if (lastTurnStartLine!.parsed?.event !== undefined) {
        crashLine = JSON.stringify({ ...lastTurnStartLine!.parsed, seq: crashSeq, event: crashEvent });
      } else {
        crashLine = JSON.stringify(crashEvent);
      }
      const torn =
        '{"seq":' + (crashSeq + 1) + ',"event":{"type":"assistant.delta","blockId":"b-torn","text":"torn';
      await appendFile(transcriptPath as string, `${crashLine}\n${torn}`, "utf8");

      // 重启：必须能起来（坏尾行丢弃、半轮补 abort），并保留同一 epoch。
      core = await e.startCore({ args: ["--resume", sessionId] });
      const ready2 = await core.ready();
      expect(ready2.sessionId).toBe(sessionId);
      expect(ready2.epoch).toBe(epoch);

      const mark2 = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: mark2 }));
      await core.awaitFrame((f) => f.kind === "snapshot", "修复后 snapshot", { since: mark2 });
      await core.close();

      const repaired = await readTranscriptLines(transcriptPath as string);
      // 坏尾行必须被丢弃：全文件可解析。
      const bad = repaired.filter((l) => l.parsed === null);
      expect(bad.map((l) => l.raw)).toEqual([]);
      // 半轮必须有确定终态：turn.aborted{reason:"crash"}，且指向那个崩溃轮。
      const repairedEvents = repaired.map((l) => transcriptEventOf(l.parsed)).filter((ev) => ev !== null);
      const aborted = repairedEvents.find(
        (ev) => ev!["type"] === "turn.aborted" && ev!["turnId"] === crashTurnId,
      );
      expect(aborted, `修复后 transcript 应含 turn.aborted{crash}；事件=${JSON.stringify(
        repairedEvents.map((ev) => ev!["type"]),
      )}`).toBeDefined();
      expect(aborted!["reason"]).toBe("crash");
      // 终态唯一性：同一 turn 不得同时有 stats 与 turn.aborted。
      const crashTerminals = repairedEvents.filter(
        (ev) => (ev!["type"] === "turn.aborted" || ev!["type"] === "stats") && ev!["turnId"] === crashTurnId,
      );
      expect(crashTerminals).toHaveLength(1);
    },
    TIMEOUT,
  );
});
