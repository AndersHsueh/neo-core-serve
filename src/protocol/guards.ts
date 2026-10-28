/**
 * protocol/guards.ts — 边界校验：只信任经过这里的字节。
 *
 * 设计：手写窄化，不引 zod。策略是“宽进严出”——
 * 结构不对直接拒（protocol 错），字段缺失也拒；未知事件类型拒，
 * 让不兼容的 hub 立刻暴露，而不是静默半渲染。
 */

import type { ClientCommand, HubError, ServerMessage, SessionEvent } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: HubError };

const protocolError = (detail: string): HubError => ({
  code: "protocol",
  message: detail,
  retryable: false,
});

const fail = <T>(detail: string): DecodeResult<T> => ({ ok: false, error: protocolError(detail) });

const EVENT_TYPES = new Set<SessionEvent["type"]>([
  "turn.start",
  "assistant.start",
  "assistant.delta",
  "assistant.end",
  "reasoning.start",
  "reasoning.delta",
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
  "command.progress",
  "command.result",
  "session.cleared",
  "activity",
  "notice",
]);

const COMMAND_TYPES = new Set<ClientCommand["type"]>([
  "auth.login",
  "auth.logout",
  "auth.whoami",
  "session.list",
  "session.create",
  "session.attach",
  "session.detach",
  "session.rename",
  "session.close",
  "turn.send",
  "turn.abort",
  "approval.resolve",
  "question.answer",
  "command.run",
  "settings.get",
  "settings.patch",
  "mode.set",
  "usage.summary",
  "ping",
]);

/** 会话事件的最小字段校验。深层结构（diff、usage）由渲染层防御。 */
function decodeEvent(raw: unknown): DecodeResult<SessionEvent> {
  if (!isRec(raw)) return fail("event: not an object");
  const type = raw.type;
  if (typeof type !== "string") return fail("event: missing type");
  // v1.1：未知事件类型必须放行（客户端能力降级），由 reducer/UI 忽略。
  if (!EVENT_TYPES.has(type as SessionEvent["type"])) {
    return { ok: true, value: raw as unknown as SessionEvent };
  }
  const need = (key: string): DecodeResult<unknown> =>
    key in raw ? { ok: true, value: raw[key] } : fail(`event ${type}: missing ${key}`);

  switch (type) {
    case "turn.start":
    case "assistant.start":
    case "reasoning.start":
    case "tool.start":
    case "approval.request":
    case "question.request":
    case "stats":
    case "banner": {
      for (const key of ["blockId", "at"]) {
        const r = need(key);
        if (!r.ok) return r;
      }
      break;
    }
    case "tier.switch": {
      const r = need("at");
      if (!r.ok) return r;
      break;
    }
    case "assistant.delta":
    case "reasoning.delta":
    case "tool.end":
    case "approval.resolve":
    case "assistant.end":
    case "reasoning.end": {
      const r = need("blockId");
      if (!r.ok) return r;
      break;
    }
    case "question.resolve": {
      for (const key of ["blockId", "at"]) {
        const r = need(key);
        if (!r.ok) return r;
      }
      break;
    }
    case "turn.aborted":
    case "command.progress":
    case "session.cleared":
    case "activity":
    case "notice":
    case "compact.start":
    case "compact.end": {
      break;
    }
    case "command.result": {
      for (const key of ["blockId", "name", "ok"]) {
        const r = need(key);
        if (!r.ok) return r;
      }
      break;
    }
    case "session.meta":
    case "session.status":
    case "context":
    case "peer.update":
    case "auth.expired": {
      break;
    }
    case "error": {
      for (const key of ["blockId", "at", "code", "message", "retryable"]) {
        const r = need(key);
        if (!r.ok) return r;
      }
      break;
    }
    default:
      break;
  }
  return { ok: true, value: raw as unknown as SessionEvent };
}

