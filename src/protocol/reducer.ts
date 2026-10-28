/**
 * protocol/reducer.ts — 会话视图状态机（纯函数）。
 *
 * 从 neo-agent-app/gui/src/state/session.ts 提取：
 *  - 不碰 DOM、不发请求、不读全局、不读挂钟时间；
 *  - 事件自带 at/id，同输入必得同输出（golden 测试可确定性重放）；
 *  - core 的 serve 层与各客户端共用同一份。
 */

import type {
  ApprovalBlock,
  AssistantBlock,
  AssistantSegment,
  ErrorBlock,
  QuestionBlock,
  ReasoningBlock,
  SessionEvent,
  SessionSnapshot,
  SessionState,
  StatsBlock,
  ToolBlock,
  TranscriptBlock,
  UserBlock,
} from "./types.ts";

const MAX_STREAM_TEXT = 2_000_000;

const clone = <T>(v: T): T => structuredClone(v);

function lastBlock<T extends TranscriptBlock>(state: SessionState): T | undefined {
  return state.blocks[state.blocks.length - 1] as T | undefined;
}

function findBlock<T extends TranscriptBlock>(state: SessionState, id: string): T | undefined {
  return state.blocks.find((b) => b.id === id) as T | undefined;
}

function replaceBlock(state: SessionState, id: string, next: TranscriptBlock): TranscriptBlock[] {
  return state.blocks.map((b) => (b.id === id ? next : b));
}

/** 追加一段纯文本：优先并入最后一个 p 段，否则新开一段 */
function appendAssistantText(block: AssistantBlock, text: string): AssistantBlock {
  const segments = clone(block.segments);
  const last = segments[segments.length - 1];
  if (last && last.type === "p") {
    if (last.text.length + text.length > MAX_STREAM_TEXT) return block;
    last.text += text;
  } else {
    segments.push({ type: "p", text });
  }
  return { ...block, segments };
}

function asUserBlock(block: TranscriptBlock): block is UserBlock {
  return block.kind === "user";
}

/** 快照 → 状态；保留未被快照覆盖的本地乐观消息（同 clientId） */
export function hydrate(snapshot: SessionSnapshot, previous?: SessionState): SessionState {
  const keep: UserBlock[] = [];
  if (previous) {
    const snapshotIds = new Set(snapshot.blocks.map((b) => b.id));
    const snapshotClientIds = new Set(
      snapshot.blocks
        .filter(asUserBlock)
        .map((b) => b.clientId)
        .filter(Boolean),
    );
    for (const block of previous.blocks) {
      if (!asUserBlock(block) || !block.clientId) continue;
      if (snapshotClientIds.has(block.clientId)) continue;
      // 只保留“最后一段”里尚未被落盘的本地消息，避免重复累积
      if (!snapshotIds.has(block.id)) keep.push(block);
    }
  }
  return {
    meta: snapshot.meta,
    seq: snapshot.seq,
    blocks: [...snapshot.blocks, ...keep],
    context: snapshot.context,
    pendingApprovalId: snapshot.pendingApprovalId,
    pendingQuestionId: snapshot.pendingQuestionId,
    streaming: {
      assistantBlockId: snapshot.live?.assistant?.blockId,
      reasoningBlockId: snapshot.live?.reasoning?.blockId,
      turnActive: snapshot.meta.status === "working",
    },
    lastTurn: snapshot.lastTurn,
  };
}

/** 乐观追加一条用户消息（发送时立即上屏） */
export function appendOptimisticUser(
  state: SessionState,
  input: { id: string; clientId: string; text: string; at: number },
): SessionState {
  const block: UserBlock = {
    kind: "user",
    id: input.id,
    at: input.at,
    text: input.text,
    clientId: input.clientId,
  };
  return { ...state, blocks: [...state.blocks, block] };
}

/** AskUser 选中后回填成本地用户消息（hub 也会 resolve 那一问） */
export function appendPickedUser(
  state: SessionState,
  input: { id: string; text: string; at: number },
): SessionState {
  const block: UserBlock = {
    kind: "user",
    id: input.id,
    at: input.at,
    text: input.text,
    picked: true,
  };
  return { ...state, blocks: [...state.blocks, block] };
}

/** 撤回一条尚未被 hub 确认的乐观消息（发送失败时用） */
export function removeUserByClientId(state: SessionState, clientId: string): SessionState {
  return {
    ...state,
    blocks: state.blocks.filter((b) => !(b.kind === "user" && b.clientId === clientId)),
  };
}

