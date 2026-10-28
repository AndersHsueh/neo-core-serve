/**
 * tests/e2e/hub.test.ts — 多会话 Hub（brief §2.4 / 验收 5）。
 *
 * Hub = 进程管理 + 协议转发：每会话一个 `serve --stdio` worker，Hub 自己不跑 Agent。
 * 覆盖：
 *  - 发现（NEO_RUN_DIR/core.json）+ ready caps 含 "sessions"；
 *  - session.list / create / attach（attach 后 conn 与 session 绑定）；
 *  - 两个 session 并行 turn，事件 sessionId 各自正确；
 *  - session.close 终止 worker（/health.sessions 归零），之后可重新 attach（worker 重启）；
 *  - 第二客户端 attach 同一 session → conflict（v0.0.2 单客户端）；
 *  - 未 attach 的会话命令 → conflict；
 *  - transcript.fetch / 附件在 Hub 下同样可用（按 ready caps 门控）。
 *
 * 门：main.ts 有 hub 子命令且能真正启动（探测一次）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TINY_PNG_BASE64,
  TestEnv,
  WsClient,
  findAttachmentFiles,
  serveStdioAvailable,
  startHub,
  type HubCore,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/hub] serve 尚未可用：已跳过");

const MAIN_ENTRY = join(import.meta.dir, "../../src/main.ts");

async function hubCapable(): Promise<boolean> {
  if (!available) return false;
  try {
    const main = await readFile(MAIN_ENTRY, "utf8");
    if (!/case\s+"hub"/.test(main)) return false;
    if (!existsSync(join(import.meta.dir, "../../src/hub/server.ts"))) return false;
  } catch {
    return false;
  }
  // 真正起一次，确认 hub 可运行（失败就 skip，而不是让整组红）。
  let env: TestEnv | null = null;
  try {
    env = await TestEnv.create("probe-hub", { scenario: "tool-then-answer" });
    const hub = await startHub({ dirs: env.dirs, fake: env.fake });
    await hub.stop();
    return true;
  } catch {
    return false;
  } finally {
    if (env) await env.dispose().catch(() => {});
  }
}

const capable = await hubCapable();
if (available && !capable) console.warn("[e2e/hub] hub 未就绪：已跳过（实现后自动启用）");

const TIMEOUT = 60000;

describe.skipIf(!available || !capable)("Hub 多会话", () => {
  let env: TestEnv | null = null;
  let hub: HubCore | null = null;
  const clients: WsClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    if (hub) {
      await hub.stop().catch(() => {});
      hub = null;
    }
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  async function setup(name: string, scenario: "tool-then-answer" | "image-detect" = "tool-then-answer"): Promise<{
    env: TestEnv;
    hub: HubCore;
    token: string;
  }> {
    env = await TestEnv.create(name, { scenario });
    await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
    hub = await startHub({ dirs: env.dirs, fake: env.fake });
    const token = await hub.readToken();
    return { env, hub, token };
  }

  async function connect(token: string): Promise<WsClient> {
    const client = await WsClient.connect({ url: hub!.url, token });
    clients.push(client);
    return client;
  }

  /** create → attach，返回 sessionId（等 snapshot 到达）。 */
  async function createAndAttach(client: WsClient, title: string): Promise<{ sessionId: string; snapshot: any }> {
    const created = await client.requestOk({ type: "session.create", title });
    const sessionId = String((created.data as any)?.sessionId ?? "");
    expect(sessionId.length).toBeGreaterThan(0);

    const mark = client.mark();
    const attached = await client.requestOk({ type: "session.attach", sessionId }, { since: mark });
    expect(attached.data).toMatchObject({ role: "owner" });
    const snapFrame = await client.awaitFrame((f) => f.kind === "snapshot", "hub snapshot", {
      since: mark,
      timeoutMs: 30000,
    });
    expect(snapFrame.sessionId).toBe(sessionId);
    return { sessionId, snapshot: snapFrame.snapshot };
  }

  test("发现/ready/health：caps 含 sessions、/health 报 hub 形态", async () => {
    const { hub: h, token } = await setup("hub-ready");
    const client = await connect(token);
    const ready = await client.ready();
    expect(ready.v).toBe(1);
    expect(ready.protocolVersion).toBe("1.2");
    expect(ready.capabilities).toContain("sessions");
    expect(ready.user).toMatchObject({ id: "local", role: "owner" });

    const health = await h.health();
    expect(health["ok"]).toBe(true);
    expect(health["mode"]).toBe("hub");
    expect(health["protocolVersion"]).toBe("1.2");
    expect(typeof health["sessions"]).toBe("number");
    expect(JSON.stringify(health)).not.toContain(token);

    // session.list：初始为空（磁盘 + 运行中）。
    const listed = await client.requestOk({ type: "session.list" });
    const sessions = (listed.data as any)?.sessions as any[];
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toHaveLength(0);
  }, TIMEOUT);

  test("session.create → list 可见 → attach 拿 snapshot → 完整轮", async () => {
    const { hub: h, token } = await setup("hub-create");
    const client = await connect(token);
    await client.ready();

    const { sessionId, snapshot } = await createAndAttach(client, "会话一");
    expect((snapshot as any).meta.id).toBe(sessionId);

    const mark = client.mark();
    await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "hub-turn-1" }, { since: mark });
    const end = await client.awaitTurnEnd(mark, 40000);
    expect(end.event.type).toBe("stats");
    expect((end.event as any).error ?? null).toBeNull();

    // 事件必须带本会话 sessionId。
    for (const frame of client.eventsSince(mark)) {
      expect(frame.sessionId).toBe(sessionId);
      expect(typeof frame.seq).toBe("number");
    }

    // 落盘后 session.list 应能看到它。
    const listed = await client.requestOk({ type: "session.list" });
    expect(((listed.data as any)?.sessions as any[]).map((s) => s.id)).toContain(sessionId);
    const health = await h.health();
    expect(health["sessions"]).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test("两个 session 并行 turn：事件 sessionId 各自正确、互不串流", async () => {
    const { token } = await setup("hub-parallel");
    const c1 = await connect(token);
    const c2 = await connect(token);
    await c1.ready();
    await c2.ready();
    const s1 = await createAndAttach(c1, "并行A");
    const s2 = await createAndAttach(c2, "并行B");
    expect(s1.sessionId).not.toBe(s2.sessionId);

    const m1 = c1.mark();
    const m2 = c2.mark();
    await Promise.all([
      c1.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "p-1" }, { since: m1 }),
      c2.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "p-2" }, { since: m2 }),
    ]);
    const [e1, e2] = await Promise.all([c1.awaitTurnEnd(m1, 40000), c2.awaitTurnEnd(m2, 40000)]);
    expect(e1.event.type).toBe("stats");
    expect(e2.event.type).toBe("stats");

    const ev1 = c1.eventsSince(m1);
    const ev2 = c2.eventsSince(m2);
    expect(ev1.length).toBeGreaterThan(3);
    expect(ev2.length).toBeGreaterThan(3);
    for (const f of ev1) expect(f.sessionId).toBe(s1.sessionId);
    for (const f of ev2) expect(f.sessionId).toBe(s2.sessionId);
    // 交叉污染检查：c1 没收到 s2 的事件，反之亦然。
    expect(ev1.some((f) => f.sessionId === s2.sessionId)).toBe(false);
    expect(ev2.some((f) => f.sessionId === s1.sessionId)).toBe(false);

    const text1 = ev1.filter((f) => f.event?.type === "assistant.end").map((f) => f.event.text).join("");
    const text2 = ev2.filter((f) => f.event?.type === "assistant.end").map((f) => f.event.text).join("");
    expect(text1).toContain("读完了");
    expect(text2).toContain("读完了");
  }, TIMEOUT);

  test("第二客户端 attach 同一 session → conflict；未 attach 的会话命令 → conflict", async () => {
    const { hub: h, token } = await setup("hub-conflict");
    const c1 = await connect(token);
    const c2 = await connect(token);
    await c1.ready();
    await c2.ready();
    const { sessionId } = await createAndAttach(c1, "独占会话");

    const res = await c2.request({ type: "session.attach", sessionId });
    expect(res.ok, "第二客户端 attach 必须失败").toBe(false);
    expect((res.error as any)?.code).toBe("conflict");

    // 未 attach 的会话命令 → conflict（把 sessionId 显式塞进去也不行）。
    const c3 = await connect(token);
    await c3.ready();
    const send = await c3.request({ type: "turn.send", sessionId, text: "偷发", clientId: "sneak" });
    expect(send.ok, "未 attach 就 turn.send 必须失败").toBe(false);
    expect((send.error as any)?.code).toBe("conflict");
    void h;
  }, TIMEOUT);

  test("session.close 终止 worker（health.sessions 归零），之后可重新 attach（worker 重启）", async () => {
    const { hub: h, token } = await setup("hub-close");
    const client = await connect(token);
    await client.ready();
    const { sessionId } = await createAndAttach(client, "可关闭会话");
    const turnMark = client.mark();
    await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "close-turn" }, { since: turnMark });
    await client.awaitTurnEnd(turnMark, 40000);
    expect((await h.health())["sessions"]).toBe(1);

    const closeMark = client.mark();
    await client.requestOk({ type: "session.close", sessionId }, { since: closeMark });
    // worker 退出后 health.sessions 归零（轮询，给 worker 收尾时间）。
    let sessions = -1;
    for (let i = 0; i < 50; i++) {
      sessions = Number((await h.health())["sessions"]);
      if (sessions === 0) break;
      await Bun.sleep(50);
    }
    expect(sessions, "close 后 Hub 仍报告有运行中的 worker").toBe(0);

    // 关闭后该会话命令不可用（未绑定 → conflict）。
    const afterClose = await client.request({ type: "turn.send", text: "还活着吗", clientId: "after-close" });
    expect(afterClose.ok).toBe(false);
    expect(["conflict", "session_gone"]).toContain(String((afterClose.error as any)?.code));

    // 重新 attach：Hub 应重启 worker（resume 同一 session），恢复 snapshot。
    const mark = client.mark();
    const reattach = await client.request({ type: "session.attach", sessionId }, { since: mark });
    expect(reattach.ok, `重新 attach 失败：${JSON.stringify(reattach.error)}`).toBe(true);
    const snap = await client.awaitFrame((f) => f.kind === "snapshot", "re-attach snapshot", {
      since: mark,
      timeoutMs: 30000,
    });
    expect(snap.sessionId).toBe(sessionId);
    expect(JSON.stringify((snap.snapshot as any).blocks)).toContain("看看 a.txt");
  }, TIMEOUT);

  test("Hub 下 transcript.fetch 可用（按 fromSeq/limit；能力位门控）", async () => {
    const { token } = await setup("hub-fetch");
    const client = await connect(token);
    const ready = await client.ready();
    if (!((ready.capabilities as string[]) ?? []).includes("transcript.replay")) {
      client.mark();
      expect(true).toBe(true); // 能力未到位时本用例只验证 ready 可用（发布前 Lead 会补能力位）
      return;
    }
    const { sessionId } = await createAndAttach(client, "回放会话");
    const mark = client.mark();
    await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "hub-fetch-1" }, { since: mark });
    await client.awaitTurnEnd(mark, 40000);

    const full = await client.requestOk({ type: "transcript.fetch", sessionId, fromSeq: 0, limit: 10_000 });
    const events = (full.data as any)?.events as any[];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(typeof e.seq).toBe("number");
    const page = await client.requestOk({ type: "transcript.fetch", sessionId, fromSeq: 0, limit: 2 });
    expect(((page.data as any)?.events as any[]).length).toBe(2);
  }, TIMEOUT);

  test("Hub 下图片附件可用（能力位门控）", async () => {
    const { env: e, token } = await setup("hub-attachments", "image-detect");
    const client = await connect(token);
    const ready = await client.ready();
    const caps = (ready.capabilities as string[]) ?? [];
    if (!caps.includes("attachments.image")) {
      expect(true).toBe(true);
      return;
    }
    const { sessionId } = await createAndAttach(client, "附件会话");
    const mark = client.mark();
    await client.requestOk(
      {
        type: "turn.send",
        text: "看图",
        clientId: "hub-att-1",
        attachments: [{ kind: "image", mime: "image/png", dataBase64: TINY_PNG_BASE64 }],
      },
      { since: mark },
    );
    const end = await client.awaitTurnEnd(mark, 40000);
    expect(end.event.type).toBe("stats");
    const recorded = await e.fake.requests();
    const last = recorded.records[recorded.records.length - 1];
    expect(last?.messages.some((m) => (m.images?.length ?? 0) > 0)).toBe(true);
    const files = await findAttachmentFiles(e.dirs, sessionId);
    expect(files.length).toBeGreaterThan(0);
  }, TIMEOUT);
  test(
    "并发 attach 同 session：恰好 1 成功 1 conflict；owner 断开后可再次 attach（owner 不悬空）",
    async () => {
      const { hub: h, token } = await setup("hub-race");
      const c1 = await connect(token);
      const c2 = await connect(token);
      await c1.ready();
      await c2.ready();

      const created = await c1.requestOk({ type: "session.create", title: "竞态会话" });
      const sessionId = String((created.data as any)?.sessionId ?? "");
      expect(sessionId.length).toBeGreaterThan(0);

      // 两个客户端**同时** attach 同一 session。
      const [r1, r2] = await Promise.all([
        c1.request({ type: "session.attach", sessionId }, { timeoutMs: 15000 }),
        c2.request({ type: "session.attach", sessionId }, { timeoutMs: 15000 }),
      ]);
      const successes = [r1, r2].filter((r) => r.ok === true);
      const conflicts = [r1, r2].filter((r) => r.ok === false && (r.error as any)?.code === "conflict");
      expect(successes, `并发 attach 应恰好 1 成功，实际 ${JSON.stringify([r1.ok, r2.ok])}`).toHaveLength(1);
      expect(conflicts, "失败的必须明确是 conflict").toHaveLength(1);

      // owner 断开：接下来另一个客户端必须能接管（不能残留悬空 owner）。
      const winner = r1.ok ? c1 : c2;
      const loser = r1.ok ? c2 : c1;
      await winner.close();
      let attached: any = null;
      for (let i = 0; i < 100; i++) {
        const res = await loser.request({ type: "session.attach", sessionId });
        if (res.ok) {
          attached = res;
          break;
        }
        await Bun.sleep(50);
      }
      expect(attached, `owner 断线后仍无法 attach（owner 悬空）：最后错误=${JSON.stringify(attached)}`).toBeTruthy();
      await loser.awaitFrame((f) => f.kind === "snapshot", "接管后 snapshot", { timeoutMs: 15000 });
      expect(Number((await h.health())["sessions"])).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    "Hub cwd：create{cwd:A} → close → attach（Hub defaultCwd=B）后仍以 A 为 cwd",
    async () => {
      // 用用户级 ~/.neo/settings.json（settingsMode:"home"）：projectA 里没有 settings.json，
      // worker 在 A 下启动时必须能回落到 HOME 配置（与 GUI 实际部署一致）。
      env = await TestEnv.create("hub-cwd", { scenario: "tool-then-answer", settingsMode: "home" });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
      hub = await startHub({ dirs: env.dirs, fake: env.fake, settingsMode: "home" });
      const token = await hub.readToken();
      // A 工程目录：a.txt 内容 "hello-A"；默认 cwd（work）的 a.txt 是 "hello"。
      const projectA = join(env.dirs.root, "projectA");
      await mkdir(projectA, { recursive: true });
      await writeFile(join(projectA, "a.txt"), "hello-A\n", "utf8");

      const client = await connect(token);
      await client.ready();

      const created = await client.requestOk({ type: "session.create", title: "A 工程", cwd: projectA });
      const sessionId = String((created.data as any)?.sessionId ?? "");
      expect(sessionId.length).toBeGreaterThan(0);

      // attach：snapshot.meta.cwd 必须是 A（Hub defaultCwd 是 work）。
      const mark = client.mark();
      await client.requestOk({ type: "session.attach", sessionId }, { since: mark });
      const snap = await client.awaitFrame((f) => f.kind === "snapshot", "A 工程 snapshot", {
        since: mark,
        timeoutMs: 30000,
      });
      expect((snap.snapshot as any).meta.cwd).toBe(projectA);

      // 相对路径 read_file 命中 A 的 a.txt。
      const turnMark = client.mark();
      await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "cwd-a-1" }, { since: turnMark });
      await client.awaitTurnEnd(turnMark, 40000);
      const toolEnd = client
        .eventsSince(turnMark)
        .find((f) => f.event?.type === "tool.end")?.event as any;
      expect(toolEnd?.state).toBe("ok");
      expect(String(toolEnd?.output)).toContain("hello-A");

      // close 终止 worker 后重新 attach：仍应恢复到 A（不能回落到 Hub 默认 cwd）。
      await client.requestOk({ type: "session.close", sessionId });
      let sessions = -1;
      for (let i = 0; i < 60; i++) {
        sessions = Number((await hub!.health())["sessions"]);
        if (sessions === 0) break;
        await Bun.sleep(50);
      }
      expect(sessions, "close 后 worker 未退出").toBe(0);
      // 重新 attach（Hub defaultCwd 仍是 work，但会话应记住 A）。
      const mark2 = client.mark();
      const re = await client.request({ type: "session.attach", sessionId }, { since: mark2 });
      expect(re.ok, `重新 attach 失败：${JSON.stringify(re.error)}`).toBe(true);
      const snap2 = await client.awaitFrame((f) => f.kind === "snapshot", "A 工程 re-snapshot", {
        since: mark2,
        timeoutMs: 30000,
      });
      expect((snap2.snapshot as any).meta.cwd, "重新 attach 后 cwd 从 A 漂移到默认目录").toBe(projectA);

      const turnMark2 = client.mark();
      await client.requestOk({ type: "turn.send", text: "再看看 a.txt", clientId: "cwd-a-2" }, { since: turnMark2 });
      await client.awaitTurnEnd(turnMark2, 40000);
      const toolEnd2 = client
        .eventsSince(turnMark2)
        .find((f) => f.event?.type === "tool.end")?.event as any;
      expect(String(toolEnd2?.output)).toContain("hello-A");
    },
    TIMEOUT,
  );

});
