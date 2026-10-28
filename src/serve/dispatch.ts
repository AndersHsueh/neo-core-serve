/**
 * serve/dispatch.ts — 命令分发（WS 与 stdio 共用）。
 *
 * 输入是协议 ClientCommand，输出通过 send 回调写回帧。
 * 这里负责：信封、幂等/冲突、错误码、attach/snapshot。
 */
import type {
  ClientCommand,
  HubError,
  HubErrorCode,
  ServerMessage,
} from "../protocol/types.ts";
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from "../protocol/types.ts";
import type { HostEvent, HostPort } from "./types.ts";

export interface Send {
  frame(msg: ServerMessage): void;
}

export const user = { id: "local", email: "local@localhost", displayName: "Local", role: "owner" as const };

/** v0.0.1 实际具备的能力（不要广告未实现项；v0.0.2 再扩）。 */
export const CORE_CAPABILITIES: readonly string[] = [
  "turn.aborted",
  "command.structured",
  "mode.set",
  "snapshot.live",
  "activity",
  "question.multi",
];

export function readyFrame(host: HostPort, coreVersion: string): ServerMessage {
  return {
    v: PROTOCOL_VERSION,
    kind: "ready",
    user,
    coreVersion,
    protocolVersion: PROTOCOL_SEMVER,
    capabilities: [...CORE_CAPABILITIES],
    sessionId: host.sessionId,
    epoch: host.epoch,
  };
}

export function eventFrame(host: HostPort, event: HostEvent): ServerMessage {
  const { seq, ...body } = event;
  return {
    v: PROTOCOL_VERSION,
    kind: "event",
    sessionId: host.sessionId,
    seq,
    event: body as ServerMessage extends { kind: "event"; event: infer E } ? E : never,
  };
}

export function err(code: HubErrorCode, message: string, retryable = false): HubError {
  return { code, message, retryable };
}

export function makeResult(id: string, ok: true, data: unknown): ServerMessage;
export function makeResult(id: string, ok: false, error: HubError): ServerMessage;
export function makeResult(id: string, ok: boolean, data: unknown): ServerMessage {
  if (ok) return { v: PROTOCOL_VERSION, kind: "result", id, ok: true, data };
  return { v: PROTOCOL_VERSION, kind: "result", id, ok: false, error: data as HubError };
}

export interface DispatchDeps {
  host: HostPort;
  coreVersion: string;
  send: Send;
}

export async function dispatchCommand(deps: DispatchDeps, id: string, command: ClientCommand): Promise<void> {
  const { host, send } = deps;
  const ok = (data: unknown): void => send.frame(makeResult(id, true, data));
  const fail = (code: HubErrorCode, message: string, retryable = false): void =>
    send.frame(makeResult(id, false, err(code, message, retryable)));

  try {
    switch (command.type) {
      case "ping":
        send.frame({ v: PROTOCOL_VERSION, kind: "pong" });
        return;
      case "session.list":
        ok({ sessions: [host.meta()] });
        return;
      case "session.create":
        ok({ sessionId: host.sessionId });
        return;
      case "session.attach": {
        ok({ role: "owner" });
        send.frame({ v: PROTOCOL_VERSION, kind: "snapshot", sessionId: host.sessionId, seq: host.seq, snapshot: host.snapshot() });
        return;
      }
      case "session.detach":
        ok({});
        return;
      case "session.rename":
        host.rename(command.title);
        ok({});
        return;
      case "session.close":
        fail("unsupported", "v0.0.1 单会话模式不支持 close；请退出 core 进程", false);
        return;
      case "turn.send": {
        const { turnId } = await host.send(command.text, command.refs, command.clientId);
        ok({ turnId });
        return;
      }
      case "turn.abort": {
        const r = await host.abort(command.turnId);
        ok(r);
        return;
      }
      case "approval.resolve": {
        const done = host.resolveApproval(command.blockId, command.decision);
        if (!done) fail("approval_expired", "审批不存在或已超时");
        else ok({ resolved: command.decision });
        return;
      }
      case "question.answer": {
        const keys = command.keys ?? (command.key ? [command.key] : []);
        const done = host.answerQuestion(command.blockId, keys, command.custom);
        if (!done) fail("question_expired", "提问不存在或已超时");
        else ok({ answered: keys });
        return;
      }
      case "command.run": {
        const outcome = await host.runCommand(command.name, command.args);
        ok({ ok: outcome.ok, blocks: outcome.blocks, changes: outcome.changes, error: outcome.error });
        return;
      }
      case "settings.get":
        ok({ settings: host.configView() });
        return;
      case "settings.patch":
        fail("unsupported", "v0.0.1 不支持 settings.patch");
        return;
      case "mode.set":
        await host.setMode(command.mode);
        ok({});
        return;
      case "usage.summary": {
        const usage = host.usage();
        ok({ range: command.range, records: usage.records, totals: usage.totals });
        return;
      }
      case "auth.login":
      case "auth.logout":
      case "auth.whoami":
        fail("unsupported", "本地 core 不使用 auth.* 命令（请用 token 或 --dev-auth HTTP 登录）");
        return;
      default: {
        const exhaustive: never = command;
        void exhaustive;
        fail("protocol", "unhandled command");
        return;
      }
    }
  } catch (error) {
    const e = error as { code?: string; message?: string };
    // 只暴露协议内错误码；Node errno/内部错误统一 internal，避免客户端按未知 code 乱重试。
    const known: ReadonlySet<string> = new Set([
      "unauthorized","forbidden","not_found","conflict","rate_limited","timeout",
      "approval_expired","question_expired","session_gone","slow_consumer","unsupported","protocol","internal",
    ]);
    const code: HubErrorCode = e.code && known.has(e.code) ? (e.code as HubErrorCode) : "internal";
    const retryable = code === "internal" || code === "timeout" || code === "rate_limited";
    fail(code, e.message ?? String(error), retryable);
  }
}
