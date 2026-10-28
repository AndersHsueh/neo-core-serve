/**
 * protocol/types.ts — 前端 ⇄ hub 的**唯一协议源**。
 *
 * 规则：
 * 1. 这里只有类型与常量，没有运行时逻辑（校验在 guards.ts，样本在 fixtures.ts）。
 * 2. dummy-serv 与未来的真 hub 都 `import type` 这一份；不允许复制字符串或另写一份。
 * 3. 任何字段变更先改本文件，再改实现；文档 `docs/gui-v1-protocol.md` 与之逐条对应。
 */

export const PROTOCOL_VERSION = 1 as const;
/** 语义版本（v1 内仅增量；用于 ready/lock/握手） */
export const PROTOCOL_SEMVER = "1.2" as const;
/** v1.1 能力位（客户端按能力降级） */
export const CAPABILITIES: readonly string[] = [
  "turn.aborted",
  "command.structured",
  "mode.set",
  "snapshot.live",
  "activity",
  "question.multi",
  "transcript.replay",
  "attachments.image",
  "sessions",
];

/* ------------------------------------------------------------------ */
/* 基础域                                                              */
/* ------------------------------------------------------------------ */

export type Tier = "deep_reasoning" | "balanced" | "fast" | "default";
export type PermissionMode = "ask" | "auto-edit" | "auto-all" | "plan";
export type SessionStatus = "idle" | "working" | "waiting" | "stalled" | "dead";
export type Role = "owner" | "member";

export const TIERS: readonly Tier[] = ["deep_reasoning", "balanced", "fast", "default"];
export const MODES: readonly PermissionMode[] = ["ask", "auto-edit", "auto-all", "plan"];

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface TokenGrant {
  token: string;
  /** epoch ms */
  expiresAt: number;
  user: User;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** 百万分之一美元；整数，避免浮点漂移 */
  costMicros: number;
}

export interface UsageRecord extends Usage {
  id: string;
  userId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  tier: Tier;
  /** epoch ms */
  at: number;
}

/* ------------------------------------------------------------------ */
/* 会话元信息                                                          */
/* ------------------------------------------------------------------ */

export interface SessionMeta {
  id: string;
  title: string;
  ownerId: string;
  status: SessionStatus;
  tier: Tier;
  provider: string;
  model: string;
  cwd: string;
  /** epoch ms */
  createdAt: number;
  updatedAt: number;
  unread: number;
  /** 权限模式（v1.1 新增，GUI 需要） */
  mode: PermissionMode;
}

export interface ContextState {
  used: number;
  limit: number;
  /** 0–1，自动压缩阈值 */
  compactAt: number;
}

/* ------------------------------------------------------------------ */
/* 对话块（GUI 形状，由事件 reducer 生成）                             */
/* ------------------------------------------------------------------ */

export interface TurnBlock {
  kind: "turn";
  id: string;
  at: number;
  n: number;
}

export interface UserBlock {
  kind: "user";
  id: string;
  at: number;
  text: string;
  refs?: { icon: string; label: string }[];
  /** 来自 AskUser 的选项回填 */
  picked?: boolean;
  /** 客户端幂等键；刷新/重连时用来保留尚未被 hub 落盘的本地消息 */
  clientId?: string;
}

export type AssistantSegment =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "code"; lang: string; code: string; file?: string };

export interface AssistantBlock {
  kind: "assistant";
  id: string;
  at: number;
  tier: Tier;
  segments: AssistantSegment[];
}

export interface ReasoningBlock {
  kind: "reasoning";
  id: string;
  at: number;
  text: string;
  durationMs: number;
  tokens: number;
  done: boolean;
}

export type ToolState = "running" | "ok" | "error" | "denied";

export interface ToolBlock {
  kind: "tool";
  id: string;
  at: number;
  name: string;
  icon?: string;
  arg: string;
  state: ToolState;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  foot?: string;
}

export interface DiffLine {
  t: "ctx" | "add" | "del";
  ln: number;
  code: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  file: string;
  add: number;
  del: number;
  hunks: DiffHunk[];
}

export type ApprovalState = "pending" | "allowed" | "denied";

