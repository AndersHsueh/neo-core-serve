# Matrix-Core 架构设计

> 状态：draft v0.3 · 2026-10-28
> 本文回答「怎么切、怎么跑、怎么不腐化」。需求范围见 [matrix-core-v0-prd.md](matrix-core-v0-prd.md)，任务与工期见 [work-plan.md](work-plan.md)，决策编号见 [decisions.md](decisions.md)，线格式见 [protocol-v1.md](protocol-v1.md)。

---

## 1. 设计目标

Matrix-Core 是 neo 的**唯一核心运行时**，独立进程、无终端依赖，供 CLI / GUI / 未来的远程客户端通过同一套协议驱动。

1. **可独立运行**：无 TTY、无 stdin、无 `process.exit` 也能跑完整轮。
2. **边界可机械校验**：core 不 import UI；不读 stdout；用测试守，不靠自觉。
3. **状态可恢复**：崩在任意时刻，重启后回到最后一个完成轮次；半轮明确标记 aborted。
4. **协议可演进**：v1 内只加可选字段/新事件；判别名冻结；客户端对未知事件降级而非断连。
5. **仓库可独立**：core / CLI / GUI 三仓无代码依赖，只有协议契约 + fixtures + 文档同步。

---

## 2. 设计原则

| # | 原则 | 落地 |
|---|---|---|
| P1 | 依赖单向 | `protocol` 是零依赖叶子；`core` 独立；`serve` 同时依赖两者；`main → serve` |
| P2 | 协议与领域分离 | core 发 `CoreEvent`（含 seq/epoch），serve 映射为 `SessionEvent` 帧（防腐层） |
| P3 | 单一写者 | 会话文件/transcript/锁/seq 计数器都只由 core 进程写 |
| P4 | 增量优先 | delta 流式；快照/重连走 seq+epoch+transcript 回放；大输出走不透明 `outputRef` |
| P5 | 失败显式 | 超时/断线/崩溃/中断都有确定终态事件；半轮必须可修复 |
| P6 | 注入可测 | clock/id/random/llm/fs 边界可注入；黄金事件序列可回放 |
| P7 | 客户端无策略 | 权限/超时/默认值只在 core；客户端只回答 |
| P8 | 文本与结构并存 | 人类可读文本 + 结构化字段（tool/diff/blocks） |
| P9 | 一次只做一层 | 迁移、事件化、协议、Hub 分阶段，每阶段闸门全绿 |
| P10 | 文档即契约 | 行为/协议变更同 PR 更新 PRD、协议、计划、wiki 与 log |

---

## 3. 分层与目录

```
matrix-core/
├── src/
│   ├── protocol/            # 纯数据：types/guards/fixtures/reducer/commands.json
│   ├── core/                # 会话运行时（不 import serve/protocol）
│   │   ├── events.ts        # CoreEvent（含 seq/epoch）+ EventSink
│   │   ├── ports.ts         # ApprovalPort/QuestionPort/Clock/IdGen/Logger/AskUser DTO
│   │   ├── session/         # 生命周期、锁、seq/epoch、transcript、消息修复
│   │   ├── agent/           # 循环、预算、压缩、分类器接入
│   │   ├── llm/ tools/ commands/ config/ memory/ wiki/ mailbox/ env/ skills/ shell/ checkpoint/
│   ├── serve/               # WS/stdio、映射、reducer 快照、鉴权、流控
│   │   ├── mapping.ts       # CoreEvent ↔ SessionEvent；CommandOutcome ↔ ViewBlock
│   │   ├── host.ts          # 连接管理、lastSeq/epoch 校验、合批/背压、角色
│   │   ├── ws.ts / stdio.ts / auth.ts
│   ├── hub/                 # v0.5：注册表 + worker 池（暂不实现）
│   └── main.ts              # serve|probe|doctor|version
├── tests/ scripts/ docs/ .neo/wiki/
```

**依赖规则（守卫测试强制）：**

- `protocol/**` 零依赖（不得 import Node/Bun API、不得 import 其它目录）。
- `core/**` 不得 import `serve/`、`protocol/`；不得 import `ui/`/`tui/`/`input/`。
- `serve/**` 可 import `core/` 与 `protocol/`，并负责两者映射。
- 全仓禁止 `process.stdout.isTTY`；`process.exit` 仅 `main.ts` 白名单。
- `core/**` 禁止 `console.log`；日志走注入的 `Logger`（结构化 + stderr）。

