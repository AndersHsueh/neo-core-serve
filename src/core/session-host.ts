/**
 * core/session-host.ts — 单会话运行时组合根（v0.0.1）。
 *
 * 职责（对应 docs/v0.0.1-brief.md §3）：
 *  1. 装配：config/env/memory/mailbox/session/classifier/agent/tools；
 *  2. seq/epoch：durable 事件单调递增并写 transcript；ephemeral 用当前 seq；
 *  3. 持久化：`~/.neo/sessions/<id>.json`（messages，轮末原子写）+
 *     `transcripts/<id>.ndjson`（durable 事件逐行，首行 header{epoch}）；
 *  4. 恢复：`resume` 加载 messages + transcript，对账崩溃半轮（补 turn.aborted{crash}）；
 *  5. 审批/提问：pending map + blockId + 超时（默认 120s/300s，env 可注入）；
 *  6. 命令子集：help/clear/compact/context/cost/tier/fast/balanced/deep/default/
 *     mode/tools/history/why/auto/provider/model/rename；其余 ok:false。
 *
 * 边界（v0.0.1 的妥协）：
 *  - Agent/Tools 仍依赖 `core/ui/**` 兼容层（v0.0.2 删除）；
 *  - 事件类型从 `../protocol/types.ts` **type-only** 引入；blocks 复用
 *    `../protocol/reducer.ts` 的纯函数（brief §3 明确允许）。运行时不 import serve。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Agent, type AgentEvent, type PermissionMode } from "./agent.ts";
import { ModelFallbackController } from "./modelFallback.ts";
import {
  MODEL_TIERS,
  applyTier,
  describeRoute,
  loadConfig,
  isModelTier,
  maskKey,
  normalizeTierName,
  switchProvider,
  switchTier,
  tierChoiceLabel,
  tierDisplayName,
  type Config,
  type ModelTier,
} from "./config.ts";
import { Classifier } from "./classifier/index.ts";
import {
  findCommand,
  isMutatingCommand,
  unsupportedCommand,
  type CommandContext,
  type CommandResult,
} from "./commands/registry.ts";
import { createMemoryBridge, type MemoryBridge } from "./memory/bridge.ts";
import { CheckpointStore } from "./checkpoint.ts";
import {
  adoptSession,
  applyRestored,
  createSession,
  decodeImageDataUrl,
  loadSession,
  saveSession,
  writeImageAttachment,
  type SessionFile,
  type SessionMeta as NeoSessionMeta,
} from "./session.ts";
import { pathPolicyFor } from "./path.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { formatResumeWarning, outcomeOf, type LastTurnMeta } from "./turnDiagnostics.ts";
import { refreshCapabilitiesAfterModelSwitch, resolveAndApplyModelWindow, recordModelContext } from "./env/modelWindows.ts";
import { writeBackContextLimit, writeBackOutputLimit } from "./env/modelCaps.ts";
import { chatStream, contentText, type Message } from "./llm.ts";
import { registerTool } from "./tools/index.ts";
import { makeTaskTool, runSubagent } from "./tools/task.ts";
import { registerWikiTools } from "./tools/wiki.ts";
import { makeRememberTool } from "./tools/memory.ts";
import { makeAskUserTool } from "./tools/askUser.ts";
import { makeListPeersTool, makeSendMessageTool } from "./tools/mailbox.ts";
import { Mailbox } from "./mailbox/store.ts";
import {
  createIdentity,
  releaseAlive,
  sessionLiveness,
  sweepSessions,
} from "./mailbox/identity.ts";
import * as mailboxState from "./mailbox/state.ts";
import { decideInbound, formatIncomingFrame } from "./mailbox/inbound.ts";
import { mailboxRoot } from "./mailbox/types.ts";
import { ProtocolIO } from "./protocol-io.ts";
import {
  lockDir as lockDirPath,
  sessionPath as sessionPathOf,
  transcriptPath as transcriptPathOf,
} from "./paths.ts";
import { applyEvent, applyEvents } from "../protocol/reducer.ts";

import type {
  AssistantDeltaEvent,
  ContextState,
  ImageAttachmentInput,
  ReasoningDeltaEvent,
  PermissionMode as ProtocolPermissionMode,
  SessionEvent,
  SessionMeta as ProtocolSessionMeta,
  SessionSnapshot,
  SessionState,
  SessionStatus,
  SettingsView,
  Tier,
  TranscriptBlock,
  Usage,
  UsageRecord,
} from "../protocol/types.ts";
import type { CommandOutcome, HostEvent, HostPort, SendRef } from "../serve/types.ts";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** 附件限制（协议 §2.5）：≤5 张、单张解码后 ≤5MB、仅 png/jpeg/webp。 */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** @ref 内联：单文件 / 总字节 / 数量上限（避免一次引用把上下文/transcript 撑爆）。 */
const REF_MAX_CHARS = 200_000;
const REF_TOTAL_BYTES = 200_000;
const REF_MAX_COUNT = 5;
/** 所有附件 base64 之和上限（= 帧上限 8MB）。 */
const MAX_ATTACHMENTS_TOTAL_BASE64 = 8 * 1024 * 1024;
/** 与 protocol/reducer.ts 的 MAX_STREAM_TEXT 对齐（超长流式文本截断，防内存爆炸）。 */
const MAX_STREAM_TEXT = 2_000_000;
/** transcript.fetch 默认/最大条数。 */
const TRANSCRIPT_FETCH_DEFAULT = 200;
const TRANSCRIPT_FETCH_MAX = 1000;
const DEFAULT_QUESTION_TIMEOUT_MS = 300_000;
/** transcript 里的 durable 事件行：{seq, event}。 */
interface TranscriptEntry {
  seq: number;
  event: SessionEvent;
}

type TurnAbortCause = "user" | "shutdown" | "crash";

/** 落盘用的会话 meta（在 neo SessionMeta 上追加本仓需要的字段）。 */
interface PersistedMeta extends NeoSessionMeta {
  mode?: ProtocolPermissionMode;
  tier?: ModelTier;
  provider?: string;
  title?: string;
  lastTurnId?: string;
}

export interface CreateSessionHostOptions {
  /** 工作目录；默认 process.cwd()。 */
  cwd?: string;
  /** 恢复的 session id；null/缺省 = 新会话。 */
  resume?: string | null;
  mode?: ProtocolPermissionMode;
  tier?: string;
  coreVersion?: string;
  approvalTimeoutMs?: number;
  questionTimeoutMs?: number;
  title?: string;
  /** 测试注入：完整 Config（跳过 loadConfig）。 */
  cfg?: Config;
  /** 测试注入：LLM 流函数（跳过真实网络）。 */
  chatStream?: typeof chatStream;
  /** 是否启用记忆（默认沿用 cfg.memory.enabled）。 */
  memory?: boolean;
  /** 是否启用跨会话信箱（默认 true；无信箱时只是少两个工具）。 */
  mailbox?: boolean;
  /** 是否走 Agent 的交互式流式分支（默认 true：才有 begin/endStream 边界）。 */
  streaming?: boolean;
  /** 可注入时钟（测试确定性）。 */
  now?: () => number;
}

/**
 * 单进程单会话：工具注册表是模块级单例（registerTool 重复注册直接抛错）。
 * 用一个进程级 owner 令牌把它变成显式约束，而不是让第二个 host 撞奇怪的错。
 */
let registryOwner: symbol | null = null;
let registryReleases: Array<() => void> | null = null;

export async function createSessionHost(opts: CreateSessionHostOptions = {}): Promise<HostPort> {
  return SessionHost.create(opts);
}

/* ------------------------------------------------------------------ */
/* 路径与时间工具                                                      */
/* ------------------------------------------------------------------ */