export interface ApprovalBlock {
  kind: "approval";
  id: string;
  at: number;
  tool: string;
  /** 请求 id（与 block id 一致；内部用） */
  requestId?: string;
  /** 目标路径；shell 等工具可缺省 */
  path?: string;
  /** 人类可读详情（v1.1） */
  detail?: string;
  /** 结构化 diff；无 diff 时为 null/缺省（v1.1，客户端需 null 保护） */
  diff?: FileDiff | null;
  state: ApprovalState;
  /** epoch ms；超时自动拒绝 */
  deadlineAt?: number;
}

export interface QuestionOption {
  key: string;
  label: string;
  description?: string;
}

export interface QuestionBlock {
  kind: "question";
  id: string;
  at: number;
  prompt: string;
  header?: string;
  context?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  /** 单选答案（兼容旧客户端） */
  answeredKey?: string;
  /** 多选答案（v1.1） */
  answeredKeys?: string[];
  /** 自由输入（v1.1） */
  custom?: string;
}

export interface TierLineBlock {
  kind: "tierline";
  id: string;
  at: number;
  from: Tier;
  to: Tier;
  reason: string;
}

export interface StatsBlock {
  kind: "stats";
  id: string;
  at: number;
  durationMs: number;
  usage: Usage;
  toolCalls: number;
  iterations: number;
  tier: Tier;
}

export interface BannerBlock {
  kind: "banner";
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface ErrorBlock {
  kind: "error";
  id: string;
  at: number;
  code: string;
  message: string;
  retryable: boolean;
}

export type TranscriptBlock =
  | TurnBlock
  | UserBlock
  | AssistantBlock
  | ReasoningBlock
  | ToolBlock
  | ApprovalBlock
  | QuestionBlock
  | TierLineBlock
  | StatsBlock
  | BannerBlock
  | ErrorBlock;

/** 命令结果块（v1.1 wire 形状；core 领域侧对应 CommandBlock） */
export type ViewBlock =
  | { kind: "text"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "kv"; items: { k: string; v: string }[] }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "diff"; file: string; diff: FileDiff }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

/* ------------------------------------------------------------------ */
/* 会话事件（hub → 前端，经 seq 排序；增量）                           */
/* ------------------------------------------------------------------ */

export interface TurnStartEvent {
  type: "turn.start";
  turnId: string;
  blockId: string;
  n: number;
  at: number;
  /** 本轮用户输入；多标签页订阅时由 hub 统一下发，发送方按 clientId 去重 */
  userText?: string;
  clientId?: string;
  refs?: { icon: string; label: string }[];
  /** 轮次来源（v1.1） */
  source?: "user" | "mailbox";
  /** 开轮前 messages 长度（v1.1，恢复对账用） */
  msgCount?: number;
}

export interface AssistantStartEvent {
  type: "assistant.start";
  blockId: string;
  at: number;
  tier: Tier;
}

export interface AssistantDeltaEvent {
  type: "assistant.delta";
  blockId: string;
  /** 追加到当前段的纯文本 */
  text: string;
}

export interface AssistantEndEvent {
  type: "assistant.end";
  blockId: string;
  /** 权威全文（v1.1）；有则覆盖 delta 累积 */
  text?: string;
}

export interface ReasoningStartEvent {
  type: "reasoning.start";
  blockId: string;
  at: number;
}

export interface ReasoningDeltaEvent {
  type: "reasoning.delta";
  blockId: string;
  text: string;
}

export interface ReasoningEndEvent {
  type: "reasoning.end";
  blockId: string;
  durationMs: number;
  tokens: number;
  /** 权威全文（v1.1） */
  text?: string;
}

export interface ToolStartEvent {
  type: "tool.start";
  blockId: string;
  at: number;
  name: string;
  /** v1.1 可选；缺省由客户端按 name 映射 */
  icon?: string;
  arg: string;
  toolCallId?: string;
}

export interface ToolEndEvent {
  type: "tool.end";
  blockId: string;
  state: ToolState;
  output: string;
  durationMs: number;
  truncated?: boolean;
  foot?: string;
  /** 不透明输出引用（v1.1）；不是文件路径 */
  outputRef?: string;
}

export interface ApprovalRequestEvent {
  type: "approval.request";
  blockId: string;
  at: number;
  tool: string;
  toolCallId?: string;
  path?: string;
  detail?: string;
  diff?: FileDiff | null;
  deadlineAt?: number;
  /** 子代理发起的请求（v1.1） */
  subagent?: { label: string; parentToolCallId?: string };
}