> 为什么 seq 在 core 而不是 serve：seq 是会话级逻辑顺序，必须与 transcript 一起持久化，崩溃后仍连续；serve 只是转发。`epoch` 用于识别「transcript 重建/新会话」。

---

## 4. 领域模型

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `Session` | id, epoch, cwd, mode, tier, provider/model, createdAt, lock | 一个进程一个（v0） |
| `Turn` | id, n, source, clientId, startedAt, msgCount, state | 串行；msgCount=开轮前 messages 长度 |
| `ToolCall` | id, name, args, state, startedAt, outputRef | 与 LLM tool_call_id 对齐 |
| `ApprovalRequest` | blockId(=requestId), turnId, toolCallId, tool, detail, diff?, deadlineAt | 默认拒绝 |
| `QuestionRequest` | blockId, turnId, prompt, options[{key,label}], multiSelect, allowCustom, deadlineAt | 默认取消 |
| `Transcript` | epoch, events[](#seq), blocks | durable 事件流；视图由 reducer 生成 |
| `CoreEvent` | type, seq, epoch, at, turnId?, data | 领域事件；seq 由 core 分配 |

---

## 5. 事件模型

### 5.1 两类事件

| 类别 | 例子 | 持久化 | 用途 |
|---|---|---|---|
| **durable** | turn.start/aborted、assistant.end、reasoning.end、tool.start/end、approval.*、question.*、tier.switch、stats、banner、context、session.*、error、compact.*、command.result、session.cleared | 写 transcript（含 seq） | 重启/重连重建 |
| **ephemeral** | assistant.delta、reasoning.delta、tool.progress、activity、notice | 不写 | 实时体验 |

- delta 不持久化；`assistant.end.text` / `reasoning.end.text` 是权威全文。
- `notice` 是瞬时提示（不重放）；需要留痕的提示用 `banner`。

### 5.2 seq 与 epoch

- 每个 session 一个单调 `seq`，由 core 的 EventSink 分配；**只有 durable 事件推进并落 transcript**。
- ephemeral 事件不推进计数器，信封里的 seq = 当前最高 durable seq（可重复）；客户端只用它检测 transcript 重建。
- 重启后 seq 从最后一个 durable 事件继续；epoch 不变（同一 transcript）。
- transcript 丢失/重建 → 新 epoch；`attach{lastSeq,epoch}` 不匹配或 `lastSeq > 最高 durable seq` → 强制快照。

### 5.3 合批与背压

- serve 合批 delta：16ms 或 4KB；同一 block 合并；ephemeral 不推进 seq，durable seq 连续。
- 每连接队列 512 帧 / 8MB；超限先丢 ephemeral，仍超限断开 4408。
- 客户端重连：指数退避 300ms × 2^n（≤5s + jitter）；attach 成功后补发/快照。

### 5.4 快照

- 目标：由 **serve** 用 `protocol/reducer` 生成（core 不 import protocol）。
  - **v0.0.1 临时偏差**：快照由 `core/session-host` 直接复用 reducer 生成（type-only + 纯函数），v0.0.2 移回 serve；已记入 release notes。
- 形状见 protocol §6.3：`{meta, seq, epoch, blocks, context, lastTurn?, pendingApprovalId?, pendingQuestionId?, live?}`。
- `live` 在 attach 时从 core 的当前 Agent 状态取（partial 文本/工具相位）。
- 客户端 hydrate 保留未落盘的乐观消息（按 clientId）。

---

## 6. 会话生命周期

```
            ┌──────────┐  open   ┌────────┐  turn.send  ┌─────────┐
  start ──▶ │ starting │ ──────▶ │  idle  │ ──────────▶ │ working │
            └────┬─────┘         └───┬────┘             └────┬────┘
                 │ 失败               │ close                 │ approval/question
                 ▼                   ▼                       ▼
              ┌──────┐           ┌────────┐             ┌─────────┐
              │ dead │           │ closed │ ◀────────── │ waiting │
              └──────┘           └────────┘   resolve/abort └────┘
```

- **starting**：加载配置 → env → memory → mailbox → 锁（与 mailbox `.alive` 互认）→ session/transcript → 工具注册 → ready。
- **working**：Agent 循环；拒绝第二个 `turn.send`（`conflict`）。
- **waiting**：挂起审批/提问；`deadlineAt` 是安全网（见 §8）。
- **closing**：停止收帧 → abort → memory.flush → persist → 释放锁（同时释放自己持有的锁；不主动删 `.alive`，除非本进程创建）。
- **dead**：锁失效/心跳超时；新进程可接管。

**崩溃与中断**：
- 每轮 `turn.start` 记录 `msgCount`；轮末先把 messages 原子落盘，再写 `stats`/`turn.aborted`。
- 恢复时对账：`meta.lastTurnId` 与 transcript 尾部 turnId 一致 → 补 `stats`（若缺）；不一致 → 丢弃半轮视图，messages 截断到最后一个完整轮，补 `turn.aborted{crash}`。
- abort：先修复 messages 尾部（去掉悬空 `assistant(tool_calls)` 与不完整 tool 结果），再落盘，最后发 `turn.aborted`。该修复对 mailbox 轮同样生效。

---

## 7. 持久化

### 7.1 布局

```
~/.neo/
  sessions/
    <id>.json                  # {version, meta, messages}；LLM 上下文真源
    attachments/<id>/          # 图片附件（$ref）
    transcripts/<id>.ndjson    # 首行 header{epoch,createdAt} + durable CoreEvent 行（含 seq）
  run/
    core.json                  # url/pid/tokenFile/sessionId/epoch
    core.token                 # 0600
    locks/<id>/                # mkdir 独占；owner.json{pid,epoch,startedAt}
  logs/core/<date>.jsonl       # 结构化日志
  mailbox/ env/ ...            # 沿用
```

### 7.2 写序

1. **轮中**：durable 的非终态事件（turn.start/tool.*/approval/question/assistant.end 等）→ append transcript（含 seq）。
2. **轮末**：`repairMessageTail()` → messages 写 `*.tmp` → `rename`（原子）；同时更新 meta（lastTurnId/turns/lastTurn/updatedAt）。
3. **轮末之后**：写**终态事件** `stats`（正常/错误）或 `turn.aborted`（中断）。终态事件不早于 messages。
4. 恢复对账：
   - `meta.lastTurnId` == transcript 尾部 `turn.start.turnId` 且终态缺失 → 用 `meta.lastTurn` 补写 `stats`（视为完成）。
   - `meta.lastTurnId` != transcript 尾部 turnId（messages 已提交但 transcript 只有半轮）→ 以 messages 为准，补 `turn.aborted{crash}` 或按已完成处理；**绝不产生两个终态**。
   - transcript 有 `turn.start` 无终态、messages 未变（msgCount 后无新增）→ 截断视图、补 `turn.aborted{crash}`。
5. 终态唯一性由 `turnId` 去重：同一 turn 只能有一个 `stats` 或 `turn.aborted`。

### 7.3 恢复

- `--resume <id>`：加载 messages + transcript header/事件 → 校验 epoch → 对账（§6）→ ready。
- 旧会话（无 transcript）：从 messages 有损重建 blocks（user/assistant/tool 文本），标 `degraded:true`，epoch=新。
- 边界：torn last line（尾行 JSON 不完整）→ 丢弃该行并记录；fsync 不做强保证（崩溃时以轮级原子写为准）。

---

## 8. 审批与提问

### 8.1 标识与键

- 线格式请求 id = `blockId`（唯一 ULID）；core 内部 `requestId` 与之 1:1（不引入第二套 id）。
- `turn.abort` 可带 `turnId`；过期/stale turnId → 幂等 no-op（不能误杀下一轮）。

### 8.2 超时语义

- **deadline 是安全网，不是用户计时器**：
  - owner 在线：deadline 滑动延长（默认 30min；owner 的任意帧、`ping`、attach 都续期）；客户端在 pending 时应 ≤60s `ping` 一次（`ping` 定义为 liveness），避免"看 diff 超时"。
  - owner 断开：60s 宽限后默认拒绝/取消。
  - 无客户端（headless/mailbox 轮）：立即按策略拒绝/取消（不挂起）。
- 默认策略：审批 deny、提问 cancel；可在配置里改。
- `by`：`user | timeout | no_client | crash | shutdown | abort`。

### 8.3 策略

- 模式：`ask / auto-edit / auto-all / plan`；判定只在 core。
- `allow-session`：仅对 **write_file/edit_file**（且路径在 cwd 内）生效；**shell 永不内存放行**（每次都要审批）。allow-session 不落盘。
- `plan`：只读，写操作直接拒绝并提示。
- 无人值守（mailbox 触发）：写操作默认拒绝一次并 `banner` 提示；不反复弹审批。
- 问题回答：core 把 UI 的选项标签映射为 `key`（`o1..on`）；多选返回 `keys[]`，自定义返回 `custom`。

### 8.4 并发

- 同一 turn 内工具调用串行 → 最多一个 pending 审批；并行工具（v0 不支持）时排队。
- 重复 resolve → `approval_expired`；abort/崩溃/关闭时统一 resolve 为 `by=abort|crash|shutdown`。

---

## 9. Agent 改造

### 9.1 目标接口

```ts
interface AgentDeps {
  events: EventSink;                 // 发 CoreEvent（含 seq/epoch）
  approvals: ApprovalPort;           // request(req, signal) → Decision
  questions: QuestionPort;           // ask(req, signal) → Answer
  clock: Clock; ids: IdGen;
  streaming: boolean;                // 取代 isTTY
  llm: ChatStream; memory?: MemoryPort;
  checkpoint?: CheckpointSink;
  pollInbox?: () => CoreEvent[];
  readGoal?: () => string | null;
}
```

- 去掉 `ui/*` import、约 40 处 console 调用、`process.stdout.isTTY`、markdown/宽度渲染。
- `AskUserRequest/Answer` DTO 从 `ui/askUser.ts` 移到 `core/ports.ts`（tools 层引用改这里）。
- `TurnResult` 只含统计/终止原因；渲染全部由客户端。

### 9.2 事件映射

| 现有 | 新事件 |
|---|---|
| begin/write/endStream(answer) | assistant.start/delta/end（end.text 权威） |
| 同上 reasoning | reasoning.start/delta/end |
| toolHeader / updateSpinner / toolResult | tool.start / activity / tool.end |
| confirm | approval.request → resolve(by) |
| askUser | question.request → resolve(keys/custom) |
| info/warn/error（瞬时） | notice（ephemeral） |
| compact 前后 | compact.start/end |
| tier_switch | tier.switch |
| turn 结束 stats | stats（正常）；turn.aborted（中断） |

- **子代理**：不发内部 tool 事件；审批/提问透传并带 `subagent:{label,parentToolCallId}`；进度用 `notice`（节流 5s）；父级只看到 `task` 工具块与最终报告。
- **activity**：LLM 等待/工具执行/等待审批的相位，供客户端显示 spinner；ephemeral。

---

## 10. 工具层

- 注册表仍模块级单例（一进程一会话；Hub 用 worker 隔离）。
- `ToolOutcome { output; ok; truncated; outputRef?; diff?; metadata? }`。
- **outputRef 是不透明 id**（`out:<session>:<n>`），不是文件路径；serve 维护映射，`output.get`（v1.2）只接受 id，杜绝任意文件读；TTL 清理。
- 工具 ctx：`signal/cwd/approve/askUser/progress/checkpoint/memory/mailbox`；不注入 UI。
- 子代理：同进程隔离 messages；不递归 `task`；审批/提问透传。
- 安全：路径 `ensureWithin(cwd)` + symlink 解析；plan 只读；shell 走审批。

---

## 11. 命令层

- `Command {name, aliases, group, args, run(ctx,args,signal)}`。
- `CommandContext`：session/config/events/approvals/questions/checkpoint/memory/mailbox/logger/cwd/signal。
- `CommandOutcome { ok; blocks: CommandBlock[]; changes?; error? }`：core 定义**领域块** `CommandBlock`；serve 映射为协议 `ViewBlock`，两者形状由 fixtures 对齐（禁止 core import protocol）。
- 长命令：`command.progress` + `command.result`；取消用 `command.cancel`（v1.2）。
- 客户端专属命令（help/last/exit/输入层）不进 core。
- 构建时生成 `protocol/commands.json`；客户端 vendor + 守卫。
- `/clear` 发 `session.cleared`；`/compact` 发 compact.*。

---

## 12. 配置、密钥与环境

- **实际行为（不是理想分层）**：`loadConfig` 取**第一个存在的** settings 文件（`cwd/settings.json` → 包根 → `~/.neo/settings.json`），不做跨文件合并；provider 列表整表替换。本文按实际行为描述；若将来要真分层合并，另立需求。
- 启动参数（`--mode/--tier`）作为进程级覆盖；session meta 记录最终生效值。
- `settings.get` 只返回掩码；**协议/日志/transcript 不出现明文 key**；项目级 settings 含明文 key 时 `banner{level:"warn"}`。
- cwd 是会话属性，进程不 `chdir`；工具/命令统一用 `session.cwd`。
- env probe 本机采集；注入 prompt；`env.wikiPage` 可关。
- `--resume` 恢复 messages + transcript + mode/tier/provider/model（meta 优先，缺失回落 config）。

---

## 13. 进程与服务层

### 13.1 v0 单会话

```
matrix-core serve [--cwd DIR] [--resume ID] [--port 0]
                  [--mode ask] [--tier default] [--stdio]
                  [--token-file PATH] [--dev-auth]
```

- 启动写 `~/.neo/run/core.json`（url/pid/tokenFile/sessionId/epoch）。
- **锁**：`run/locks/<id>/`（mkdir 独占 + owner.json）；与 mailbox `.alive` **互认**：任一存在即拒绝双开（D15）。`.alive` 缺失（如 `-p` 非交互 CLI）时，core 仍持自己的锁，并在打开/落盘前校验会话文件未被外部改动（mtime/hash），发现变化 → `session_gone`。
- 关闭：SIGTERM/SIGINT → abort → 修复 → flush → persist → 释放锁（10s 宽限，二次信号强退）。

### 13.2 本地 Hub（v0.0.2 已实现，v0.5 增强）

- 注册表 + 每会话 worker（`matrix-core serve --stdio` 子进程）；Hub 不内嵌 Agent、不写会话文件。
- 实现：`session.list/create/attach/detach/close/rename`；未绑定连接一律 conflict；每会话同时一个客户端。
- worker 崩溃/退出：Hub 删除入口并向 owner 推 `session.status{dead}`；再次 attach 会 `--resume` 重新拉起。
- 未实现（v0.5）：空闲回收、自动崩溃重启、多客户端租约、跨机 Hub。
- worker stdout 只走协议、日志 stderr；cwd/config/env 在 spawn 时确定。

### 13.3 mailbox

- 一进程一会话一身份（`.alive`/pid/heartbeat）；Hub 多 worker 即多进程对等网。
- `pollInbox` 只在轮间/空闲 tick；`source:"mailbox"` 的轮同样受审批策略（无人值守拒绝写）。

---

## 14. 传输与映射

- **ACL**：`serve/mapping.ts` 映射 CoreEvent→SessionEvent（透传 seq/epoch）、CommandOutcome→ViewBlock。
- **鉴权**：token 0600；WS 子协议；Origin 白名单；失败直接 4401。
- **stdio**：无鉴权；stdout 只出帧。
- **帧上限** 8MB（v0.0.2 图片附件）；单连接事件经 `batcher`：16ms/4KB/64 帧 flush、delta 合并、队列超限丢 ephemeral/关闭 4408。
- **seq/epoch 校验**：见 §5.2；不匹配走快照。

---

## 15. 版本与兼容

- core semver tag；协议 v1（v0.0.2 = 1.2 语义），只做加法；破坏性 → v2。
- `ready` 带 `coreVersion/protocolVersion/capabilities/epoch`；客户端按能力降级。
- **v0.0.2 实际能力**：单会话 `turn.aborted/command.structured/mode.set/snapshot.live/activity/question.multi/transcript.replay/attachments.image`；Hub 追加 `sessions`。不广告 `peers`/`approval.diff.optional`。
- 契约 fixtures 单源；客户端 vendor + `protocol.lock.json`。
- 服务器兼容矩阵：core 至少兼容前一个协议的客户端（N-1 policy）。

---

## 16. 失败模型

| 故障 | 行为 |
|---|---|
| LLM 连不上/超时 | 重试；超限 → `error{retryable}` + `stats{error}`；会话可继续 |
| 上下文溢出 | 自动 compact 重试一次；仍失败 → stats.error |
| 工具异常 | `tool.end{state:"error"}`；连续失败计数供分类器 |
| 审批无 owner | 立即/宽限后 deny（by=no_client/timeout）；不挂起 |
| 提问无 owner | cancel（by=no_client） |
| 客户端断线 | 轮继续；ephemeral 丢失；重连快照/补齐 |
| core 崩溃 | transcript 修复 + messages 对账；半轮 aborted；epoch 不变 |
| 磁盘满 | 轮失败 + `error{storage}`；不破坏已有文件 |
| 协议违规 | 关闭 4400；记录首帧摘要 |
| 慢消费者 | 丢 ephemeral → 断开 4408 |

---

## 17. 安全模型

- **PathPolicy（v0.0.2 已接入）**：read/write/edit/list/glob/grep、refs、checkpoint undo、export 的路径统一 realpath + symlink + cwd 边界；`~/.neo` 用户级目录显式豁免；shell 不受限。

- 只绑 `127.0.0.1`；token 0600；默认随机端口。
- 策略只在 core；客户端只回答。
- 密钥不出 core：协议/日志/transcript/错误均脱敏（`maskKey` 掩码，不返回前缀之外的片段）。
- 路径：`ensureWithin(cwd)` + symlink 解析；outputRef 不暴露路径。
- shell 审批不内存放行；plan 只读。
- `--dev-auth` 默认关；启用时也只允许回环 + Origin 白名单。

---

## 18. 可观测性

- 结构化日志 `~/.neo/logs/core/<date>.jsonl`（ts/level/event/session/turn/tool/dur/err），stderr 人类可读。
- turn 诊断沿用 `logs/turns/`。
- `/health` + `doctor`（配置/目录/token/端口/LLM/版本）。
- `probe --replay <transcript>` 离线重放。
- 日志脱敏测试（正则扫描 key/token）。

---

## 19. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | 移植的核心测试（agent/llm/config/tools/memory/wiki/mailbox/session/env/skills/checkpoint） |
| 契约 | fixtures 编解码；未知事件放行、未知命令报错；reducer 与快照一致 |
| 集成 | fake-llm + stdio：完整轮/审批/提问/abort/重连/崩溃恢复 |
| 混沌 | kill -9、断线、慢读、磁盘只读、超大输出、时钟跳变、epoch 不匹配 |
| 守卫 | import 边界、stdout/exit、单写者、catalog、catalog 漂移、seq/epoch 连续性 |
| 确定性 | clock/ids/random 注入；同输入 → 同事件序列（golden） |

闸门：`tsc && bun test && bun run e2e && bun run guards`；证据 `docs/evidence/`。

---

## 20. 客户端接入

- **GUI 先接**：`docs/gui-integration.md` 列出必改文件与验收；v0 单会话。
- **CLI 后续**：neo 冻结；切换时 CLI 变纯客户端（连接本地 core；缺失时可 spawn），TUI 保留；不保留 embedded（无共享代码可依）。
- 客户端必须：追踪 seq/epoch、放行未知事件、能力降级、conformance。

---

## 21. 迁移策略

1. **冻结** neo v0.4.3（只 critical hotfix）。
2. **移植**：从 neo `1da7c6f` 复制 core 模块 + core-only 测试；从 neo-agent-app `a52f1f0` 复制协议 types/guards/fixtures，并从 `gui/src/state/session.ts` **提取纯 reducer** 到 `protocol/reducer.ts`。provenance 记录。
3. **本仓为唯一真源**；C0–C3 在测试网内完成。
4. GUI 联调 → CLI 切换（C5）。
5. 过渡期 core bug 只在本仓修；neo 仅出货级 cherry-pick，wiki 记录。

---

## 22. 决策记录

见 [decisions.md](decisions.md)（D1–D15）。

## 23. v0.0.2 已知偏差 / 未交付

- 快照仍由 core host 复用 protocol reducer 生成（目标形态在 serve）；留待清理。
- `core/ui/**` 兼容层仍在（agent/tools 编译依赖），v0.0.3 删除。
- Hub：无空闲回收、无自动崩溃重启、单客户端/会话（第二 attach → conflict）；worker 重启依赖再次 attach。
- `attach` 仍返回完整快照（不做增量补齐）；历史用 `transcript.fetch`。
- 审批仍无断线宽限 / `no_client` / 滑动 deadline（固定超时 + allow-session 内存 allowlist）。
- 附件仅图片 base64（≤5 张/5MB/8MB 帧）；无文件/文本附件、无分片/上传通道。
- 未实现：`output.get`/`checkpoint.*`/`session.export`/`peers.list`/`command.cancel`、多客户端租约、PathPolicy 的 TOCTOU 收口（O_NOFOLLOW 留 v0.0.3）。
- 崩溃恢复保守：半轮一律补 `turn.aborted{crash}`。

## 24. 开放问题

1. CLI 切换后的仓形态（留 neo / 新建 neo-agent-cli）。
2. 远程访问项目如何复用协议（TLS/鉴权）。
3. transcript 保留期与清理策略。
4. 多客户端租约/协作权限（v0.5 后）。
