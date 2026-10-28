/**
 * serve/types.ts — 服务层依赖的 SessionHost 端口（结构化类型）。
 *
 * core 由 coder 实现；serve 只依赖这个接口，避免循环依赖。
 * 协议类型可以 import（serve 本来就是映射层）。
 */
import type {
  CommandChanges,
  PermissionMode,
  SessionEvent,
  SessionMeta,
  ImageAttachmentInput,
  SessionSnapshot,
  SettingsView,
  Usage,
  UsageRecord,
  ViewBlock,
} from "../protocol/types.ts";

/** 进行中的事件带 seq（host 分配；serve 只透传） */
export type HostEvent = SessionEvent & { seq: number };

/** 命令结果（core 领域 -> serve 的 wire 形状） */
export interface CommandOutcome {
  ok: boolean;
  blocks: ViewBlock[];
  changes?: CommandChanges;
  error?: { code: string; message: string };
}

export interface SendRef {
  icon: string;
  label: string;
  kind?: "file" | "skill" | "url";
  path?: string;
}

export interface HostPort {
  readonly sessionId: string;
  readonly epoch: string;
  readonly seq: number;
  meta(): SessionMeta;
  configView(): SettingsView;
  usage(): { records: UsageRecord[]; totals: Usage };
  snapshot(): SessionSnapshot;
  live(): SessionSnapshot["live"];
  send(text: string, refs: SendRef[] | undefined, clientId: string, attachments?: ImageAttachmentInput[]): Promise<{ turnId: string }>;
  abort(turnId?: string): Promise<{ aborted: boolean }>;
  resolveApproval(blockId: string, decision: "allow" | "deny" | "allow-session"): boolean;
  answerQuestion(blockId: string, keys: string[], custom?: string): boolean;
  runCommand(name: string, args: string[]): Promise<CommandOutcome>;
  /** v0.0.2：durable 事件回放（fromSeq 不含） */
  fetchTranscript(fromSeq?: number, limit?: number): { events: Array<{ seq: number; event: SessionEvent }>; nextSeq?: number };
  setMode(mode: PermissionMode): Promise<void>;
  rename(title: string): void;
  close(): Promise<void>;
  onEvent(cb: (event: HostEvent) => void): () => void;
}