export interface ApprovalResolveEvent {
  type: "approval.resolve";
  blockId: string;
  state: ApprovalState;
  by?: "user" | "timeout" | "no_client" | "crash" | "shutdown" | "abort";
}

export interface QuestionRequestEvent {
  type: "question.request";
  blockId: string;
  at: number;
  prompt: string;
  header?: string;
  context?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  deadlineAt?: number;
  subagent?: { label: string; parentToolCallId?: string };
}

export interface QuestionResolveEvent {
  type: "question.resolve";
  blockId: string;
  /** 事件时间（v1.1 必填，保证 reducer 确定性） */
  at: number;
  /** 单选答案（兼容旧客户端） */
  key?: string;
  /** 多选答案（v1.1） */
  keys?: string[];
  /** 自由输入（v1.1） */
  custom?: string;
  /** 选项文案；hub 下发后所有订阅者都能看到“谁选了什么” */
  answerLabel?: string;
  by?: "user" | "timeout" | "no_client" | "crash" | "shutdown" | "abort";
}

export interface TierSwitchEvent {
  type: "tier.switch";
  from: Tier;
  to: Tier;
  reason: string;
  at: number;
}

export interface StatsEvent {
  type: "stats";
  blockId: string;
  at: number;
  durationMs: number;
  usage: Usage;
  /** 会话累计用量（v1.1） */
  cumulativeUsage?: Usage;
  toolCalls: number;
  iterations: number;
  tier: Tier;
  turnId?: string;
  contextUsage?: number;
  finishReason?: string | null;
  error?: { code: string; message: string } | null;
  emptyResponse?: boolean;
  provider?: string;
  model?: string;
}

