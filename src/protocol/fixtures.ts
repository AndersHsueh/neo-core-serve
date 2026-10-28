/**
 * protocol/fixtures.ts — 契约样本。
 *
 * 用途：
 * 1. guards 的单测（每条样本必须被接受，坏样本必须被拒）；
 * 2. reducer 的单测（给定事件序列 → 期望的块结构）；
 * 3. 将来真 hub 接上时，同一批 fixture 直接复用，避免“dummy 能跑、真的不能跑”。
 */

import type {
  FileDiff,
  ServerMessage,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SettingsView,
  Usage,
} from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";

export const FIXTURE_DIFF: FileDiff = {
  file: "src/input/commands.ts",
  add: 3,
  del: 0,
  hunks: [
    {
      header: "@@ -12,4 +12,7 @@ export interface CommandEntry {",
      lines: [
        { t: "ctx", ln: 12, code: "  name: string;" },
        { t: "ctx", ln: 13, code: "  description: string;" },
        { t: "ctx", ln: 14, code: "}" },
        { t: "add", ln: 15, code: "export const TIER_ALIAS = new Map<string, string>([" },
        { t: "add", ln: 16, code: '  ["deep", "deep_reasoning"],' },
        { t: "add", ln: 17, code: "]);" },
      ],
    },
  ],
};

export const FIXTURE_USAGE: Usage = {
  promptTokens: 12400,
  completionTokens: 1800,
  reasoningTokens: 640,
  costMicros: 11000,
};

export const FIXTURE_META: SessionMeta = {
  id: "c-0704",
  title: "commands 漂移守卫告警",
  ownerId: "u-neo",
  status: "working",
  tier: "balanced",
  provider: "ipsa",
  model: "glm-5.3-flash",
  cwd: "/Users/neo/work/neo",
  createdAt: 1_793_100_000_000,
  updatedAt: 1_793_100_120_000,
  unread: 0,
  mode: "ask",
};

/** 覆盖每一种事件的样本：guard 测试逐条过 */
export const EVENT_FIXTURES: SessionEvent[] = [
  {
    type: "turn.start",
    turnId: "t-3",
    blockId: "b-turn-3",
    n: 3,
    at: 1_793_100_120_000,
    userText: "先定位",
    clientId: "cl-1",
  },
  { type: "assistant.start", blockId: "b-a-1", at: 1_793_100_121_000, tier: "balanced" },
  { type: "assistant.delta", blockId: "b-a-1", text: "漂移是单向的。" },
  { type: "assistant.end", blockId: "b-a-1" },
  { type: "reasoning.start", blockId: "b-r-1", at: 1_793_100_121_500 },
  { type: "reasoning.delta", blockId: "b-r-1", text: "先确认漂移方向。" },
  { type: "reasoning.end", blockId: "b-r-1", durationMs: 1100, tokens: 196 },
  {
    type: "tool.start",
    blockId: "b-t-1",
    at: 1_793_100_122_000,
    name: "shell",
    icon: "terminal",
    arg: "bun test",
  },
  { type: "tool.end", blockId: "b-t-1", state: "error", output: "1 fail", durationMs: 1900 },
  {
    type: "approval.request",
    blockId: "b-ap-1",
    at: 1_793_100_123_000,
    tool: "edit_file",
    path: "src/input/commands.ts",
    diff: FIXTURE_DIFF,
    deadlineAt: 1_793_100_243_000,
  },
  { type: "approval.resolve", blockId: "b-ap-1", state: "allowed" },
  {
    type: "question.request",
    blockId: "b-q-1",
    at: 1_793_100_124_000,
    prompt: "用哪条路修？",
    options: [{ key: "1", label: "入口归一化" }],
  },
  { type: "question.resolve", blockId: "b-q-1", at: 1_793_100_124_500, key: "1" },
  {
    type: "tier.switch",
    from: "balanced",
    to: "deep_reasoning",
    reason: "跨文件语义修改",
    at: 1_793_100_125_000,
  },
  {
    type: "stats",
    blockId: "b-s-1",
    at: 1_793_100_126_000,
    durationMs: 8400,
    usage: FIXTURE_USAGE,
    toolCalls: 5,
    iterations: 4,
    tier: "deep_reasoning",
  },
  { type: "banner", blockId: "b-b-1", at: 1_793_100_127_000, level: "warn", text: "这一轮已停滞" },
  { type: "session.meta", meta: FIXTURE_META },
  { type: "session.status", status: "idle" },
  { type: "context", context: { used: 108_000, limit: 512_000, compactAt: 0.75 } },
  {
    type: "peer.update",
    peers: [{ name: "tom", status: "working", activity: "PD-1", age: "12s" }],
  },
  { type: "error", blockId: "b-e-1", at: 1_793_100_128_000, code: "internal", message: "boom", retryable: true },
  { type: "auth.expired" },
  { type: "turn.aborted", turnId: "t-4", blockId: "b-turn-4", at: 1_793_100_129_000, reason: "user" },
  { type: "compact.start", blockId: "b-c-1", at: 1_793_100_130_000, beforeTokens: 400_000 },
  { type: "compact.end", blockId: "b-c-1", at: 1_793_100_131_000, afterTokens: 120_000 },
  { type: "session.cleared", at: 1_793_100_132_000 },
  {
    type: "command.result",
    blockId: "b-cmd-1",
    name: "tier",
    ok: true,
    blocks: [{ kind: "text", text: "tier: deep_reasoning" }],
    changes: { tier: "deep_reasoning" },
  },
  { type: "activity", phase: "llm", since: 1_793_100_133_000 },
  { type: "notice", level: "info", text: "已连接" },
];

