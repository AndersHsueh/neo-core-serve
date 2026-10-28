/**
 * hub/server.ts — 本地多会话 Hub（v0.0.2）。
 *
 * Hub 不内嵌 Agent：每会话一个 worker 子进程（stdio 帧转发）。
 * 客户端仍用同一套 WS 协议；session.* 命令由 Hub 处理，其余转发给已绑定的 worker。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from "../protocol/types.ts";
import type { ClientCommand, HubError, HubErrorCode, ServerMessage, SessionMeta } from "../protocol/types.ts";
import { CORE_CAPABILITIES, err, user as localUser } from "../serve/dispatch.ts";
import { tokenFromProtocols, tokenMatches } from "../serve/auth.ts";
import { EventBatcher } from "../serve/batcher.ts";
import { decodeFrame, frameTooLarge, tooLargeResult } from "../serve/frames.ts";
import { WorkerClient } from "./worker.ts";
import { sessionsDir } from "../core/paths.ts";
import { loadConfig } from "../core/config.ts";
import { buildSettingsView } from "../core/session-host.ts";

export interface HubOptions {
  port: number;
  token: string;
  devAuth: boolean;
  defaultCwd: string;
  coreVersion: string;
}

export interface HubHandle {
  url: string;
  stop(): Promise<void>;
}

interface Conn {
  sessionId: string | null;
  batcher: EventBatcher;
}

interface Entry {
  client: WorkerClient;
  owner: ServerWebSocket<{ id: string }> | null;
  lastSeq: number;
  unsub: () => void;
  unsubExit: () => void;
}

const inboundDecoder = new TextDecoder();

const LOCAL_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|tauri:\/\/localhost|null)$/;
const FORWARDED = new Set<ClientCommand["type"]>([
  "turn.send", "turn.abort", "approval.resolve", "question.answer", "command.run",
  "settings.get", "mode.set", "usage.summary", "transcript.fetch", "session.rename",
]);

export function startHub(opts: HubOptions): HubHandle {
  const conns = new Map<ServerWebSocket<{ id: string }>, Conn>();
  const workers = new Map<string, Entry>();
  const inflightSpawns = new Map<string, Promise<Entry | null>>();
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const originAllowed = (origin: string | null): boolean => origin === null || LOCAL_ORIGIN.test(origin);

  const metaCache = new Map<string, { mtimeMs: number; meta: SessionMeta }>();
  const sessionsOnDisk = (): SessionMeta[] => {
    const dir = sessionsDir();
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const file of files) {
      try {
        const abs = join(dir, file);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(abs).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        const cached = metaCache.get(abs);
        if (cached && cached.mtimeMs === mtimeMs) {
          out.push(cached.meta);
          continue;
        }
        const raw = JSON.parse(readFileSync(abs, "utf8")) as {
          meta?: { id?: string; model?: string; cwd?: string; createdAt?: string; updatedAt?: string; turns?: number };
        };
        const meta = raw.meta ?? {};
        const id = meta.id ?? file.replace(/\.json$/, "");
        const running = workers.get(id)?.client.alive() === true;
        const mapped: SessionMeta = {
          id,
          title: `会话 ${id.slice(-6)}`,
          ownerId: "local",
          status: running ? "working" : "idle",
          tier: "default",
          provider: "",
          model: meta.model ?? "unknown",
          cwd: meta.cwd ?? opts.defaultCwd,
          createdAt: meta.createdAt ? Date.parse(meta.createdAt) : 0,
          updatedAt: meta.updatedAt ? Date.parse(meta.updatedAt) : 0,
          unread: 0,
          mode: "ask",
        };
        metaCache.set(abs, { mtimeMs, meta: mapped });
        out.push(mapped);
      } catch {
        /* 损坏会话跳过 */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  };

  const listSessions = async (): Promise<SessionMeta[]> => {
    const disk = sessionsOnDisk();
    const ids = new Set(disk.map((m) => m.id));
    const missing = [...workers].filter(([id]) => !ids.has(id));
    const extra = await Promise.all(
      missing.map(async ([, entry]) => {
        try {
          const data = (await Promise.race([
            entry.client.request({ type: "session.list" }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
          ])) as { sessions?: SessionMeta[] };
          const meta = data.sessions?.[0];
          return meta ? { ...meta, status: "working" as const } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const meta of extra) if (meta) disk.push(meta);
    disk.sort((a, b) => b.updatedAt - a.updatedAt);
    return disk;
  };

  const sessionCwd = (sessionId: string): string => {
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir(), `${sessionId}.json`), "utf8")) as { meta?: { cwd?: string } };
      return raw.meta?.cwd ?? opts.defaultCwd;
    } catch {
      return opts.defaultCwd;
    }
  };

  const connOf = (ws: ServerWebSocket<{ id: string }>): Conn | undefined => conns.get(ws);
  const send = (ws: ServerWebSocket<{ id: string }>, frame: ServerMessage): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buffered = ws.getBufferedAmount?.() ?? 0;
    if (buffered > 4 * 1024 * 1024) {
      try {
        ws.close(4408, "slow consumer");
      } catch {
        /* closed */
      }
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closed */
    }
  };
  const reply = (ws: ServerWebSocket<{ id: string }>, id: string, ok: boolean, data: unknown): void => {
    send(ws, ok
      ? { v: PROTOCOL_VERSION, kind: "result", id, ok: true, data }
      : { v: PROTOCOL_VERSION, kind: "result", id, ok: false, error: data as HubError });
  };
  const fail = (ws: ServerWebSocket<{ id: string }>, id: string, code: HubErrorCode, message: string, retryable = false): void => {
    reply(ws, id, false, err(code, message, retryable));
  };

  const ensureWorker = async (sessionId: string): Promise<Entry | null> => {
    const existing = workers.get(sessionId);
    if (existing?.client.alive()) return existing;
    const inflight = inflightSpawns.get(sessionId);
    if (inflight) return inflight;
    const job = (async (): Promise<Entry | null> => {
      if (existing) {
        existing.unsub();
        existing.unsubExit();
        workers.delete(sessionId);
      }
      try {
        const client = await WorkerClient.spawn({ cwd: sessionCwd(sessionId), resume: sessionId });
        return register(client);
      } catch (error) {
        log(`[hub] resume ${sessionId} failed: ${(error as Error).message}`);
        return null;
      } finally {
        inflightSpawns.delete(sessionId);
      }
    })();
    inflightSpawns.set(sessionId, job);
    return job;
  };

  const register = (client: WorkerClient): Entry => {
    const entry: Entry = {
      client,
      owner: null,
      lastSeq: 0,
      unsub: () => undefined,
      unsubExit: () => undefined,
    };
    entry.unsub = client.onEvent((frame) => {
      entry.lastSeq = Math.max(entry.lastSeq, frame.seq);
      if (entry.owner) connOf(entry.owner)?.batcher.enqueue(frame);
    });
    entry.unsubExit = client.onExit(() => {
      if (workers.get(client.sessionId) === entry) workers.delete(client.sessionId);
      if (entry.owner) {
        const ws = entry.owner;
        const conn = connOf(ws);
        conn?.batcher.enqueue({
          v: PROTOCOL_VERSION,
          kind: "event",
          sessionId: client.sessionId,
          seq: entry.lastSeq,
          event: { type: "session.status", status: "dead" },
        });
        if (conn) conn.sessionId = null;
        entry.owner = null;
      }
    });
    workers.set(client.sessionId, entry);
    return entry;
  };

  const createWorker = async (cwd: string, title?: string): Promise<Entry> => {
    const client = await WorkerClient.spawn({ cwd, resume: null });
    const entry = register(client);
    if (title) {
      try {
        await client.request({ type: "session.rename", title });
      } catch {
        /* 标题失败不影响创建 */
      }
    }
    return entry;
  };

  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          mode: "hub",
          coreVersion: opts.coreVersion,
          protocolVersion: PROTOCOL_SEMVER,
          sessions: workers.size,
        });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        if (!opts.devAuth) return new Response("dev auth disabled", { status: 403 });
        if (!originAllowed(req.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
        return Response.json({
          token: opts.token,
          expiresAt: Date.now() + 24 * 3600 * 1000,
          user: localUser,
        });
      }
      if (url.pathname === "/ws") {
        if (!originAllowed(req.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
        const tok = tokenFromProtocols(req.headers.get("sec-websocket-protocol") ?? undefined);
        if (!tokenMatches(opts.token, tok)) return new Response("unauthorized", { status: 401 });
        const ok = srv.upgrade(req, { data: { id: crypto.randomUUID() }, headers: { "Sec-WebSocket-Protocol": "neo.v1" } });
        if (!ok) return new Response("upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const batcher = new EventBatcher({
          send: (frame) => send(ws, frame),
          onOverflow: () => {
            const conn = conns.get(ws);
            if (conn?.sessionId) {
              const entry = workers.get(conn.sessionId);
              if (entry?.owner === ws) entry.owner = null;
              conn.sessionId = null;
            }
            try {
              ws.close(4408, "slow consumer");
            } catch {
              /* closed */
            }
            conns.delete(ws);
          },
        });
        conns.set(ws, { sessionId: null, batcher });
        send(ws, {
          v: PROTOCOL_VERSION,
          kind: "ready",
          user: localUser,
          coreVersion: opts.coreVersion,
          protocolVersion: PROTOCOL_SEMVER,
          capabilities: [...CORE_CAPABILITIES, "sessions"],
        });
      },
      async message(ws, raw) {
        try {
          const text = typeof raw === "string" ? raw : inboundDecoder.decode(raw);
          if (frameTooLarge(text)) {
            send(ws, tooLargeResult(text));
            return;
          }
          const decoded = decodeFrame(text);
          if (!decoded.ok) {
            reply(ws, decoded.id, false, decoded.error);
            return;
          }
          const conn = conns.get(ws);
          if (!conn) return;
          await dispatch(ws, conn, decoded.id, decoded.command);
        } catch (error) {
          log(`[hub] message error: ${(error as Error).message}`);
        }
      },
      close(ws) {
        const conn = conns.get(ws);
        if (conn?.sessionId) {
          const entry = workers.get(conn.sessionId);
          if (entry?.owner === ws) entry.owner = null;
        }
        conn?.batcher.close();
        conns.delete(ws);
      },
    },
  });

  async function dispatch(ws: ServerWebSocket<{ id: string }>, conn: Conn, id: string, command: ClientCommand): Promise<void> {
    try {
      switch (command.type) {
        case "ping":
          send(ws, { v: PROTOCOL_VERSION, kind: "pong" });
          return;
        case "session.list":
          reply(ws, id, true, { sessions: await listSessions() });
          return;
        case "session.create": {
          const cwd = command.cwd ?? opts.defaultCwd;
          const entry = await createWorker(cwd, command.title);
          reply(ws, id, true, { sessionId: entry.client.sessionId });
          return;
        }
        case "session.attach": {
          const sid = command.sessionId;
          if (!sid) return fail(ws, id, "protocol", "session.attach 需要 sessionId");
          if (conn.sessionId && conn.sessionId !== sid) return fail(ws, id, "conflict", "当前连接已绑定其他会话");
          if (!existsSync(join(sessionsDir(), `${sid}.json`))) return fail(ws, id, "not_found", `会话 ${sid} 不存在`);
          const entry = await ensureWorker(sid);
          if (!entry) return fail(ws, id, "not_found", `会话 ${sid} 无法打开`);
          if (entry.owner && entry.owner !== ws) return fail(ws, id, "conflict", "会话已被其他客户端 attach");
          // 先占位再 await，避免并发 attach 两个都看到 owner=null。
          entry.owner = ws;
          conn.sessionId = sid;
          try {
            const snapshot = await entry.client.attach(command.lastSeq, command.epoch);
            reply(ws, id, true, { role: "owner" });
            conn.batcher.enqueue(snapshot);
          } catch (error) {
            if (entry.owner === ws) entry.owner = null;
            conn.sessionId = null;
            fail(ws, id, "internal", `attach 失败：${(error as Error).message}`, true);
          }
          return;
        }
        case "session.detach": {
          const sid = command.sessionId ?? conn.sessionId;
          if (sid) {
            const entry = workers.get(sid);
            if (entry?.owner === ws) entry.owner = null;
            if (conn.sessionId === sid) conn.sessionId = null;
          }
          reply(ws, id, true, {});
          return;
        }
        case "session.close": {
          const sid = command.sessionId ?? conn.sessionId;
          if (!sid) return fail(ws, id, "protocol", "session.close 需要 sessionId");
          const entry = workers.get(sid);
          if (entry && entry.owner && entry.owner !== ws) {
            return fail(ws, id, "forbidden", "只有会话 owner 可以 close");
          }
          if (entry) {
            entry.unsub();
            entry.unsubExit();
            if (workers.get(sid) === entry) workers.delete(sid);
            await entry.client.stopAndWait(2000);
          }
          if (conn.sessionId === sid) conn.sessionId = null;
          reply(ws, id, true, {});
          return;
        }
        case "settings.patch":
          return fail(ws, id, "unsupported", "v0.0.2 Hub 不支持 settings.patch");
        case "auth.login":
        case "auth.logout":
        case "auth.whoami":
          return fail(ws, id, "unsupported", "Hub 使用本地 token / --dev-auth HTTP 登录");
        default:
          break;
      }

      if (!FORWARDED.has(command.type)) return fail(ws, id, "protocol", `unhandled command ${command.type}`);
      // GUI 启动链会在 attach 前调 settings.get：Hub 直接按 defaultCwd 读配置（不 spawn 会话）。
      if (command.type === "settings.get" && !conn.sessionId) {
        try {
          const cfg = loadConfig({ cwd: opts.defaultCwd });
          reply(ws, id, true, { settings: buildSettingsView(cfg) });
        } catch (error) {
          fail(ws, id, "internal", `settings 读取失败：${(error as Error).message}`, true);
        }
        return;
      }
      // 绑定契约：未 attach 的连接不得用显式 sessionId 绕过绑定。
      if (!conn.sessionId) return fail(ws, id, "conflict", "请先 session.attach");
      const sid = conn.sessionId;
      const entry = workers.get(sid);
      if (!entry?.client.alive()) return fail(ws, id, "session_gone", `会话 ${sid} 未运行`);
      const forwarded = { ...command, sessionId: sid } as unknown as ClientCommand;
      try {
        const data = await entry.client.request(forwarded);
        reply(ws, id, true, data);
      } catch (error) {
        const code = (error as { code?: HubErrorCode }).code ?? "internal";
        fail(ws, id, code, (error as Error).message, code === "internal");
      }
    } catch (error) {
      fail(ws, id, "internal", (error as Error).message, true);
    }
  }

  log(`[hub] ws listening on ws://127.0.0.1:${server.port}/ws`);

  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    async stop() {
      for (const [, conn] of conns) conn.batcher.close();
      conns.clear();
      for (const [, entry] of workers) {
        entry.unsub();
        entry.unsubExit();
        entry.client.stop();
      }
      workers.clear();
      await Promise.race([
        Promise.resolve(server.stop(true)).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 150)),
      ]);
    },
  };
}