export interface BannerEvent {
  type: "banner";
  blockId: string;
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface SessionMetaEvent {
  type: "session.meta";
  meta: SessionMeta;
}

export interface SessionStatusEvent {
  type: "session.status";
  status: SessionStatus;
}

export interface ContextEvent {
  type: "context";
  context: ContextState;
}

export interface PeerUpdateEvent {
  type: "peer.update";
  peers: { name: string; status: SessionStatus; activity: string; age: string }[];
}

export interface HubErrorEvent {
  type: "error";
  /** v1.1 必填（确定性 reducer / 块定位） */
  blockId: string;
  at: number;
  code: HubErrorCode;
  message: string;
  retryable: boolean;
}

export interface AuthExpiredEvent {
  type: "auth.expired";
}

/** 轮次被中断（v1.1）：与 stats 二选一作为终态 */
export interface TurnAbortedEvent {
  type: "turn.aborted";
  turnId: string;
  blockId?: string;
  at: number;
  reason: "user" | "crash" | "shutdown";
}

export interface CompactStartEvent {
  type: "compact.start";
  blockId: string;
  at: number;
  beforeTokens?: number;
}

export interface CompactEndEvent {
  type: "compact.end";
  blockId: string;
  at: number;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface CommandProgressEvent {
  type: "command.progress";
  blockId?: string;
  name: string;
  text: string;
  pct?: number;
}

export interface CommandResultEvent {
  type: "command.result";
  blockId: string;
  name: string;
  ok: boolean;
  blocks?: ViewBlock[];
  changes?: CommandChanges;
  error?: { code: string; message: string };
}

export interface CommandChanges {
  tier?: Tier;
  mode?: PermissionMode;
  provider?: string;
  model?: string;
  title?: string;
}

export interface SessionClearedEvent {
  type: "session.cleared";
  at: number;
}

export interface ActivityEvent {
  type: "activity";
  phase: "llm" | "tool" | "approval" | "compact";
  since: number;
}

export interface NoticeEvent {
  type: "notice";
  level: "info" | "warn" | "error";
  text: string;
}

export type SessionEvent =
  | TurnStartEvent
  | AssistantStartEvent
  | AssistantDeltaEvent
  | AssistantEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | ApprovalRequestEvent
  | ApprovalResolveEvent
  | QuestionRequestEvent
  | QuestionResolveEvent
  | TierSwitchEvent
  | StatsEvent
  | BannerEvent
  | SessionMetaEvent
  | SessionStatusEvent
  | ContextEvent
  | PeerUpdateEvent
  | HubErrorEvent
  | AuthExpiredEvent
  | TurnAbortedEvent
  | CompactStartEvent
  | CompactEndEvent
  | CommandProgressEvent
  | CommandResultEvent
  | SessionClearedEvent
  | ActivityEvent
  | NoticeEvent;

/* ------------------------------------------------------------------ */
/* 命令（前端 → hub）                                                  */
/* ------------------------------------------------------------------ */

export interface LoginCommand {
  type: "auth.login";
  email: string;
  password: string;
}

export interface LogoutCommand {
  type: "auth.logout";
}

export interface WhoamiCommand {
  type: "auth.whoami";
}

export interface SessionListCommand {
  type: "session.list";
}

export interface SessionCreateCommand {
  type: "session.create";
  title?: string;
  /** v0.0.2 Hub：新会话工作目录 */
  cwd?: string;
}

export interface SessionAttachCommand {
  type: "session.attach";
  sessionId?: string;
  /** 已收到的最大 seq；缺省表示要完整快照 */
  lastSeq?: number;
  /** v0.0.2：transcript 世代 */
  epoch?: string;
}

export interface SessionDetachCommand {
  type: "session.detach";
  sessionId?: string;
}

export interface SessionRenameCommand {
  type: "session.rename";
  sessionId?: string;
  title: string;
}

export interface SessionCloseCommand {
  type: "session.close";
  sessionId?: string;
}

export interface ImageAttachmentInput {
  kind: "image";
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** base64（不含 data: 前缀） */
  dataBase64: string;
}

export interface TurnSendCommand {
  type: "turn.send";
  sessionId?: string;
  text: string;
  /** 幂等键；重连后 hub 用它识别重复投递 */
  clientId: string;
  refs?: { icon: string; label: string }[];
  /** v0.0.2 图片附件；≤5 张 / 单张 ≤5MB / png|jpeg|webp */
  attachments?: ImageAttachmentInput[];
}

export interface TurnAbortCommand {
  type: "turn.abort";
  sessionId?: string;
  /** 目标轮；过期/不匹配 → 幂等 no-op（v1.1） */
  turnId?: string;
}

export interface ApprovalResolveCommand {
  type: "approval.resolve";
  sessionId?: string;
  blockId: string;
  decision: "allow" | "deny" | "allow-session";
}

export interface QuestionAnswerCommand {
  type: "question.answer";
  sessionId?: string;
  blockId: string;
  /** 单选答案（兼容旧客户端） */
  key?: string;
  /** 多选答案（v1.1） */
  keys?: string[];
  /** 自由输入（v1.1） */
  custom?: string;
}

export interface CommandRunCommand {
  type: "command.run";
  sessionId?: string;
  name: string;
  args: string[];
}

export interface SettingsGetCommand {
  type: "settings.get";
}

export interface SettingsPatchCommand {
  type: "settings.patch";
  patch: SettingsPatch;
}

export interface UsageSummaryCommand {
  type: "usage.summary";
  range: "session" | "day" | "month";
  sessionId?: string;
}

export interface PingCommand {
  type: "ping";
}

export interface ModeSetCommand {
  type: "mode.set";
  sessionId?: string;
  mode: PermissionMode;
}

export interface TranscriptFetchCommand {
  type: "transcript.fetch";
  sessionId?: string;
  fromSeq?: number;
  limit?: number;
}

export type ClientCommand =
  | LoginCommand
  | LogoutCommand
  | WhoamiCommand
  | SessionListCommand
  | SessionCreateCommand
  | SessionAttachCommand
  | SessionDetachCommand
  | SessionRenameCommand
  | SessionCloseCommand
  | TurnSendCommand
  | TurnAbortCommand
  | ApprovalResolveCommand
  | QuestionAnswerCommand
  | CommandRunCommand
  | SettingsGetCommand
  | SettingsPatchCommand
  | ModeSetCommand
  | TranscriptFetchCommand
  | UsageSummaryCommand
  | PingCommand;

/* ------------------------------------------------------------------ */
/* 设置（与 neo/settings.example.json 同构；前端只见掩码）             */
/* ------------------------------------------------------------------ */

export interface ProviderView {
  providerName: string;
  providerType: "openai" | "anthropic";
  baseUrl: string;
  /** 只到掩码，永不含明文 */
  apiKeyMask: string;
  defaultModelName: string;
  deepReasoningModelName: string;
  balancedModelName: string;
  fastModelName: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
  isDefault: boolean;
}

export interface RouteView {
  tier: Tier;
  provider: string;
  model: string;
  fallbackAllowed: boolean;
}

export interface SettingsView {
  defaultProvider: string;
  defaultTier: Tier;
  classifierProvider: string;
  classifierModelName: string;
  providers: ProviderView[];
  routes: RouteView[];
  compactThreshold: number;
  maxToolIterations: number;
  toolOutputLimit: number;
  shell: { path: string | null; login: boolean; args: string[] | null };
  retry: { maxAttempts: number; connectTimeoutMs: number; streamIdleTimeoutMs: number };
  showReasoning: boolean;
  toolcallInfoDetails: boolean;
  memory: {
    enabled: boolean;
    autoRecall: boolean;
    autoCapture: boolean;
    journalRetentionDays: number;
    userWikiDir: string;
  };
  env: { enabled: boolean; probeTtlHours: number; prompt: boolean; wikiPage: boolean };
  team: {
    skillsExtraPaths: string[];
    crossSessionInbound: "auto" | "hold" | "off";
    crossSessionAutoTurnLimit: number;
    crossSessionHeartbeatMs: number;
    crossSessionDeadAfterMs: number;
    crossSessionProgressTimeoutMs: number;
    crossSessionWatchdogIntervalS: number;
  };
}

export interface SettingsPatch {
  defaultProvider?: string;
  defaultTier?: Tier;
  classifierProvider?: string;
  classifierModelName?: string;
  compactThreshold?: number;
  maxToolIterations?: number;
  toolOutputLimit?: number;
  showReasoning?: boolean;
  toolcallInfoDetails?: boolean;
  memory?: Partial<SettingsView["memory"]>;
  env?: Partial<SettingsView["env"]>;
  team?: Partial<SettingsView["team"]>;
  retry?: Partial<SettingsView["retry"]>;
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export type HubErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "timeout"
  | "approval_expired"
  | "question_expired"
  | "session_gone"
  | "slow_consumer"
  | "unsupported"
  | "too_large"
  | "protocol"
  | "internal";

export interface HubError {
  code: HubErrorCode;
  message: string;
  retryable: boolean;
}

/* ------------------------------------------------------------------ */
/* 快照与信封                                                          */
/* ------------------------------------------------------------------ */

export interface SessionSnapshot {
  meta: SessionMeta;
  /** 最高 durable seq（v1.1） */
  seq: number;
  /** transcript 世代（v1.1） */
  epoch: string;
  blocks: TranscriptBlock[];
  context: ContextState;
  lastTurn?: StatsBlock;
  pendingApprovalId?: string;
  pendingQuestionId?: string;
  /** 进行中轮的 partial 状态；blocks 已含对应 partial 块（v1.1） */
  live?: {
    turnId: string;
    assistant?: { blockId: string; text: string };
    reasoning?: { blockId: string; text: string };
    tool?: { blockId: string; name: string; startedAt: number };
    activity?: { phase: string; since: number };
  };
}

export type ServerMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "ready";
      user: User;
      coreVersion?: string;
      protocolVersion?: string;
      capabilities?: string[];
      sessionId?: string;
      epoch?: string;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "result";
      id: string;
      ok: true;
      data: unknown;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "result";
      id: string;
      ok: false;
      error: HubError;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "event";
      sessionId: string;
      seq: number;
      event: SessionEvent;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "snapshot";
      sessionId: string;
      seq: number;
      snapshot: SessionSnapshot;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "sessions";
      sessions: SessionMeta[];
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "settings";
      settings: SettingsView;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: "usage";
      range: "session" | "day" | "month";
      records: UsageRecord[];
      totals: Usage;
    }
  | { v: typeof PROTOCOL_VERSION; kind: "pong" };

export type ClientMessage = {
  v: typeof PROTOCOL_VERSION;
  kind: "command";
  id: string;
  command: ClientCommand;
};

/* ------------------------------------------------------------------ */
/* 客户端状态（由 reducer 维护；不是协议的一部分，但类型放这里共用）     */
/* ------------------------------------------------------------------ */

export interface SessionState {
  meta: SessionMeta;
  seq: number;
  blocks: TranscriptBlock[];
  context: ContextState;
  pendingApprovalId?: string;
  pendingQuestionId?: string;
  streaming: {
    assistantBlockId?: string;
    reasoningBlockId?: string;
    turnActive: boolean;
  };
  lastTurn?: StatsBlock;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "attaching"
  | "live"
  | "reconnecting"
  | "error";