function envOf(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function newEpoch(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      (timer as unknown as { unref?: () => void }).unref?.();
      resolve();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function intEnv(name: string, fallback: number): number {
  const raw = envOf(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* ------------------------------------------------------------------ */
/* Agent 事件（仅 onEvent 通道的一小部分；文本/工具走 AgentIO）         */
/* ------------------------------------------------------------------ */

type AgentEventEnvelope = AgentEvent;

/* ------------------------------------------------------------------ */
/* SessionHost                                                         */
/* ------------------------------------------------------------------ */

class SessionHost implements HostPort {
  readonly sessionId: string;
  readonly epoch: string;
  private _seq = 0;
  private closed = false;

  private readonly cfg: Config;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly approvalTimeoutMs: number;
  private readonly questionTimeoutMs: number;
  private readonly persistedPath: string;
  private readonly transcriptPath: string;
  /** --resume 载入的会话文件（ctor 只读一次盘，init 复用）。 */
  private readonly loadedSession: SessionFile | null;

  private readonly createdAtMs: number;
  private title: string;
  private mode: ProtocolPermissionMode;
  private turnCount = 0;
  private lastTurnId: string | null = null;
  /**
   * 最近一次「由轮次产生」的 lastTurn。
   * 非轮次落盘（/rename、/clear、close()）必须把它写回，否则会话 meta 里的
   * resume 告警依据会被一次改名悄悄抹掉（M5）。
   */
  private lastPersistedLastTurn: LastTurnMeta | null = null;
  private idSeq = 0;

  private agent!: Agent;
  private io!: ProtocolIO;
  private classifier!: Classifier;
  private memory: MemoryBridge | null = null;
  private mailbox: Mailbox | null = null;
  private checkpoint: CheckpointStore | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** 单写者锁目录（~/.neo/run/locks/<id>/；close 时释放）。 */
  private lockDir: string | null = null;

  /** 最近的 durable 事件（重放/修复/测试取证用）。 */
  private events: TranscriptEntry[] = [];
  private state!: SessionState;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  /** transcript header 是否已就绪（避免每条 durable 事件都 existsSync）。 */
  private transcriptReady = false;

  /** turn.send 幂等键（协议 §4.2：重复投递返回同一 turnId；保留最近 200）。 */
  private readonly recentClientIds = new Map<string, string>();

  private turn: {
    turnId: string;
    blockId: string;
    n: number;
    abortRequested: boolean;
    /** 中断来源：abort()→user、close()/SIGTERM→shutdown、其它→crash。 */
    cause: TurnAbortCause;
    done: Promise<void> | null;
  } | null = null;

  private readonly usageRecords: UsageRecord[] = [];
  private usageTotals: Usage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
  };

  private constructor(opts: CreateSessionHostOptions, cfg: Config) {
    this.opts = opts;
    this.cfg = cfg;
    this.now = opts.now ?? (() => Date.now());
    this.startedAtMs = this.now();
    this.approvalTimeoutMs =
      opts.approvalTimeoutMs ?? intEnv("MATRIX_CORE_APPROVAL_TIMEOUT_MS", DEFAULT_APPROVAL_TIMEOUT_MS);
    this.questionTimeoutMs =
      opts.questionTimeoutMs ?? intEnv("MATRIX_CORE_QUESTION_TIMEOUT_MS", DEFAULT_QUESTION_TIMEOUT_MS);

    const loaded = opts.resume ? loadSession(opts.resume) : null;
    if (opts.resume && !loaded) {
      throw hostError("not_found", `未找到会话 ${opts.resume}`);
    }
    this.loadedSession = loaded;

    const sess = loaded
      ? adoptSession({ ...loaded.meta, path: sessionPathOf(loaded.meta.id) }, cfg.model)
      : createSession(cfg.model, cfg.cwd);
    this.sessionId = sess.meta.id;
    // 路径从 id 重算（adopt 的 meta.path 可能陈旧/被篡改）。
    this.persistedPath = sessionPathOf(this.sessionId);
    this.transcriptPath = transcriptPathOf(this.sessionId);
    this.createdAtMs = loaded ? Date.parse(loaded.meta.createdAt) || this.now() : this.now();

    const persisted = loaded?.meta as PersistedMeta | undefined;
    this.title = opts.title ?? persisted?.title ?? `会话 ${this.sessionId.slice(-6)}`;
    this.mode = pickMode(opts.mode ?? persisted?.mode);
    if (persisted?.tier && isModelTier(persisted.tier)) {
      const r = applyTier(cfg, persisted.tier);
      if (!r.ok) applyTier(cfg, "default");
    }
    if (opts.tier) {
      const t = normalizeTierName(opts.tier);
      if (t) applyTier(cfg, t);
    }
    this.turnCount = persisted?.turns ?? 0;
    this.lastTurnId = persisted?.lastTurnId ?? null;
    this.lastPersistedLastTurn = persisted?.lastTurn ?? null;

    // transcript：epoch 与 durable 事件从文件恢复（丢失/重建 → 新 epoch）。
    const existing = readTranscript(this.transcriptPath);
    this.epoch = existing.header?.epoch ?? newEpoch();
    this.events = existing.entries;
    this._seq = existing.maxSeq;

    this.state = {
      meta: this.metaSnapshot(),
      seq: this._seq,
      blocks: [],
      context: this.contextState(),
      streaming: { turnActive: false },
    };
    // delta 是 ephemeral（不写 transcript），重放时必须先把 end.text / end.text(reasoning)
    // 还原成 delta 再喂 reducer，否则恢复后的 assistant/reasoning 块会没有正文。
    this.state = applyEvents(this.state, expandReplayEvents(this.events));
    // epoch 在会话打开时就写入 transcript 头（即使一轮都没跑）：这样 resume 到
    // 「只有 messages、没有 durable 事件」的会话也能保持同一 epoch（协议 §3）。
    this.ensureTranscriptHeader();
  }

  private opts: CreateSessionHostOptions;

  /* ------------------------------------------------------------------ */
  /* 创建：装配                                                          */
  /* ------------------------------------------------------------------ */

  static async create(opts: CreateSessionHostOptions): Promise<SessionHost> {
    const cwd = opts.cwd ?? process.cwd();
    const cfg = opts.cfg ?? loadConfig({ cwd });
    cfg.cwd = cwd;
    try {
      resolveAndApplyModelWindow(cfg);
    } catch {
      // 窗口事实是增强项：解析失败沿用配置值
    }
    const host = new SessionHost(opts, cfg);
    await host.init();
    return host;
  }

  private async init(): Promise<void> {
    if (registryOwner !== null) {
      throw hostError(
        "conflict",
        "单进程只允许一个 SessionHost（工具注册表为模块级单例）：请先 close() 现有 host",
      );
    }
    // ---- 单写者（D15）：与 mailbox `.alive` 互认 + 自己的 run/locks 独占 ----
    if (this.opts.mailbox !== false) {
      let live: string = "dead";
      try {
        live = sessionLiveness(mailboxRoot(), this.sessionId);
      } catch {
        live = "dead";
      }
      if (live === "running") {
        throw hostError(
          "conflict",
          `会话 ${this.sessionId} 已在另一个进程中运行（mailbox .alive 存活）`,
        );
      }
    }
    this.lockDir = acquireSessionLock(this.sessionId, this.epoch, () => this.now());

    registryOwner = Symbol("session-host");
    const releases: Array<() => void> = [];
    registryReleases = releases;

    try {
      // 记忆桥：cfg.memory.enabled 为 false 时内部全部 no-op（与 neo 一致）。
      try {
        this.memory = createMemoryBridge({
          cfg: this.cfg,
          cwd: this.cfg.cwd,
          sessionId: this.sessionId,
          mode: "interactive",
          captureEnabled: this.mode !== "plan",
          ...(this.cfg.retry ? { streamFn: this.opts.chatStream } : {}),
          onNotice: (m) => this.io?.info(m),
        });
      } catch {
        this.memory = null;
      }

      // 跨会话信箱（可选增强项）：失败只降级，不阻塞启动。
      if (this.opts.mailbox !== false) {
        try {
          this.mailbox = new Mailbox({ sessionId: this.sessionId, config: this.cfg.mailbox });
          createIdentity({
            root: this.mailbox.root,
            sessionId: this.sessionId,
            cwd: this.cfg.cwd,
            mode: this.mode,
            deadAfterMs: this.cfg.mailbox.deadAfterMs,
          });
          sweepSessions(this.mailbox.root, { ttlMs: this.cfg.mailbox.sessionTtlMs });
          const mb = this.mailbox;
          this.heartbeat = setInterval(() => {
            try {
              mailboxState.touchHeartbeat(mb.root, mb.sessionId);
            } catch {
              // 心跳失败不阻塞主流程
            }
          }, this.cfg.mailbox.heartbeatMs);
          (this.heartbeat as unknown as { unref?: () => void }).unref?.();
        } catch {
          this.mailbox = null;
        }
      }

      // 事件/IO：host 负责 seq/persist，ProtocolIO 负责 AgentIO 语义。
      this.io = new ProtocolIO({
        emit: (event, durable) => this.emit(event, durable),
        now: () => this.now(),
        newId: (prefix) => this.newId(prefix),
        getTier: () => this.cfg.modelTier as Tier,
        approvalTimeoutMs: this.approvalTimeoutMs,
        questionTimeoutMs: this.questionTimeoutMs,
      });

      this.classifier = new Classifier(this.cfg, "rule");
      this.checkpoint = new CheckpointStore({ cwd: this.cfg.cwd, sessionId: this.sessionId });

      // 工具注册（必须在 buildSystemPrompt 之前：可用工具行由 toolNames() 现取）。
      releases.push(
        registerTool(
          makeTaskTool({ run: (prompt, tier, ctx) => runSubagent(this.agent, prompt, tier, ctx) }),
        ),
      );
      releases.push(registerWikiTools(registerTool));
      if (this.memory) {
        const mem = this.memory;
        releases.push(registerTool(makeRememberTool({ remember: (b, s) => mem.remember(b, s) })));
      }
      releases.push(
        registerTool(
          makeAskUserTool({
            ask: (req) => this.io.askUser(req),
          }),
        ),
      );
      if (this.mailbox) {
        const mb = this.mailbox;
        releases.push(registerTool(makeSendMessageTool({ mailbox: mb })));
        releases.push(registerTool(makeListPeersTool({ mailbox: mb })));
      }

      const systemPrompt = this.buildSystemPrompt();
      // K07：只给主请求注入备用链；compact/classifier/memory 仍走 chatStream。
      // 不新增 Matrix 事件，切换提示走 IO，避免改 protocol.lock。
      const fallbackController =
        this.cfg.modelFallback.length > 0
          ? new ModelFallbackController({
              cfg: this.cfg,
              fallbacks: this.cfg.modelFallback,
              stream: this.opts.chatStream ?? chatStream,
              onNotice: (m) => this.io.info(m),
            })
          : null;
      this.agent = new Agent({
        cfg: this.cfg,
        console: this.io,
        mode: this.mode,
        systemPrompt,
        // Agent 的交互式分支才有 beginStream/endStream 这对干净边界；
        // 文本仍走 onEvent（原始 chunk），IO 的写通道是 no-op（见 protocol-io 文件头）。
        streaming: this.opts.streaming ?? true,
        onEvent: (e) => this.handleAgentEvent(e),
        classifier: this.classifier,
        ...(this.memory ? { memory: this.memory } : {}),
        ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
        sessionId: this.sessionId,
        ...(this.opts.chatStream ? { chatStream: this.opts.chatStream } : {}),
        ...(fallbackController
          ? {
              mainChatStream: (
                c: Parameters<typeof chatStream>[0],
                m: Parameters<typeof chatStream>[1],
                tools: Parameters<typeof chatStream>[2],
                h?: Parameters<typeof chatStream>[3],
                s?: Parameters<typeof chatStream>[4],
              ) => fallbackController.stream(c, m, tools, h, s),
              isFallbackActive: () => fallbackController.isActive,
            }
          : {}),
        askUser: (req) => this.io.askUser(req),
        refreshContextWindow: () => {
          try {
            // 经宿主端口注入：同步换窗 + 异步补 /models 事实，不在 Agent 循环里 import 探测模块。
            refreshCapabilitiesAfterModelSwitch(this.cfg);
          } catch {
            // 增强项
          }
        },
        onContextLimit: (tokens) => {
          try {
            recordModelContext(this.cfg, {
              contextWindow: tokens,
              source: "overflow_error",
              evidence: "服务端上下文溢出错误",
            });
            writeBackContextLimit(this.cfg, tokens);
          } catch {
            // 持久化失败不影响恢复
          }
        },
        onOutputLimit: () => {
          try {
            void writeBackOutputLimit(this.cfg);
          } catch {
            // 写回是增强项
          }
        },
        pollInbox: this.mailbox ? () => this.pollInbox() : undefined,
        readGoal: this.mailbox ? () => this.readGoal() : undefined,
      });

      // --resume：把 messages 灌回 Agent（system 用本次新建的）。
      const loaded = this.loadedSession;
      if (loaded && loaded.messages.length > 0) {
        this.agent.messages = applyRestored(this.agent.messages[0], loaded.messages);
        const warn = formatResumeWarning(loaded.meta as PersistedMeta);
        if (warn) this.emit({ type: "banner", blockId: this.newId("banner"), at: this.now(), level: "warn", text: warn }, true);
      }

      // 项目记忆文件（AGENTS.md/NEO.md/.neo.md）——与 neo 同规则。
      this.injectProjectMemory();
      // R0：用户画像摘要注入 messages[1]（失败不阻塞）。
      if (this.memory) {
        try {
          const slice = await this.memory.startup();
          if (slice) this.agent.messages.splice(1, 0, slice.message);
        } catch {
          // 记忆是增强项
        }
      }

      this.repairCrashTail();

      // 现有 transcript 事件不足以重建视图（旧会话/被清理）→ 从 messages 有损重建。
      if (this.state.blocks.length === 0 && this.agent.messages.length > 1) {
        this.rebuildBlocksFromMessages(this.agent.messages);
      }
    } catch (e) {
      // 装配失败：释放已注册的工具 + 信箱锁，避免污染进程状态。
      for (const release of releases.reverse()) {
        try {
          release();
        } catch {
          // ignore
        }
      }
      registryOwner = null;
      registryReleases = null;
      this.releaseMailbox();
      this.releaseLock();
      throw e;
    }
  }

  private buildSystemPrompt(): string {
    return buildSystemPrompt(this.cfg, {
      mailbox: this.mailbox !== null,
      askUser: true,
    });
  }

  private injectProjectMemory(): void {
    const candidates = ["AGENTS.md", "NEO.md", ".neo.md"]
      .map((f) => join(this.cfg.cwd, f))
      .find((p) => existsSync(p));
    if (!candidates) return;
    try {
      const extra = readFileSync(candidates, "utf8");
      const sys = this.agent.messages[0];
      if (sys && typeof sys.content === "string") {
        sys.content = `${sys.content}\n\n## 项目记忆（来自 ${candidates}）\n\n${extra}`;
      }
    } catch {
      // 项目记忆读取失败不影响启动
    }
  }

  /* ------------------------------------------------------------------ */
  /* seq / 事件                                                          */
  /* ------------------------------------------------------------------ */

  get seq(): number {
    return this._seq;
  }

  private newId(prefix: string): string {
    this.idSeq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${this.idSeq.toString(36)}${rand}`;
  }

  /**
   * 事件出口。
   *  - durable：seq+1 → 写 transcript → 进 reducer（快照视图）→ 广播；
   *  - ephemeral：不推进计数器，信封 seq = 当前最高 durable seq。
   */
  private emit(event: SessionEvent, durable: boolean): void {
    if (durable) {
      this._seq += 1;
      this.appendTranscript(this._seq, event);
      this.events.push({ seq: this._seq, event });
    }
    // ephemeral 也要进视图：delta 不写 transcript，但快照/live 必须能看见
    // 进行中轮的 partial 正文（协议 §6.3 的 mid-turn attach 要求）。
    if (!durable && (event.type === "assistant.delta" || event.type === "reasoning.delta")) {
      // 快路径：只改目标 block（delta 是最高频事件，不能让每条都 clone 全 blocks）。
      this.applyStreamDelta(event);
    } else {
      this.state = applyEvent(this.state, event);
    }
    const envelope = { ...event, seq: this._seq } as HostEvent;
    for (const cb of [...this.listeners]) {
      try {
        cb(envelope);
      } catch {
        // 单个订阅者异常不得击穿事件流
      }
    }
  }

  /** 确保 transcript 首行 header 存在（写 panic 时重复调用是 no-op）。 */
  private ensureTranscriptHeader(): void {
    try {
      if (existsSync(this.transcriptPath)) {
        this.transcriptReady = true;
        return;
      }
      mkdirSync(dirname(this.transcriptPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.transcriptPath,
        `${JSON.stringify({
          v: 1,
          kind: "header",
          epoch: this.epoch,
          sessionId: this.sessionId,
          createdAt: isoAt(this.now()),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      this.transcriptReady = true;
    } catch {
      // 写失败：首条 durable 事件时会再试
    }
  }

  /**
   * per-delta 快路径（架构 v0.0.2 §2.2）：只改当前 block，不 clone 全 blocks/segments。
   * 语义必须与 protocol/reducer.ts 的 assistant.delta / reasoning.delta 完全一致
   * （含 MAX_STREAM_TEXT 截断），否则快照与 reducer 重放会分叉。
   */
  private applyStreamDelta(event: AssistantDeltaEvent | ReasoningDeltaEvent): void {
    const blocks = this.state.blocks;
    let idx = blocks.length - 1;
    if (idx < 0 || blocks[idx]?.id !== event.blockId) {
      idx = blocks.findIndex((b) => b.id === event.blockId);
    }
    if (idx < 0) return; // block 未出现（异常顺序）：与 reducer 的 no-op 一致
    const block = blocks[idx];
    if (!block) return;

    if (event.type === "assistant.delta") {
      if (block.kind !== "assistant" || event.text === "") return;
      const last = block.segments[block.segments.length - 1];
      if (last && last.type === "p") {
        if (last.text.length + event.text.length > MAX_STREAM_TEXT) return;
        last.text += event.text;
      } else {
        block.segments.push({ type: "p", text: event.text });
      }
      return;
    }

    if (block.kind !== "reasoning" || event.text === "") return;
    block.text = (block.text + event.text).slice(0, MAX_STREAM_TEXT);
  }

  private appendTranscript(seq: number, event: SessionEvent): void {
    try {
      if (!this.transcriptReady) {
        mkdirSync(dirname(this.transcriptPath), { recursive: true, mode: 0o700 });
        this.ensureTranscriptHeader();
      }
      appendFileSync(this.transcriptPath, `${JSON.stringify({ seq, event })}\n`, "utf8");
    } catch (e) {
      // transcript 写失败：事件仍在内存/快照里，但必须可见（架构 P5）。
      warnStorage(`transcript 写入失败（${this.transcriptPath}）：${(e as Error).message}`);
    }
  }

  onEvent(cb: (event: HostEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* ------------------------------------------------------------------ */
  /* meta / snapshot / live / usage / configView                          */
  /* ------------------------------------------------------------------ */

  private status(): SessionStatus {
    if (this.closed) return "idle";
    if (this.turn) return this.io?.hasPending() ? "waiting" : "working";
    return "idle";
  }

  private metaSnapshot(): ProtocolSessionMeta {
    return {
      id: this.sessionId,
      title: this.title,
      ownerId: "local",
      status: this.status(),
      tier: this.cfg.modelTier as Tier,
      provider: this.cfg.providerName,
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      createdAt: this.createdAtMs,
      updatedAt: this.now(),
      unread: 0,
      mode: this.mode,
    };
  }

  meta(): ProtocolSessionMeta {
    return this.metaSnapshot();
  }

  /** `usageRatio` 可由调用方预先算好，避免同一命令里重复估算 token。 */
  private contextState(usageRatio?: number): ContextState {
    let usage = usageRatio ?? 0;
    if (usageRatio === undefined) {
      try {
        usage = this.agent ? this.agent.contextUsage() : 0;
      } catch {
        usage = 0;
      }
    }
    const limit = this.cfg.contextWindow;
    return {
      used: Math.max(0, Math.round(usage * limit)),
      limit,
      compactAt: this.cfg.compactThreshold,
    };
  }

  live(): SessionSnapshot["live"] {
    if (!this.turn) return undefined;
    const streams = this.io?.streamState() ?? {};
    const tool = this.io?.toolState();
    return {
      turnId: this.turn.turnId,
      ...streams,
      ...(tool ? { tool } : {}),
    };
  }

  snapshot(): SessionSnapshot {
    const live = this.live();
    const lastTurn = this.state.lastTurn;
    return {
      meta: this.metaSnapshot(),
      seq: this._seq,
      epoch: this.epoch,
      blocks: this.state.blocks,
      context: this.contextState(),
      ...(lastTurn ? { lastTurn } : {}),
      ...(this.io?.pendingApprovalId() ? { pendingApprovalId: this.io.pendingApprovalId() } : {}),
      ...(this.io?.pendingQuestionId() ? { pendingQuestionId: this.io.pendingQuestionId() } : {}),
      ...(live ? { live } : {}),
    };
  }

  usage(): { records: UsageRecord[]; totals: Usage } {
    return { records: [...this.usageRecords], totals: { ...this.usageTotals } };
  }

  configView(): SettingsView {
    return buildSettingsView(this.cfg);
  }

  /* ------------------------------------------------------------------ */
  /* 轮次                                                                */
  /* ------------------------------------------------------------------ */

  async send(
    text: string,
    refs: SendRef[] | undefined,
    clientId: string,
    attachments?: ImageAttachmentInput[],
  ): Promise<{ turnId: string }> {
    if (this.closed) throw hostError("session_gone", "会话已关闭");
    // 幂等：同一 clientId 的重投递返回同一 turnId（含「本轮仍在跑」的窗口）。
    const seen = clientId ? this.recentClientIds.get(clientId) : undefined;
    if (seen) return { turnId: seen };
    if (this.turn) throw hostError("conflict", "本轮仍在运行；请等 stats/turn.aborted 后再发送");
    if (!text || text.trim() === "") throw hostError("protocol", "text 不能为空");

    // v0.0.2：附件先校验/落盘，失败在开轮前就返回明确错误码（不留下半轮）。
    const images = this.prepareAttachments(attachments);
    // @refs：把引用文件内容内联进用户消息（读路径走 PathPolicy）。
    // 注意：内联正文只进 messages（LLM 上下文），turn.start.userText 仍是原始文本，
    // 否则 transcript 里会重复存一份大段文件内容（simplify：durable 不重复）。
    const userText = this.composeUserText(text, refs);

    const turnId = this.newId("turn");
    const blockId = this.newId("turnblk");
    this.turnCount += 1;
    this.lastTurnId = turnId;
    const n = this.turnCount;
    const at = this.now();
    // msgCount = 开轮前 messages 长度（恢复对账用）。system 也算在内，保持简单可核对。
    const msgCount = this.agent.messages.length;

    // 新轮：清空 IO 的活动相位去重缓存（否则第二轮起不再发 activity）。
    this.io.beginTurn();
    if (clientId) {
      this.recentClientIds.set(clientId, turnId);
      if (this.recentClientIds.size > 200) {
        const oldest = this.recentClientIds.keys().next().value;
        if (oldest !== undefined) this.recentClientIds.delete(oldest);
      }
    }
    this.turn = { turnId, blockId, n, abortRequested: false, cause: "crash", done: null };
    this.emit(
      {
        type: "turn.start",
        turnId,
        blockId,
        n,
        at,
        userText: text,
        clientId,
        ...(refs && refs.length > 0
          ? { refs: refs.map((r) => ({ icon: r.icon, label: r.label })) }
          : {}),
        source: "user",
        msgCount,
      },
      true,
    );

    const done = this.runTurn(turnId, images.length > 0 ? { text: userText, images } : userText).catch((e) => {
      // runTurn 内部已尽量收口；这里只兜底，绝不让 Promise 变成 unhandled。
      this.emit(
        {
          type: "error",
          blockId: this.newId("err"),
          at: this.now(),
          code: "internal",
          message: (e as Error).message,
          retryable: true,
        },
        true,
      );
    });
    if (this.turn) this.turn.done = done;
    return { turnId };
  }

  /* ------------------------------------------------------------------ */
  /* 附件与 @refs（v0.0.2）                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 校验并落盘图片附件，返回给 Agent 的 data URL 列表。
   *
   * 规则（simplify 收口）：
   *  - ≤5 张；单张解码 ≤5MB（too_large）；所有 base64 之和 ≤8MB（帧上限，too_large）；
   *  - base64 必须**严格**：只允许 `[A-Za-z0-9+/=]`、长度 %4==0、可往返编码；
   *  - magic bytes 必须与声明 mime 一致（PNG/JPEG/WebP），否则 protocol；
   *  - 落盘用内容哈希命名（多轮不撞名），返回 data URL 给 Agent。
   */
  private prepareAttachments(attachments?: ImageAttachmentInput[]): string[] {
    if (!attachments || attachments.length === 0) return [];
    if (attachments.length > MAX_ATTACHMENTS) {
      throw hostError("too_large", `附件最多 ${MAX_ATTACHMENTS} 张，收到 ${attachments.length} 张`);
    }
    if (attachments.length > 0) this.assertBase64Budget(attachments);
    const out: string[] = [];
    for (const [i, att] of attachments.entries()) {
      const no = i + 1;
      if (!att || att.kind !== "image") {
        throw hostError("protocol", `附件 #${no} 不是 image（kind=${String(att?.kind)}）`);
      }
      if (!ALLOWED_IMAGE_MIMES.has(att.mime)) {
        throw hostError("protocol", `附件 #${no} 的 mime "${att.mime}" 不支持（只接受 png/jpeg/webp）`);
      }
      const b64 = strictBase64(att.dataBase64, no);
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw hostError(
          "too_large",
          `附件 #${no} 解码后 ${(bytes.length / 1024 / 1024).toFixed(2)}MB，超过单张 5MB 上限`,
        );
      }
      const sniffed = sniffImageMime(bytes);
      if (sniffed !== att.mime) {
        throw hostError(
          "protocol",
          `附件 #${no} 的内容不是 ${att.mime}（magic=${sniffed ?? "unknown"}）`,
        );
      }
      const dataUrl = `data:${att.mime};base64,${b64}`;
      const file = decodeImageDataUrl(dataUrl);
      if (!file) throw hostError("protocol", `附件 #${no} 不是合法的图片 data URL`);
      // 立即落盘：即使本轮失败，附件也不会悬空在内存里。
      writeImageAttachment(this.sessionId, file);
      out.push(dataUrl);
    }
    return out;
  }

  /** 所有附件 base64 之和 ≤8MB（WS/stdio 帧上限）。 */
  private assertBase64Budget(attachments: ImageAttachmentInput[]): void {
    let total = 0;
    for (const [i, att] of attachments.entries()) {
      if (!att || typeof att.dataBase64 !== "string") continue;
      const b64 = att.dataBase64.replace(/\s+/g, "");
      total += b64.length;
      if (total > MAX_ATTACHMENTS_TOTAL_BASE64) {
        throw hostError(
          "too_large",
          `附件总 base64 超过 ${Math.round(MAX_ATTACHMENTS_TOTAL_BASE64 / 1024 / 1024)}MB 上限（第 ${i + 1} 张时越界）`,
        );
      }
    }
  }

  /**
   * 把 @refs 引用的文件内容内联到用户文本。
   *
   * 限额（simplify）：最多内联 `REF_MAX_COUNT` 个带 path 的 ref、总字节 ≤ `REF_TOTAL_BYTES`。
   * 超出的 ref 只留占位说明 + notice，不阻塞本轮。读路径走 PathPolicy。
   */
  private composeUserText(text: string, refs?: SendRef[]): string {
    if (!refs || refs.length === 0) return text;
    const policy = pathPolicyFor(this.cfg);
    const blocks: string[] = [];
    let inlined = 0;
    let budget = REF_TOTAL_BYTES;
    for (const ref of refs) {
      if (!ref?.path) continue; // 只有 label 的 ref（如 url/skill）不内联
      const label = ref.label ?? ref.path;
      if (inlined >= REF_MAX_COUNT) {
        blocks.push(`### ${label}（${ref.path}）\n\n（引用数量超过 ${REF_MAX_COUNT} 个上限，未内联）`);
        continue;
      }
      if (budget <= 0) {
        blocks.push(`### ${label}（${ref.path}）\n\n（引用总量超过 ${REF_TOTAL_BYTES} 字节上限，未内联）`);
        continue;
      }
      try {
        const abs = policy.resolveRead(ref.path);
        const raw = readFileSync(abs, "utf8");
        const take = Math.min(raw.length, REF_MAX_CHARS, budget);
        const clipped =
          take < raw.length
            ? `${raw.slice(0, take)}\n…[引用内容已截断：共 ${raw.length} 字符]`
            : raw;
        budget -= Buffer.byteLength(clipped, "utf8");
        inlined += 1;
        blocks.push(`### ${label}（${ref.path}）\n\n\`\`\`\n${clipped}\n\`\`\``);
      } catch (e) {
        const reason = (e as Error).message;
        blocks.push(`### ${label}（${ref.path}）\n\n（无法读取：${reason}）`);
        this.emit(
          { type: "notice", level: "warn", text: `引用 ${ref.path} 读取失败：${reason}` },
          false,
        );
      }
    }
    if (blocks.length === 0) return text;
    return `${text}\n\n<referenced-files>\n${blocks.join("\n\n")}\n</referenced-files>`;
  }

  /** v0.0.2：durable 事件回放（fromSeq 不含；默认从 1 开始、最多 200 条）。 */
  fetchTranscript(
    fromSeq?: number,
    limit?: number,
  ): { events: Array<{ seq: number; event: SessionEvent }>; nextSeq?: number } {
    const from = Number.isFinite(fromSeq) ? Math.max(1, Math.floor(fromSeq as number)) : 1;
    const limRaw = Number.isFinite(limit) ? Math.floor(limit as number) : TRANSCRIPT_FETCH_DEFAULT;
    const lim = Math.min(Math.max(1, limRaw), TRANSCRIPT_FETCH_MAX);
    const start = this.events.findIndex((e) => e.seq >= from);
    if (start < 0) return { events: [] };
    const slice = this.events
      .slice(start, start + lim)
      .map((e) => ({ seq: e.seq, event: e.event }));
    const next = this.events[start + lim];
    return next ? { events: slice, nextSeq: next.seq } : { events: slice };
  }

  private async runTurn(
    turnId: string,
    input: string | { text: string; images: string[] },
  ): Promise<void> {
    const startedAt = this.now();
    let stats: Awaited<ReturnType<Agent["send"]>> | null = null;
    let failure: Error | null = null;
    try {
      stats = await this.agent.send(input);
    } catch (e) {
      failure = e as Error;
    }

    const abortRequested = this.turn?.abortRequested === true;
    const turnBlockId = this.turn?.blockId;
    const cause: TurnAbortCause = this.turn?.cause ?? "crash";
    // 1) 收口所有打开的流/工具/待决项（异常/中止/超时路径都不留 running 块）。
    this.io.ensureStreamClosed();
    if (this.io.hasPending()) this.io.abortPending(abortRequested ? "abort" : "shutdown");
    this.io.closeTool();

    // 2) abort/异常都要修复 messages 尾部（悬空 assistant(tool_calls) 与不完整 tool 结果）。
    repairMessageTail(this.agent.messages);
    // 3) 轮末：先 messages 原子落盘，再写终态事件（架构 §7.2）。
    this.persistMessages(stats, failure);

    // 4) 先清 turn 再发 idle：客户端收到 idle 立刻 turn.send 不能被误判 conflict。
    this.turn = null;
    this.io.endTurn();
    // 非终态 durable（context/session.status）必须在终态之前发完：
    // serve 的 awaitTurnEnd 以 stats/turn.aborted 为界，之后的 durable 会让
    // snapshot.seq 与客户端已见最高 seq 不一致（序列不变量测试）。
    this.emit({ type: "context", context: this.contextState() }, true);
    this.emit({ type: "session.status", status: "idle" }, true);

    // 5) 终态事件：stats（正常/错误）与 turn.aborted 二选一。
    const aborted = stats?.aborted === true || (failure !== null && abortRequested);
    if (aborted) {
      this.emit(
        {
          type: "turn.aborted",
          turnId,
          blockId: turnBlockId,
          at: this.now(),
          reason: cause,
        },
        true,
      );
    } else if (stats) {
      const usage: Usage = {
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        reasoningTokens: stats.reasoningTokens,
        costMicros: 0,
      };
      this.accumulateUsage(usage, turnId);
      this.emit(
        {
          type: "stats",
          blockId: this.newId("stats"),
          at: this.now(),
          durationMs: stats.durationMs > 0 ? stats.durationMs : this.now() - startedAt,
          usage,
          cumulativeUsage: { ...this.usageTotals },
          toolCalls: stats.toolCalls,
          iterations: stats.iterations,
          tier: this.cfg.modelTier as Tier,
          turnId,
          contextUsage: stats.contextUsage,
          finishReason: stats.finishReason,
          error: stats.hadError
            ? { code: "internal", message: stats.errorMessage ?? "unknown error" }
            : null,
          emptyResponse: stats.emptyResponse,
          provider: this.cfg.providerName,
          model: this.cfg.model,
        },
        true,
      );
    } else {
      // 连 stats 都没有（异常抛在最外层）：仍给一个错误终态，客户端不能挂死。
      const message = failure?.message ?? "轮次失败（未知原因）";
      this.emit(
        {
          type: "error",
          blockId: this.newId("err"),
          at: this.now(),
          code: "internal",
          message,
          retryable: true,
        },
        true,
      );
      this.emit(
        {
          type: "stats",
          blockId: this.newId("stats"),
          at: this.now(),
          durationMs: this.now() - startedAt,
          usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costMicros: 0 },
          toolCalls: 0,
          iterations: 0,
          tier: this.cfg.modelTier as Tier,
          turnId,
          contextUsage: 0,
          finishReason: null,
          error: { code: "internal", message },
          provider: this.cfg.providerName,
          model: this.cfg.model,
        },
        true,
      );
    }

  }

  private accumulateUsage(usage: Usage, turnId: string): void {
    this.usageTotals = {
      promptTokens: this.usageTotals.promptTokens + usage.promptTokens,
      completionTokens: this.usageTotals.completionTokens + usage.completionTokens,
      reasoningTokens: this.usageTotals.reasoningTokens + usage.reasoningTokens,
      costMicros: this.usageTotals.costMicros + usage.costMicros,
    };
    this.usageRecords.push({
      ...usage,
      id: this.newId("usage"),
      userId: "local",
      sessionId: this.sessionId,
      turnId,
      provider: this.cfg.providerName,
      model: this.cfg.model,
      tier: this.cfg.modelTier as Tier,
      at: this.now(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Agent 事件 → 协议（只处理 IO 覆盖不到的部分）                       */
  /* ------------------------------------------------------------------ */

  private handleAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "text":
        this.io.assistantDelta(String(e.data ?? ""));
        return;
      case "reasoning":
        this.io.reasoningDelta(String(e.data ?? ""));
        return;
      case "tool_end": {
        const d = e.data as { ok?: boolean; truncated?: boolean } | undefined;
        this.io.finishTool(d?.ok !== false, d?.truncated === true);
        return;
      }
      case "tier_switch": {
        const d = e.data as { from: ModelTier; to: ModelTier; reason: string; degraded?: string };
        const at = this.now();
        this.emit({ type: "tier.switch", from: d.from as Tier, to: d.to as Tier, reason: d.reason, at }, true);
        this.emitMeta();
        if (d.degraded) {
          this.emit(
            {
              type: "banner",
              blockId: this.newId("banner"),
              at,
              level: "warn",
              text: `档位降级：${d.degraded}`,
            },
            true,
          );
        }
        return;
      }
      case "compact": {
        const d = e.data as { beforeTokens?: number; afterTokens?: number };
        const blockId = this.newId("compact");
        const at = this.now();
        this.emit(
          { type: "compact.start", blockId, at, ...(d.beforeTokens !== undefined ? { beforeTokens: d.beforeTokens } : {}) },
          true,
        );
        this.emit(
          {
            type: "compact.end",
            blockId,
            at,
            ...(d.beforeTokens !== undefined ? { beforeTokens: d.beforeTokens } : {}),
            ...(d.afterTokens !== undefined ? { afterTokens: d.afterTokens } : {}),
          },
          true,
        );
        this.emit({ type: "context", context: this.contextState() }, true);
        return;
      }
      case "error": {
        this.emit(
          {
            type: "error",
            blockId: this.newId("err"),
            at: this.now(),
            code: "internal",
            message: String(e.data ?? "unknown error"),
            retryable: true,
          },
          true,
        );
        return;
      }
      case "tool_start":
      case "turn_end":
      case "aborted":
      default:
        // tool_start 由 AgentIO.toolHeader 处理（带预格式化参数）；
        // turn_end/aborted 由 runTurn 收口。
        return;
    }
  }

  private emitMeta(): void {
    this.emit({ type: "session.meta", meta: this.metaSnapshot() }, true);
  }

  /* ------------------------------------------------------------------ */
  /* abort                                                               */
  /* ------------------------------------------------------------------ */

  async abort(turnId?: string): Promise<{ aborted: boolean }> {
    const turn = this.turn;
    if (!turn) return { aborted: false };
    // 过期 turnId → 幂等 no-op（不能误杀下一轮）。
    if (turnId && turnId !== turn.turnId) return { aborted: false };
    turn.abortRequested = true;
    turn.cause = "user";
    this.io.abortPending("abort");
    this.agent.cancel();
    if (turn.done) {
      await Promise.race([turn.done, sleep(10_000)]);
    }
    return { aborted: true };
  }

  /* ------------------------------------------------------------------ */
  /* 审批 / 提问                                                         */
  /* ------------------------------------------------------------------ */

  resolveApproval(blockId: string, decision: "allow" | "deny" | "allow-session"): boolean {
    return this.io.resolveApproval(blockId, decision);
  }

  answerQuestion(blockId: string, keys: string[], custom?: string): boolean {
    return this.io.answerQuestion(blockId, keys, custom);
  }

  async setMode(mode: ProtocolPermissionMode): Promise<void> {
    if (!isMode(mode)) throw hostError("protocol", `未知权限模式 ${String(mode)}`);
    this.mode = mode;
    this.agent.mode = mode;
    try {
      this.mailbox?.setMode(mode);
    } catch {
      // 状态同步失败不影响模式切换
    }
    this.emitMeta();
  }

  rename(title: string): void {
    const next = title.trim();
    if (!next) return;
    this.title = next;
    this.emitMeta();
    this.persistMessages(null, null);
  }

  /* ------------------------------------------------------------------ */
  /* 命令子集                                                            */
  /* ------------------------------------------------------------------ */

  async runCommand(name: string, args: string[]): Promise<CommandOutcome> {
    const cmdName = name.replace(/^\/+/, "").trim().toLowerCase();
    const outcome = await this.executeCommand(cmdName, args);
    // 结构化回执（v1.1 可选事件）：失败也发，便于客户端命令面板留痕。
    this.emit(
      {
        type: "command.result",
        blockId: this.newId("cmd"),
        name: cmdName,
        ok: outcome.ok,
        blocks: outcome.blocks,
        ...(outcome.changes ? { changes: outcome.changes } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      true,
    );
    return outcome;
  }

  /** 单表路由 + 轮中保护（M2）+ 异常收口；结果形状与 serve 的 CommandOutcome 兼容。 */
  private async executeCommand(cmdName: string, args: string[]): Promise<CommandResult> {
    const spec = findCommand(cmdName);
    if (!spec) return unsupportedCommand(cmdName);
    if (this.turn && isMutatingCommand(cmdName, args)) {
      return {
        ok: false,
        blocks: [
          {
            kind: "notice",
            level: "error",
            text: `本轮运行中不能执行 /${cmdName}（等 stats/turn.aborted 后再试）`,
          },
        ],
        error: { code: "conflict", message: `本轮运行中不能执行 /${cmdName}` },
      };
    }
    try {
      return await spec.run(this.commandContext(), args);
    } catch (e) {
      return {
        ok: false,
        blocks: [
          { kind: "notice", level: "error", text: `/${cmdName} 执行失败：${(e as Error).message}` },
        ],
        error: { code: "internal", message: (e as Error).message },
      };
    }
  }

  /** 命令看到的宿主能力面（唯一出口；命令不直接 import session-host）。 */
  private commandContext(): CommandContext {
    const host = this;
    return {
      cfg: host.cfg,
      agent: host.agent,
      classifier: host.classifier,
      sessionId: host.sessionId,
      get mode() {
        return host.mode;
      },
      now: () => host.now(),
      emit: (event, durable) => host.emit(event, durable),
      emitMeta: () => host.emitMeta(),
      contextState: (usageRatio) => host.contextState(usageRatio),
      usageCostMicros: () => host.usageTotals.costMicros,
      clearSession: () => {
        host.agent.reset();
        host.persistMessages(null, null);
        host.emit({ type: "session.cleared", at: host.now() }, true);
      },
      setMode: (mode) => host.setMode(mode),
      rename: (title) => host.rename(title),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  private persistMessages(
    stats: Awaited<ReturnType<Agent["send"]>> | null,
    failure: Error | null,
  ): void {
    if (!this.agent) return;
    try {
      mkdirSync(dirname(this.persistedPath), { recursive: true, mode: 0o700 });
      const fresh = this.lastTurnMeta(stats, failure);
      // 有新一轮结果就更新记忆；否则（rename/clear/close）沿用上一次，别把 lastTurn 写丢。
      if (fresh) this.lastPersistedLastTurn = fresh;
      const last = fresh ?? this.lastPersistedLastTurn;
      const meta: PersistedMeta = {
        id: this.sessionId,
        // 路径从 id 重算：saveSession 会写 meta.path。
        path: this.persistedPath,
        createdAt: isoAt(this.createdAtMs),
        updatedAt: isoAt(this.now()),
        model: this.cfg.model,
        cwd: this.cfg.cwd,
        turns: this.turnCount,
        mode: this.mode,
        tier: this.cfg.modelTier,
        provider: this.cfg.providerName,
        title: this.title,
        ...(this.lastTurnId ? { lastTurnId: this.lastTurnId } : {}),
        ...(last ? { lastTurn: last } : {}),
      };
      saveSessionAtomically(this.agent.messages, meta, this.persistedPath);
    } catch (e) {
      // 落盘失败：不击穿会话，但必须显式可见（架构 P5；v0.0.2 发 error{storage}）。
      warnStorage(`messages 落盘失败（${this.persistedPath}）：${(e as Error).message}`);
    }
  }

  private lastTurnMeta(
    stats: Awaited<ReturnType<Agent["send"]>> | null,
    failure: Error | null,
  ): LastTurnMeta | null {
    if (!stats && !failure) return null;
    if (!stats) {
      return {
        at: isoAt(this.now()),
        outcome: "error",
        finishReason: null,
        errorMessage: failure?.message ?? "unknown",
      };
    }
    return {
      at: isoAt(this.now()),
      outcome: outcomeOf(stats),
      finishReason: stats.finishReason,
      errorMessage: stats.errorMessage,
      durationMs: stats.durationMs,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 崩溃恢复                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 重启对账（架构 §7.2 / brief §5）。简化版但行为可观察：
   *  - transcript 尾部若有 turn.start 但没有 stats/turn.aborted：
   *    先把半开的块收口，再补 turn.aborted{reason:"crash"}；
   *  - 同一 turn 绝不产生两个终态（只在缺失时补）。
   */
  private repairCrashTail(): void {
    // 单遍扫描：最后一个 turn.start、已终态的 turn、已收口的 block。
    let lastTurnId: string | null = null;
    const terminated = new Set<string>();
    const endedBlocks = new Set<string>();
    for (const { event } of this.events) {
      switch (event.type) {
        case "turn.start":
          lastTurnId = event.turnId;
          break;
        case "stats":
        case "turn.aborted": {
          const t = turnOf(event);
          if (t) terminated.add(t);
          break;
        }
        case "assistant.end":
        case "reasoning.end":
        case "tool.end":
          endedBlocks.add(event.blockId);
          break;
        default:
          break;
      }
    }
    if (!lastTurnId || terminated.has(lastTurnId)) return;

    // 1) 收口所有仍 open 的块（半轮视图不能留 running）。
    for (const block of [...this.state.blocks]) {
      if (endedBlocks.has(block.id)) continue;
      if (block.kind === "assistant") {
        const text = block.segments.map((seg) => ("text" in seg ? seg.text : "")).join("");
        this.emit({ type: "assistant.end", blockId: block.id, text }, true);
      } else if (block.kind === "reasoning" && !block.done) {
        this.emit(
          { type: "reasoning.end", blockId: block.id, durationMs: 0, tokens: 0, text: block.text },
          true,
        );
      } else if (block.kind === "tool" && block.state === "running") {
        this.emit(
          {
            type: "tool.end",
            blockId: block.id,
            state: "error",
            output: "（进程在工具执行中断，已标记为失败）",
            durationMs: 0,
          },
          true,
        );
      }
    }
    // 2) 补唯一终态。
    this.emit({ type: "turn.aborted", turnId: lastTurnId, at: this.now(), reason: "crash" }, true);
  }

  /** 无 transcript（旧会话/被清理）：从 messages 有损重建 blocks（架构 §7.3）。 */
  private rebuildBlocksFromMessages(messages: Message[]): void {
    const blocks: TranscriptBlock[] = [];
    let n = 0;
    const at = this.now();
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        n += 1;
        const turnId = `resume-turn-${n}`;
        const text = contentText(m.content) ?? "";
        blocks.push({ kind: "user", id: `${turnId}-user`, at, text });
        blocks.push({ kind: "turn", id: turnId, at, n });
      } else if (m.role === "assistant") {
        const text = contentText(m.content) ?? "";
        if (text.trim() === "" && !m.tool_calls) continue;
        blocks.push({
          kind: "assistant",
          id: `resume-asst-${blocks.length}`,
          at,
          tier: this.cfg.modelTier as Tier,
          segments: text.trim() === "" ? [] : [{ type: "p", text }],
        });
      } else if (m.role === "tool") {
        blocks.push({
          kind: "tool",
          id: `resume-tool-${blocks.length}`,
          at,
          name: m.name ?? "tool",
          arg: "",
          state: "ok",
          output: contentText(m.content) ?? "",
        });
      }
    }
    this.state = { ...this.state, blocks };
    this.emit(
      {
        type: "banner",
        blockId: this.newId("banner"),
        at,
        level: "info",
        text: "transcript 缺失：已从会话 messages 有损重建视图（degraded）",
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 信箱                                                                */
  /* ------------------------------------------------------------------ */

  private pollInbox(): string[] {
    const mb = this.mailbox;
    if (!mb) return [];
    try {
      const envs = mb.poll((env) =>
        decideInbound(this.cfg.crossSessionInbound, this.mode, env.from.mode),
      );
      if (envs.length > 0) {
        try {
          mailboxState.touchProgress(mb.root, mb.sessionId);
        } catch {
          // ignore
        }
      }
      return envs.map((env) => formatIncomingFrame(env));
    } catch {
      return [];
    }
  }

  private readGoal(): string | null {
    const mb = this.mailbox;
    if (!mb) return null;
    try {
      return mailboxState.readGoal(mb.root, mb.sessionId)?.text ?? null;
    } catch {
      return null;
    }
  }

  private releaseLock(): void {
    const dir = this.lockDir;
    if (!dir) return;
    this.lockDir = null;
    try {
      const owner = readLockOwner(dir);
      // 只有「owner 可读且 pid 是本进程」才删：
      // owner 缺失/损坏时删会误删另一个活进程刚建好但还没写 owner 的锁。
      if (!owner || owner.pid !== process.pid) return;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort：残留锁由下一次启动的 stale 检测回收
    }
  }

  private releaseMailbox(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.mailbox) {
      try {
        releaseAlive(this.mailbox.root, this.mailbox.sessionId);
      } catch {
        // ignore
      }
      this.mailbox = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 关闭                                                                */
  /* ------------------------------------------------------------------ */

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.io?.abortPending("shutdown");
    const turn = this.turn;
    if (turn) {
      turn.cause = "shutdown";
      this.agent.cancel();
      if (turn.done) await Promise.race([turn.done, sleep(5_000)]);
    }
    try {
      this.persistMessages(null, null);
    } catch {
      // ignore
    }
    if (this.memory) {
      try {
        await this.memory.flush(this.cfg.memory.autoCapture.flushTimeoutMs);
      } catch {
        // ignore
      }
      this.memory = null;
    }
    this.releaseMailbox();
    this.releaseLock();
    if (registryReleases) {
      for (const release of registryReleases.reverse()) {
        try {
          release();
        } catch {
          // ignore
        }
      }
      registryReleases = null;
    }
    registryOwner = null;
    this.listeners.clear();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* 单写者锁（~/.neo/run/locks/<id>/owner.json）                        */
/* ------------------------------------------------------------------ */

interface LockOwner {
  pid: number;
  epoch: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但无权限发信号，仍算存活
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLockOwner(dir: string): LockOwner | null {
  try {
    const raw = readFileSync(join(dir, "owner.json"), "utf8");
    const obj = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof obj.pid !== "number") return null;
    return {
      pid: obj.pid,
      epoch: typeof obj.epoch === "string" ? obj.epoch : "",
      startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** 同步睡眠（仅用于锁竞争窗口，ms 级）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 原子写 owner.json（tmp+rename）：读者永远不会看到半截 JSON。 */
function writeLockOwner(dir: string, owner: LockOwner): void {
  const tmp = join(dir, "owner.json.tmp");
  writeFileSync(tmp, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, join(dir, "owner.json"));
}

/**
 * 读 owner，并在「刚 mkdir、owner 还没落」的窗口上短暂重试。
 * 直接把「无 owner」判成 stale 会误抢一个正在启动的进程的锁。
 */
function readLockOwnerSettled(dir: string): LockOwner | null {
  const direct = readLockOwner(dir);
  if (direct) return direct;
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) {
    if (!existsSync(dir)) return null;
    sleepSync(10);
    const again = readLockOwner(dir);
    if (again) return again;
  }
  return readLockOwner(dir);
}

/**
 * mkdir 独占式会话锁（TOCTOU 安全）。
 *
 *  - 抢锁：mkdir 成功后**回读 owner{pid,epoch}** 校验，确认锁确实属于本进程；
 *  - 双开：EEXIST + 持有者 pid 存活 → conflict；
 *  - 接管：EEXIST + 持有者已死 → `rename(lockDir → lockDir.stale-<pid>-<rand>)`，
 *    rename 是原子的且只有一个进程能成功，**赢家才 mkdir + 写 owner**；
 *  - 无 owner 且目录存在（崩溃在 mkdir 与写 owner 之间）→ 等 50ms 复读，
 *    仍无 owner 才按 stale 接管，避免误抢正在启动的活进程。
 */
export function acquireSessionLock(id: string, epoch: string, now: () => number): string {
  const dir = lockDirPath(id);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, epoch, startedAt: isoAt(now()) };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      mkdirSync(dir, { mode: 0o700 }); // 非递归：父目录已在，EEXIST 才代表被持锁
      writeLockOwner(dir, owner);
      // 回读校验：写 owner 期间若被别的进程接管，这里能发现并让出。
      const check = readLockOwner(dir);
      if (check?.pid === process.pid && check.epoch === epoch) return dir;
      throw hostError(
        "conflict",
        `会话 ${id} 的锁写入后校验失败（可能被并发接管）：${dir}`,
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
    }

    const holder = readLockOwnerSettled(dir);
    if (holder) {
      if (holder.pid === process.pid && holder.epoch === epoch) return dir;
      if (isProcessAlive(holder.pid)) {
        throw hostError(
          "conflict",
          `会话 ${id} 正在另一个进程中运行（pid=${holder.pid}，锁 ${dir}）`,
        );
      }
    }

    // stale 接管：rename 抢占（原子，只有赢家能继续）。
    const stale = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(dir, stale);
    } catch {
      continue; // 目录已被别的进程接管/删除：重新走一遍 mkdir
    }
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      // 清理失败不影响接管（残留目录名唯一，不会挡住 mkdir）
    }
  }
  throw hostError("conflict", `会话 ${id} 的锁竞争失败（${dir}）`);
}

/**
 * Config → 协议 `SettingsView`（掩码）。
 *
 * 抽成模块级纯函数（v0.0.2 收尾）：
 *  - host 的 `configView()` 直接调它（行为不变）；
 *  - Hub 在「未 attach 会话」时用 `loadConfig({cwd}) + buildSettingsView(cfg)` 回
 *    `settings.get`，不必为取一份设置去 spawn worker。
 */
export function buildSettingsView(cfg: Config): SettingsView {
  const resolvedRoutes = MODEL_TIERS.map((tier) => {
    const route = cfg.routes[tier];
    const provider = route?.provider ?? cfg.providerName;
    const p = cfg.providers.find((x) => x.name === provider);
    const model = route?.model || p?.models[tier] || cfg.model;
    return {
      tier: tier as Tier,
      provider,
      model,
      fallbackAllowed: route?.fallbackAllowed ?? true,
    };
  });
  return {
    defaultProvider: cfg.providerName,
    defaultTier: cfg.modelTier as Tier,
    classifierProvider: cfg.classifierProvider,
    classifierModelName: cfg.classifierModel,
    providers: cfg.providers.map((p) => ({
      providerName: p.name,
      providerType: p.type,
      baseUrl: p.baseUrl,
      apiKeyMask: maskKey(p.apiKey),
      defaultModelName: p.models.default,
      deepReasoningModelName: p.models.deep_reasoning,
      balancedModelName: p.models.balanced,
      fastModelName: p.models.fast,
      maxTokens: p.maxTokens ?? cfg.globalDefaults.maxTokens,
      temperature: p.temperature ?? cfg.globalDefaults.temperature,
      contextWindow: p.contextWindow ?? cfg.globalDefaults.contextWindow,
      isDefault: p.name === cfg.providerName,
    })),
    routes: resolvedRoutes,
    compactThreshold: cfg.compactThreshold,
    maxToolIterations: cfg.maxToolIterations,
    toolOutputLimit: cfg.toolOutputLimit,
    shell: {
      path: cfg.shell?.path ?? null,
      login: cfg.shell?.login ?? true,
      args: cfg.shell?.args ?? null,
    },
    retry: {
      maxAttempts: cfg.retry?.maxAttempts ?? 3,
      connectTimeoutMs: cfg.retry?.connectTimeoutMs ?? 30_000,
      streamIdleTimeoutMs: cfg.retry?.streamIdleTimeoutMs ?? 120_000,
    },
    showReasoning: cfg.showReasoning,
    toolcallInfoDetails: cfg.toolcallInfoDetails,
    memory: {
      enabled: cfg.memory.enabled,
      autoRecall: cfg.memory.autoRecall.enabled,
      autoCapture: cfg.memory.autoCapture.enabled,
      journalRetentionDays: cfg.memory.autoCapture.journalRetentionDays,
      userWikiDir: cfg.memory.userWikiDir,
    },
    env: {
      enabled: cfg.env?.enabled !== false,
      probeTtlHours: cfg.env?.probeTtlHours ?? 12,
      prompt: cfg.env?.prompt !== false,
      wikiPage: cfg.env?.wikiPage !== false,
    },
    team: {
      skillsExtraPaths: cfg.skillsExtraPaths ?? [],
      // SettingsView 只暴露 auto|hold|off：accept→auto（按接收方权限档），refuse→off。
      crossSessionInbound:
        cfg.crossSessionInbound === "accept"
          ? "auto"
          : cfg.crossSessionInbound === "refuse"
            ? "off"
            : cfg.crossSessionInbound,
      crossSessionAutoTurnLimit: cfg.mailbox.autoTurnLimit,
      crossSessionHeartbeatMs: cfg.mailbox.heartbeatMs,
      crossSessionDeadAfterMs: cfg.mailbox.deadAfterMs,
      crossSessionProgressTimeoutMs: cfg.mailbox.progressTimeoutMs,
      crossSessionWatchdogIntervalS: cfg.mailbox.watchdogIntervalS,
    },
  };
}

function hostError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function pickMode(raw: unknown): ProtocolPermissionMode {
  return isMode(raw) ? raw : "ask";
}

function isMode(v: unknown): v is ProtocolPermissionMode {
  return v === "ask" || v === "auto-edit" || v === "auto-all" || v === "plan";
}

function turnOf(event: SessionEvent): string | undefined {
  return (event as { turnId?: string }).turnId;
}

/** 轮末/中止后修复 messages 尾部：不留悬空 assistant(tool_calls) 与孤立 tool 结果。 */
export function repairMessageTail(messages: Message[]): void {
  for (;;) {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0) {
      messages.pop();
      continue;
    }
    if (last.role === "tool") {
      const prev = messages[messages.length - 2];
      // tool 必须紧跟在带 tool_calls 的 assistant 之后；否则是半轮残留。
      if (!prev || prev.role !== "assistant" || !prev.tool_calls) {
        messages.pop();
        continue;
      }
      // assistant(tool_calls) 的调用数必须与紧随其后的 tool 条数一致。
      let count = 0;
      for (let i = messages.length - 1; i >= 0 && messages[i]?.role === "tool"; i -= 1) count += 1;
      const start = messages.length - 1 - count;
      const owner = messages[start];
      if (owner && owner.role === "assistant" && (owner.tool_calls?.length ?? 0) === count) return;
      messages.pop();
      continue;
    }
    if (last.role === "system") {
      // 只剩 system：合法空历史
      return;
    }
    return;
  }
}


/**
 * 重放校正：`assistant.end.text` / `reasoning.end.text` 是权威全文，但 reducer 的
 * end 分支只收口、不用 text（它信任 delta 累积）。delta 是 ephemeral、不写 transcript，
 * 所以重放时把 end.text 展开成全量 delta，才能恢复出与在线时相同的视图。
 */
export function expandReplayEvents(entries: TranscriptEntry[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const { event } of entries) {
    if (event.type === "assistant.end" && event.text) {
      out.push({ type: "assistant.delta", blockId: event.blockId, text: event.text });
    } else if (event.type === "reasoning.end" && event.text) {
      out.push({ type: "reasoning.delta", blockId: event.blockId, text: event.text });
    }
    out.push(event);
  }
  return out;
}

/** saveSession 信任 meta.path；这里先写 tmp 再 rename，保证轮级原子。 */
/**
 * 轮级原子写：先让 saveSession 写 `<final>.tmp`（它只认 meta.path），再 rename。
 * `finalPath` 由调用方从 session id 重算，绝不使用文件里读到的 meta.path。
 */
function saveSessionAtomically(messages: Message[], meta: PersistedMeta, finalPath: string): void {
  const tmpPath = `${finalPath}.tmp`;
  saveSession(messages, { ...meta, path: tmpPath } as NeoSessionMeta);
  renameSync(tmpPath, finalPath);
}

/**
 * 严格 base64 校验（附件用）：只允许标准字符集、长度为 4 的倍数、且可往返编码。
 * Buffer.from 对非法输入会静默丢弃字符，所以「解码后非空」不足以证明输入合法。
 */
function strictBase64(raw: string, index: number): string {
  const b64 = typeof raw === "string" ? raw.replace(/\s+/g, "") : "";
  if (b64 === "") throw hostError("protocol", `附件 #${index} 的 dataBase64 为空`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw hostError("protocol", `附件 #${index} 的 dataBase64 不是合法 base64`);
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw hostError("protocol", `附件 #${index} 的 base64 解码失败`);
  if (bytes.toString("base64") !== b64) {
    throw hostError("protocol", `附件 #${index} 的 base64 不是规范编码（往返不一致）`);
  }
  return b64;
}

/** magic bytes → 实际图片类型（null = 不是支持的图片）。 */
function sniffImageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** 持久化/transcript 失败告警：stderr（core 不用 console，日志只走 stderr 或注入 Logger）。 */
function warnStorage(message: string): void {
  try {
    process.stderr.write(`[matrix-core] ${message}\n`);
  } catch {
    // stderr 也写不了就算了
  }
}

/* transcript 读取（含尾部半行修复） */
interface LoadedTranscript {
  header: { epoch?: string; createdAt?: string } | null;
  entries: TranscriptEntry[];
  maxSeq: number;
}

function readTranscript(path: string): LoadedTranscript {
  if (!existsSync(path)) return { header: null, entries: [], maxSeq: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { header: null, entries: [], maxSeq: 0 };
  }
  const lines = text.split("\n");
  // 空行不是 corruption：NDJSON 文件尾永远有一个 "\n"（split 后多一个空串），
  // 写成 bad 会导致每次 resume 都做一次全量重写（M4）。
  let parsedHeader: { epoch?: string; createdAt?: string } | null = null;
  const entries: TranscriptEntry[] = [];
  const keep: string[] = [];
  let bad = false;
  let sawHeader = false;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      // 崩溃时的半行：丢弃并标记需要重写。
      bad = true;
      continue;
    }
    if (typeof obj !== "object" || obj === null) {
      bad = true;
      continue;
    }
    const rec = obj as Record<string, unknown>;
    if (!sawHeader && rec["kind"] === "header") {
      parsedHeader = {
        ...(typeof rec["epoch"] === "string" ? { epoch: rec["epoch"] } : {}),
        ...(typeof rec["createdAt"] === "string" ? { createdAt: rec["createdAt"] } : {}),
      };
      keep.push(raw);
      sawHeader = true;
      continue;
    }
    sawHeader = true;
    const event = rec["event"] as SessionEvent | undefined;
    const seq = rec["seq"];
    if (typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string") {
      const s = typeof seq === "number" ? seq : entries.length + 1;
      entries.push({ seq: s, event });
      keep.push(raw);
    } else {
      bad = true;
    }
  }
  if (bad) {
    // 半行/坏行：tmp+rename 重写为合法行（原子，崩在中间不会把好文件写坏）。
    try {
      const tmp = `${path}.rewrite-${process.pid}.tmp`;
      writeFileSync(tmp, `${keep.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // 重写失败：本次仍按 keep 的内存视图继续（下次再试）
    }
  }
  const maxSeq = entries.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
  return { header: parsedHeader, entries, maxSeq };
}

export { SessionHost };