export function decodeServerMessage(raw: unknown): DecodeResult<ServerMessage> {
  if (!isRec(raw)) return fail("message: not an object");
  if (raw.v !== PROTOCOL_VERSION) return fail(`message: unsupported version ${String(raw.v)}`);
  const kind = raw.kind;

  switch (kind) {
    case "ready": {
      const user = raw.user;
      if (!isRec(user) || !isStr(user.id) || !isStr(user.email)) {
        return fail("ready: bad user");
      }
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "result": {
      if (!isStr(raw.id)) return fail("result: missing id");
      if (raw.ok === true) return { ok: true, value: raw as unknown as ServerMessage };
      if (raw.ok === false) {
        const err = raw.error;
        if (!isRec(err) || !isStr(err.code)) return fail("result: bad error");
        return { ok: true, value: raw as unknown as ServerMessage };
      }
      return fail("result: ok must be boolean");
    }
    case "event": {
      if (!isStr(raw.sessionId)) return fail("event: missing sessionId");
      if (!isNum(raw.seq)) return fail("event: missing seq");
      const event = decodeEvent(raw.event);
      if (!event.ok) return { ok: false, error: event.error };
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "snapshot": {
      if (!isStr(raw.sessionId)) return fail("snapshot: missing sessionId");
      if (!isNum(raw.seq)) return fail("snapshot: missing seq");
      const snap = raw.snapshot;
      if (!isRec(snap) || !isRec(snap.meta) || !isArr(snap.blocks) || !isStr(snap.epoch)) {
        return fail("snapshot: bad payload");
      }
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "sessions": {
      if (!isArr(raw.sessions)) return fail("sessions: missing list");
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "settings": {
      if (!isRec(raw.settings)) return fail("settings: missing payload");
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "usage": {
      if (!isArr(raw.records) || !isRec(raw.totals)) return fail("usage: bad payload");
      return { ok: true, value: raw as unknown as ServerMessage };
    }
    case "pong":
      return { ok: true, value: raw as unknown as ServerMessage };
    default:
      return fail(`message: unknown kind ${String(kind)}`);
  }
}

export function decodeClientMessage(raw: unknown): DecodeResult<ClientCommand> {
  if (!isRec(raw)) return fail("command: not an object");
  if (raw.v !== PROTOCOL_VERSION) return fail(`command: unsupported version ${String(raw.v)}`);
  if (raw.kind !== "command" || !isStr(raw.id) || !isRec(raw.command)) {
    return fail("command: bad envelope");
  }
  const command = raw.command;
  const type = command.type;
  if (typeof type !== "string" || !COMMAND_TYPES.has(type as ClientCommand["type"])) {
    return fail(`command: unknown type ${String(type)}`);
  }
  const need = (key: string, kind: "string" | "number" | "boolean"): DecodeResult<unknown> => {
    const v = command[key];
    const ok = kind === "string" ? isStr(v) : kind === "number" ? isNum(v) : isBool(v);
    return ok ? { ok: true, value: v } : fail(`command ${type}: bad ${key}`);
  };
  // v1.1：会话命令的 sessionId 可选（单会话 core 忽略；兼容 GUI 旧调用）
  const optionalSession = (): DecodeResult<unknown> => {
    if (!("sessionId" in command)) return { ok: true, value: undefined };
    return isStr(command["sessionId"]) ? { ok: true, value: command["sessionId"] } : fail(`command ${type}: bad sessionId`);
  };

  switch (type) {
    case "auth.login": {
      for (const key of ["email", "password"]) {
        const r = need(key, "string");
        if (!r.ok) return r;
      }
      break;
    }
    case "session.attach":
    case "session.detach":
    case "session.rename":
    case "session.close":
    case "turn.abort":
    case "turn.send": {
      const r = optionalSession();
      if (!r.ok) return r;
      if (type === "session.rename") {
        const t = need("title", "string");
        if (!t.ok) return t;
      }
      if (type === "turn.send") {
        for (const key of ["text", "clientId"]) {
          const x = need(key, "string");
          if (!x.ok) return x;
        }
      }
      break;
    }
    case "approval.resolve": {
      const r = optionalSession();
      if (!r.ok) return r;
      for (const key of ["blockId", "decision"]) {
        const x = need(key, "string");
        if (!x.ok) return x;
      }
      break;
    }
    case "question.answer": {
      const r = optionalSession();
      if (!r.ok) return r;
      const b = need("blockId", "string");
      if (!b.ok) return b;
      if ("keys" in command && !isArr(command["keys"])) return fail("question.answer: keys must be array");
      if ("key" in command && !isStr(command["key"])) return fail("question.answer: bad key");
      if ("custom" in command && !isStr(command["custom"])) return fail("question.answer: bad custom");
      break;
    }
    case "command.run": {
      const r = optionalSession();
      if (!r.ok) return r;
      if (!isArr(command.args)) return fail("command.run: args must be array");
      break;
    }
    case "settings.patch": {
      if (!isRec(command.patch)) return fail("settings.patch: patch must be object");
      break;
    }
    default:
      break;
  }
  return { ok: true, value: command as unknown as ClientCommand };
}

/** WebSocket 文本帧 → 类型化消息 */
export function decodeServerText(text: string): DecodeResult<ServerMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("message: invalid JSON");
  }
  return decodeServerMessage(raw);
}

export function makeClientMessage(id: string, command: ClientCommand): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, kind: "command", id, command });
}
