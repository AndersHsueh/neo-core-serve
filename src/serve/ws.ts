/**
 * serve/ws.ts — 本地 WebSocket 服务 + /health + --dev-auth 登录。
 *
 * 只绑 127.0.0.1；token 子协议鉴权；Origin 白名单；stdout 不写日志。
 */
import type { Server, ServerWebSocket } from "bun";
import { decodeFrame } from "./stdio.ts";
import { dispatchCommand, eventFrame, readyFrame } from "./dispatch.ts";
import { tokenFromProtocols, tokenMatches } from "./auth.ts";
import type { HostPort } from "./types.ts";
import type { ServerMessage } from "../protocol/types.ts";

export interface WsOptions {
  host: HostPort;
  coreVersion: string;
  port: number;
  token: string;
  devAuth: boolean;
}

export interface WsHandle {
  server: Server<{ id: string }>;
  url: string;
  stop(): Promise<void>;
}

const decoder = new TextDecoder();

const LOCAL_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|tauri:\/\/localhost|null)$/;

function originAllowed(origin: string | null): boolean {
  if (origin === null) return true; // CLI/脚本无 Origin
  return LOCAL_ORIGIN.test(origin);
}

export function startWsServer(opts: WsOptions): WsHandle {
  const clients = new Set<ServerWebSocket<{ id: string }>>();
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          coreVersion: opts.coreVersion,
          protocolVersion: "1.1",
          state: "idle",
          uptimeMs: Math.round(performance.now()),
        });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        if (!opts.devAuth) return new Response("dev auth disabled", { status: 403 });
        if (!originAllowed(req.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
        return Response.json({
          token: opts.token,
          expiresAt: Date.now() + 24 * 3600 * 1000,
          user: { id: "local", email: "local@localhost", displayName: "Local", role: "owner" },
        });
      }
      if (url.pathname === "/ws") {
        if (!originAllowed(req.headers.get("origin"))) return new Response("forbidden origin", { status: 403 });
        const tok = tokenFromProtocols(req.headers.get("sec-websocket-protocol") ?? undefined);
        if (!tokenMatches(opts.token, tok)) return new Response("unauthorized", { status: 401 });
        const okUpgrade = srv.upgrade(req, {
          data: { id: crypto.randomUUID() },
          headers: { "Sec-WebSocket-Protocol": "neo.v1" },
        });
        if (!okUpgrade) return new Response("upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify(readyFrame(opts.host, opts.coreVersion)));
      },
      async message(ws, raw) {
        try {
          const text = typeof raw === "string" ? raw : decoder.decode(raw);
          const decoded = decodeFrame(text);
          if (!decoded.ok) {
            ws.send(JSON.stringify({ v: 1, kind: "result", id: decoded.id, ok: false, error: decoded.error }));
            return;
          }
          const send = {
            frame: (msg: ServerMessage): void => {
              if (ws.readyState !== WebSocket.OPEN) return;
              try {
                ws.send(JSON.stringify(msg));
              } catch {
                // 对端已关闭：丢弃该帧，不影响 core
              }
            },
          };
          await dispatchCommand({ host: opts.host, coreVersion: opts.coreVersion, send }, decoded.id, decoded.command);
        } catch (error) {
          process.stderr.write(`[matrix-core] ws message error: ${(error as Error).message}\n`);
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  const unsub = opts.host.onEvent((event) => {
    if (clients.size === 0) return; // 无人订阅时不序列化
    const frame = JSON.stringify(eventFrame(opts.host, event));
    for (const ws of clients) {
      try {
        ws.send(frame);
      } catch {
        clients.delete(ws);
      }
    }
  });

  log(`[matrix-core] ws listening on ws://127.0.0.1:${server.port}/ws`);

  return {
    server,
    url: `ws://127.0.0.1:${server.port}/ws`,
    async stop() {
      unsub();
      for (const ws of clients) {
        try {
          ws.close(1001, "core shutting down");
        } catch {
          /* 已关闭 */
        }
      }
      clients.clear();
      // Bun 在「客户端刚发起 close、close 事件尚未派发」的窗口里 stop(true) 可能永不 resolve。
      // 关闭路径必须有超时兜底，绝不能让锁/core.json 残留。
      await Promise.race([
        Promise.resolve(server.stop(true)).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 150)),
      ]);
    },
  };
}