export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "turn.start": {
      const blocks: TranscriptBlock[] = [...state.blocks];
      if (event.userText) {
        const existingIndex = state.blocks.findIndex(
          (b) => b.kind === "user" && event.clientId && b.clientId === event.clientId,
        );
        if (existingIndex === -1) {
          blocks.push({
            kind: "user",
            id: `${event.blockId}-user`,
            at: event.at,
            text: event.userText,
            refs: event.refs,
            clientId: event.clientId,
          });
        } else {
          // 乐观消息已上屏：把时间戳对齐到服务器时钟（否则会出现 02:43 与 14:12 并存）
          const current = blocks[existingIndex];
          if (current && current.kind === "user")
            blocks[existingIndex] = { ...current, at: event.at };
        }
      }
      blocks.push({ kind: "turn", id: event.blockId, at: event.at, n: event.n });
      return {
        ...state,
        blocks,
        streaming: { ...state.streaming, turnActive: true },
        meta: { ...state.meta, status: "working" },
      };
    }

    case "assistant.start": {
      const block: AssistantBlock = {
        kind: "assistant",
        id: event.blockId,
        at: event.at,
        tier: event.tier,
        segments: [{ type: "p", text: "" }],
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        streaming: { ...state.streaming, assistantBlockId: event.blockId },
      };
    }

    case "assistant.delta": {
      const block = findBlock<AssistantBlock>(state, event.blockId);
      if (!block) return state;
      return {
        ...state,
        blocks: replaceBlock(state, event.blockId, appendAssistantText(block, event.text)),
      };
    }

    case "assistant.end": {
      const block = findBlock<AssistantBlock>(state, event.blockId);
      let blocks = state.blocks;
      if (block) {
        // 收口：把空段清掉（流式从来没有内容的段不该留在屏幕上）
        const segments = block.segments.filter(
          (s): s is AssistantSegment => s.type !== "p" || s.text.trim() !== "",
        );
        blocks = replaceBlock(state, event.blockId, { ...block, segments });
      }
      return { ...state, blocks, streaming: { ...state.streaming, assistantBlockId: undefined } };
    }

    case "reasoning.start": {
      const block: ReasoningBlock = {
        kind: "reasoning",
        id: event.blockId,
        at: event.at,
        text: "",
        durationMs: 0,
        tokens: 0,
        done: false,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        streaming: { ...state.streaming, reasoningBlockId: event.blockId },
      };
    }

    case "reasoning.delta": {
      const block = findBlock<ReasoningBlock>(state, event.blockId);
      if (!block) return state;
      const text = (block.text + event.text).slice(0, MAX_STREAM_TEXT);
      return { ...state, blocks: replaceBlock(state, event.blockId, { ...block, text }) };
    }

    case "reasoning.end": {
      const block = findBlock<ReasoningBlock>(state, event.blockId);
      if (!block) return state;
      return {
        ...state,
        blocks: replaceBlock(state, event.blockId, {
          ...block,
          done: true,
          durationMs: event.durationMs,
          tokens: event.tokens,
        }),
        streaming: { ...state.streaming, reasoningBlockId: undefined },
      };
    }

    case "tool.start": {
      const block: ToolBlock = {
        kind: "tool",
        id: event.blockId,
        at: event.at,
        name: event.name,
        icon: event.icon,
        arg: event.arg,
        state: "running",
      };
      return { ...state, blocks: [...state.blocks, block] };
    }

    case "tool.end": {
      const block = findBlock<ToolBlock>(state, event.blockId);
      if (!block) return state;
      return {
        ...state,
        blocks: replaceBlock(state, event.blockId, {
          ...block,
          state: event.state,
          output: event.output,
          durationMs: event.durationMs,
          truncated: event.truncated ?? false,
          foot: event.foot,
        }),
      };
    }

    case "approval.request": {
      const block: ApprovalBlock = {
        kind: "approval",
        id: event.blockId,
        at: event.at,
        tool: event.tool,
        path: event.path,
        diff: event.diff,
        state: "pending",
        deadlineAt: event.deadlineAt,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        pendingApprovalId: event.blockId,
        meta: { ...state.meta, status: "waiting" },
      };
    }

    case "approval.resolve": {
      const block = findBlock<ApprovalBlock>(state, event.blockId);
      if (!block) return state;
      return {
        ...state,
        blocks: replaceBlock(state, event.blockId, { ...block, state: event.state }),
        pendingApprovalId:
          state.pendingApprovalId === event.blockId ? undefined : state.pendingApprovalId,
        meta: { ...state.meta, status: "working" },
      };
    }

    case "question.request": {
      const block: QuestionBlock = {
        kind: "question",
        id: event.blockId,
        at: event.at,
        prompt: event.prompt,
        options: event.options,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        pendingQuestionId: event.blockId,
        meta: { ...state.meta, status: "waiting" },
      };
    }

    case "question.resolve": {
      const block = findBlock<QuestionBlock>(state, event.blockId);
      if (!block) return state;
      const blocks = replaceBlock(state, event.blockId, { ...block, answeredKey: event.key });
      if (event.answerLabel) {
        blocks.push({
          kind: "user",
          id: `${event.blockId}-answer`,
          at: event.at,
          text: event.answerLabel,
          picked: true,
        });
      }
      return {
        ...state,
        blocks,
        pendingQuestionId:
          state.pendingQuestionId === event.blockId ? undefined : state.pendingQuestionId,
        meta: { ...state.meta, status: "working" },
      };
    }

    case "tier.switch": {
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: "tierline",
            id: `tier-${event.at}`,
            at: event.at,
            from: event.from,
            to: event.to,
            reason: event.reason,
          },
        ],
        meta: { ...state.meta, tier: event.to },
      };
    }

    case "stats": {
      const block: StatsBlock = {
        kind: "stats",
        id: event.blockId,
        at: event.at,
        durationMs: event.durationMs,
        usage: event.usage,
        toolCalls: event.toolCalls,
        iterations: event.iterations,
        tier: event.tier,
      };
      return {
        ...state,
        blocks: [...state.blocks, block],
        lastTurn: block,
        streaming: { assistantBlockId: undefined, reasoningBlockId: undefined, turnActive: false },
      };
    }

    case "banner": {
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: "banner", id: event.blockId, at: event.at, level: event.level, text: event.text },
        ],
      };
    }

    case "session.meta": {
      return { ...state, meta: event.meta };
    }

    case "session.status": {
      return {
        ...state,
        meta: { ...state.meta, status: event.status },
        streaming: { ...state.streaming, turnActive: event.status === "working" },
      };
    }

    case "context": {
      return { ...state, context: event.context };
    }

    case "error": {
      const block: ErrorBlock = {
        kind: "error",
        id: event.blockId,
        at: event.at,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
      return { ...state, blocks: [...state.blocks, block] };
    }

    case "auth.expired":
    case "peer.update":
    case "activity":
    case "notice":
    case "command.progress": {
      // 由应用层处理（toast/spinner）或 v1.2 再进时间线
      return state;
    }

    case "turn.aborted": {
      return {
        ...state,
        streaming: { assistantBlockId: undefined, reasoningBlockId: undefined, turnActive: false },
        meta: { ...state.meta, status: "idle" },
      };
    }

    case "compact.start": {
      return state;
    }

    case "compact.end": {
      const text =
        event.beforeTokens !== undefined && event.afterTokens !== undefined
          ? `上下文已压缩：${event.beforeTokens} → ${event.afterTokens} tokens`
          : "上下文已压缩";
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: "banner", id: event.blockId, at: event.at, level: "info", text },
        ],
      };
    }

    case "session.cleared": {
      return {
        ...state,
        blocks: [],
        lastTurn: undefined,
        pendingApprovalId: undefined,
        pendingQuestionId: undefined,
        streaming: { assistantBlockId: undefined, reasoningBlockId: undefined, turnActive: false },
      };
    }

    case "command.result": {
      // v1.1：命令结果由客户端命令面板消费；快照暂以 banner 留痕
      if (!event.ok && event.error) {
        return {
          ...state,
          blocks: [
            ...state.blocks,
            {
              kind: "banner",
              id: event.blockId,
              at: state.blocks.at(-1)?.at ?? 0,
              level: "error",
              text: `/${event.name} 失败：${event.error.message}`,
            },
          ],
        };
      }
      return state;
    }

    default: {
      // 编译期穷举：新增事件必须在这里处理；运行期未知类型（guards 放行）直接忽略。
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

export function applyEvents(state: SessionState, events: SessionEvent[]): SessionState {
  return events.reduce(applyEvent, state);
}

/** 供测试与调试：最后一块是什么 */
export function tailBlock(state: SessionState): TranscriptBlock | undefined {
  return lastBlock<TranscriptBlock>(state);
}
