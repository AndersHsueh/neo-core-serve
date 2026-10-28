/**
 * tests/e2e/ws.test.ts — WS 传输（协议 §2）：握手/鉴权/ready/ping/attach/完整轮/重连/清理。
 *
 * 与 stdio 的差异（这些正是本文件要守的契约）：
 *  - 发现信息从 `NEO_RUN_DIR/core.json` 读（url/pid/tokenFile/sessionId/epoch）；
 *  - 鉴权靠 `Sec-WebSocket-Protocol: ["neo.v1","bearer.<token>"]`；坏 token → 401/握手失败；
 *  - `/health` 无鉴权、不含 sessionId/token；
 *  - SIGTERM 后进程退出且 core.json 被清理（clearRunInfo）。
 *
 * 全部用临时 NEO_* 目录 + fake LLM；不写真实 ~/.neo、不依赖外网。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TestEnv,
  WsClient,
  connectWsExpectFailure,
  serveStdioAvailable,
  startWsCore,
  type WsCore,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/ws] serve 尚未可用：WS e2e 已跳过（实现落地后自动启用）");

const TIMEOUT = 30000;

function httpOf(wsUrl: string, path: string): string {
  return wsUrl.replace(/^ws:\/\//, "http://").replace(/\/ws$/, path);
}

describe.skipIf(!available)("WS e2e", () => {
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

  async function setup(name: string): Promise<{ env: TestEnv; core: WsCore; token: string }> {
    env = await TestEnv.create(name, { scenario: "tool-then-answer" });
    wsCore = await startWsCore({ dirs: env.dirs, fake: env.fake });
    const token = await wsCore.readToken();
    return { env, core: wsCore, token };
  }

  /* ------------------------- 握手 / 鉴权 / health ------------------------ */

  test(
    "握手：core.json 发现 → 子协议鉴权 ready；坏 token 401；/health 无敏感信息",
    async () => {
      const { env: e, core, token } = await setup("ws-handshake");
      const info = core.runInfo;
      expect(info.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
      expect(typeof info.pid).toBe("number");
      expect(info.pid).toBeGreaterThan(0);
      expect(info.tokenFile).toContain(e.dirs.run);
      expect(typeof info.sessionId).toBe("string");
      expect(typeof info.epoch).toBe("string");

      // token 是 0600 的 64 hex。
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      // /health：无鉴权、无 sessionId、无 token。
      const healthRes = await fetch(httpOf(info.url, "/health"));
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as Record<string, unknown>;
      expect(health["ok"]).toBe(true);
      expect(health["protocolVersion"]).toBe("1.2");
      expect(String(health["coreVersion"])).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof health["uptimeMs"]).toBe("number");
      expect(health["state"]).toBe("idle");
      expect(JSON.stringify(health)).not.toContain(token);
      expect(health["sessionId"]).toBeUndefined();
      expect(health["token"]).toBeUndefined();

      // 坏 token：HTTP 升级直接 401；WebSocket 客户端得到 error/close。
      const unauthorized = await fetch(info.url.replace(/^ws:\/\//, "http://"), {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "neo.v1, bearer.deadbeef",
        },
      });
      expect(unauthorized.status).toBe(401);
      const failure = await connectWsExpectFailure({ url: info.url, token: "deadbeef" });
      expect(["error", "close"]).toContain(failure.kind);

      // 正确 token：首帧 ready。
      client = await WsClient.connect({ url: info.url, token });
      const ready = await client.ready();
      expect(client.frames[0]?.kind).toBe("ready");
      expect(ready.v).toBe(1);
      expect(ready.user).toMatchObject({ id: "local", role: "owner" });
      expect(ready.sessionId).toBe(info.sessionId);
      expect(ready.epoch).toBe(info.epoch);
      expect(ready.protocolVersion).toBe("1.2");
      expect(ready.capabilities).toContain("turn.aborted");
      expect(client.nonJsonMessages).toEqual([]);

      // SIGTERM：退出码 0 + core.json 清理。
      const code = await core.stop();
      wsCore = null;
      expect(code).toBe(0);
      expect(existsSync(core.coreJsonPath)).toBe(false);
    },
    TIMEOUT,
  );

  /* ------------------------- ping / attach / 完整轮 ------------------------ */

  test(
    "ping→pong、attach→snapshot、turn.send 完整轮（stats；事件体内无 seq）",
    async () => {
      const { env: e, core, token } = await setup("ws-turn");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      client = await WsClient.connect({ url: core.runInfo.url, token });
      const ready = await client.ready();

      // ping：仅 pong 帧，无 result。
      const pingMark = client.mark();
      client.send({ type: "ping" });
      await client.awaitFrame((f) => f.kind === "pong", "pong", { since: pingMark });
      expect(client.framesSince(pingMark).some((f) => f.kind === "result")).toBe(false);

      // attach：result.role + snapshot 帧。
      const attachMark = client.mark();
      const attach = await client.requestOk({ type: "session.attach" }, { since: attachMark });
      expect(attach.data).toMatchObject({ role: "owner" });
      const snapFrame = await client.awaitFrame((f) => f.kind === "snapshot", "snapshot", {
        since: attachMark,
      });
      expect(snapFrame.sessionId).toBe(ready.sessionId);
      expect((snapFrame.snapshot as any).epoch).toBe(ready.epoch);

      // 完整一轮。
      const mark = client.mark();
      await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "ws-turn-1" }, { since: mark });
      const end = await client.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const events = client.eventsSince(mark);
      const types = events.map((f) => f.event.type as string);
      for (const t of ["turn.start", "assistant.start", "assistant.end", "tool.start", "tool.end", "stats"]) {
        expect(types, `缺事件 ${t}；实际=${types.join(",")}`).toContain(t);
      }
      // 协议 §3：seq 只在信封上，事件体内不得有。
      for (const f of events) {
        expect(f.sessionId).toBe(ready.sessionId);
        expect(typeof f.seq).toBe("number");
        expect("seq" in (f.event as object), `事件体内不应出现 seq：${JSON.stringify(f.event)}`).toBe(false);
      }
      expect(client.nonJsonMessages).toEqual([]);

      // dup clientId 幂等：同一 clientId 再投递 → 同一 turnId（协议 §4.2）。
      const dup = await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "ws-turn-1" });
      const firstTurnId = events.find((f) => f.event?.type === "turn.start")?.event.turnId;
      expect((dup.data as any)?.turnId).toBe(firstTurnId);
    },
    TIMEOUT,
  );

  /* ------------------------------ 重连 ------------------------------ */

  test(
    "重连 attach{lastSeq,epoch} 不崩并返回 snapshot；SIGTERM 干净收尾",
    async () => {
      const { env: e, core, token } = await setup("ws-reconnect");
      await writeFile(join(e.dirs.work, "a.txt"), "hello\n", "utf8");
      client = await WsClient.connect({ url: core.runInfo.url, token });
      const ready = await client.ready();

      const mark = client.mark();
      await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "ws-rc-1" }, { since: mark });
      const stats = await client.awaitTurnEnd(mark);
      expect(stats.event.type).toBe("stats");
      const lastSeq = stats.seq as number;
      expect(lastSeq).toBeGreaterThan(0);

      // 断线重连：带 lastSeq/epoch 的 attach 必须给出快照（v0.0.1 允许直接整快照）。
      await client.close();
      client = null;
      client = await WsClient.connect({ url: core.runInfo.url, token });
      await client.ready();
      const mark2 = client.mark();
      const res = await client.requestOk(
        { type: "session.attach", lastSeq, epoch: ready.epoch },
        { since: mark2 },
      );
      expect(res.data).toMatchObject({ role: "owner" });
      const snap = await client.awaitFrame((f) => f.kind === "snapshot", "重连 snapshot", { since: mark2 });
      expect(snap.sessionId).toBe(ready.sessionId);
      expect((snap.snapshot as any).epoch).toBe(ready.epoch);
      expect(snap.seq).toBeGreaterThanOrEqual(lastSeq);
      // 快照 blocks 里应有上一轮的 user/assistant 文本（有损可接受，但主文本要在）。
      const text = JSON.stringify((snap.snapshot as any).blocks);
      expect(text).toContain("看看 a.txt");

      const code = await core.stop();
      wsCore = null;
      expect(code).toBe(0);
      expect(existsSync(core.coreJsonPath)).toBe(false);
    },
    TIMEOUT,
  );
  test(
    "超长帧（>8MB）：result ok:false code too_large 且 id 与请求一致；连接不被打断",
    async () => {
      const { core, token } = await setup("ws-too-large");
      client = await WsClient.connect({ url: core.runInfo.url, token });
      await client.ready();

      // 8MB + 1KB：超过 MAX_FRAME_BYTES（attachments 上限 8MB）。
      const hugeText = "x".repeat(8 * 1024 * 1024 + 1024);
      const command = { type: "turn.send", text: hugeText, clientId: "too-large" };
      const rawFrame = JSON.stringify({ v: 1, kind: "command", id: "too-large-req", command });
      expect(Buffer.byteLength(rawFrame, "utf8")).toBeGreaterThan(8 * 1024 * 1024);

      const mark = client.mark();
      const id = client.send(command);
      // 服务端必须从超长帧里轻量提取 id，保证客户端能把错误关联到请求。
      const res = await client.awaitResult(id, { since: mark, timeoutMs: 20000 });
      expect(res.ok).toBe(false);
      expect(res.id).toBe(id);
      expect((res.error as any)?.code).toBe("too_large");
      expect((res.error as any)?.retryable).toBe(false);
      // 超长帧不得触发一轮。
      expect(client.eventsSince(mark).length).toBe(0);

      // 连接仍可用（不能因超长帧断连）。
      const pingMark = client.mark();
      client.send({ type: "ping" });
      await client.awaitFrame((f) => f.kind === "pong", "超长帧后 pong", { since: pingMark, timeoutMs: 5000 });
      void rawFrame;
    },
    TIMEOUT,
  );

});