export const SNAPSHOT_FIXTURE: SessionSnapshot = {
  meta: FIXTURE_META,
  seq: 7,
  epoch: "ep-0704",
  blocks: [
    { kind: "turn", id: "b-turn-2", at: 1_793_100_000_000, n: 2 },
    { kind: "user", id: "b-u-1", at: 1_793_100_000_500, text: "先定位，别急着改。" },
    {
      kind: "assistant",
      id: "b-a-1",
      at: 1_793_100_001_000,
      tier: "balanced",
      segments: [{ type: "p", text: "漂移是单向的。" }],
    },
  ],
  context: { used: 92_000, limit: 512_000, compactAt: 0.75 },
  pendingApprovalId: undefined,
};

export const SETTINGS_FIXTURE: SettingsView = {
  defaultProvider: "ipsa",
  defaultTier: "balanced",
  classifierProvider: "ipsa",
  classifierModelName: "glm-5.3-flash",
  providers: [
    {
      providerName: "ipsa",
      providerType: "openai",
      baseUrl: "https://ipsapro.isoftstone.com/thor/v1",
      apiKeyMask: "sk-···7f2a",
      defaultModelName: "deepseek-flash",
      deepReasoningModelName: "glm-5.3-flash",
      balancedModelName: "deepseek-flash",
      fastModelName: "deepseek-flash",
      maxTokens: 16384,
      temperature: 0.6,
      contextWindow: 512000,
      isDefault: true,
    },
  ],
  routes: [
    { tier: "deep_reasoning", provider: "ipsa", model: "glm-5.3-flash", fallbackAllowed: true },
    { tier: "balanced", provider: "ipsa", model: "glm-5.3-flash", fallbackAllowed: false },
    { tier: "fast", provider: "ipsa", model: "deepseek-flash", fallbackAllowed: false },
    { tier: "default", provider: "ipsa", model: "glm-5.3-flash", fallbackAllowed: false },
  ],
  compactThreshold: 0.75,
  maxToolIterations: 80,
  toolOutputLimit: 30000,
  shell: { path: null, login: true, args: null },
  retry: { maxAttempts: 3, connectTimeoutMs: 30000, streamIdleTimeoutMs: 120000 },
  showReasoning: true,
  toolcallInfoDetails: false,
  memory: {
    enabled: true,
    autoRecall: true,
    autoCapture: true,
    journalRetentionDays: 7,
    userWikiDir: "~/.neo/wiki",
  },
  env: { enabled: true, probeTtlHours: 12, prompt: true, wikiPage: true },
  team: {
    skillsExtraPaths: [],
    crossSessionInbound: "auto",
    crossSessionAutoTurnLimit: 20,
    crossSessionHeartbeatMs: 15000,
    crossSessionDeadAfterMs: 120000,
    crossSessionProgressTimeoutMs: 300000,
    crossSessionWatchdogIntervalS: 120,
  },
};

/** 每条事件都包成合法信封，供 guards 测试 */
export const ENVELOPE_FIXTURES: ServerMessage[] = [
  {
    v: PROTOCOL_VERSION,
    kind: "ready",
    user: { id: "u-neo", email: "neo@local", displayName: "Neo", role: "owner" },
  },
  ...EVENT_FIXTURES.map((event, i) => ({
    v: PROTOCOL_VERSION,
    kind: "event" as const,
    sessionId: "c-0704",
    seq: i + 1,
    event,
  })),
  {
    v: PROTOCOL_VERSION,
    kind: "snapshot",
    sessionId: "c-0704",
    seq: 7,
    snapshot: SNAPSHOT_FIXTURE,
  },
  { v: PROTOCOL_VERSION, kind: "sessions", sessions: [FIXTURE_META] },
  { v: PROTOCOL_VERSION, kind: "settings", settings: SETTINGS_FIXTURE },
  {
    v: PROTOCOL_VERSION,
    kind: "usage",
    range: "session",
    records: [
      {
        id: "ur-1",
        userId: "u-neo",
        sessionId: "c-0704",
        turnId: "t-3",
        provider: "ipsa",
        model: "glm-5.3-flash",
        tier: "balanced",
        at: 1_793_100_126_000,
        ...FIXTURE_USAGE,
      },
    ],
    totals: FIXTURE_USAGE,
  },
  { v: PROTOCOL_VERSION, kind: "result", id: "r-1", ok: true, data: { ok: true } },
  {
    v: PROTOCOL_VERSION,
    kind: "result",
    id: "r-2",
    ok: false,
    error: { code: "not_found", message: "no", retryable: false },
  },
  { v: PROTOCOL_VERSION, kind: "pong" },
];

/** 明显坏的样本：guards 必须拒绝 */
export const INVALID_FIXTURES: unknown[] = [
  null,
  {},
  { v: 2, kind: "ready", user: {} },
  { v: 1, kind: "event", sessionId: "s", event: { type: "turn.start" } },
  { v: 1, kind: "event", seq: 1, event: { type: "turn.start", blockId: "b", at: 1 } },
  { v: 1, kind: "result", id: "r", ok: "yes" },
  { v: 1, kind: "mystery" },
];
