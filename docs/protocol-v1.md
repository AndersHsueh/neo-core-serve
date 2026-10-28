# Matrix-Core 协议 v1.1

> 状态：draft v0.3 · 2026-10-28
> 唯一事实源：本文件 + `src/protocol/{types,guards,fixtures,reducer}.ts`。代码与本文冲突时，先改本文再改代码。
> 基线：`neo-agent-app/gui/src/protocol`（v1 原型）。**v1 的判别名一律不动**；本版只做加法（新增可选字段/事件/命令）与语义收紧。
> 目标：GUI 改动可控、CLI 将来能纯客户端化；协议可被 fixtures 双向验证。

---

## 1. 版本与兼容

- 线格式 `v: 1`；本文描述 1.1 语义，不升 `v`。
- 允许：新增可选字段、新增事件、新增命令、新增能力位、放宽必填。
- 不允许：改判别名、改字段语义、删字段、把可选变必填。
- 客户端：
  - 忽略不认识的可选字段；
  - 对**不认识的事件类型**：放行并忽略（capability 降级），不得因未知事件断连；
  - 对不认识的**命令**：返回 `protocol` 错误。
- 破坏性变更 → `v: 2`（重命名/删字段/改语义）。
- `ready.capabilities` 示例：
  `["approval.diff.optional","question.multi","turn.aborted","command.structured","snapshot.live","transcript.replay","mode.set","peers","usage.extended","activity"]`

---

## 2. 传输

- **WS**：`ws://127.0.0.1:<port>/ws`；子协议 `["neo.v1","bearer.<token>"]`（token 为 hex，RFC6455 合法 token）。
- **鉴权**：token 来自 `~/.neo/run/core.token`（0600）。
  - 失败：**直接关闭 4401**（不发送缺 `id` 的 `result`）。
  - 本地开发登录（仅 `--dev-auth`）：`POST /api/auth/login {email,password}` → `{token,expiresAt,user}`；仅回环 + Origin 白名单；不是生产鉴权。
  - v0 静态 token 不过期；`auth.expired` 事件保留给将来（当前不发）。
- **Origin 白名单**：`http://127.0.0.1:*`、`http://localhost:*`、`tauri://localhost`；无 Origin（CLI/脚本）允许但需 token。
- **stdio**：`matrix-core serve --stdio`；一行一 JSON 帧；stdout 只出帧、日志走 stderr；stdin 关闭 = 优雅关闭；仅本机测试。
- **health**：`GET /health` → `{ok, coreVersion, protocolVersion, state, uptimeMs}`（无鉴权、无 sessionId、无敏感信息）。
- 单帧 ≤ 1MB；大输出用 `outputRef`（§5.1），附件延后（§11）。

---

## 3. 信封与 seq/epoch

```ts
type ClientMessage = { v: 1; kind: "command"; id: string; command: ClientCommand };

type ServerMessage =
  | { v: 1; kind: "ready"; user: User;
      coreVersion: string; protocolVersion: string; capabilities: string[];
      sessionId?: string; epoch?: string }
  | { v: 1; kind: "result"; id: string; ok: true; data: unknown }
  | { v: 1; kind: "result"; id: string; ok: false; error: HubError }
  | { v: 1; kind: "event"; sessionId: string; seq: number; event: SessionEvent }
  | { v: 1; kind: "snapshot"; sessionId: string; seq: number; snapshot: SessionSnapshot }
  | { v: 1; kind: "sessions"; sessions: SessionMeta[] }
  | { v: 1; kind: "settings"; settings: SettingsView }
  | { v: 1; kind: "usage"; range: "session"|"day"|"month"; records: UsageRecord[]; totals: Usage }
  | { v: 1; kind: "pong" };
```

- `ready.user` 必填且含 `id/email/displayName/role`；本地模式 `{id:"local",email:"local@localhost",displayName:"Local",role:"owner"}`。
- **seq**：session 级单调计数，由 **core 分配**（不是 serve），**只随 durable 事件递增并持久化**；ephemeral 事件不消耗计数器，携带**当前 durable seq**（信封里仍有 seq，值可重复）。`server.seq` / `snapshot.seq` 一律指**最高 durable seq**。
- **epoch**：session 打开时生成的随机串（16 hex），写入该 session 的 transcript 头；`ready/snapshot` 都带。
  - `session.attach{lastSeq, epoch?}`：epoch 不匹配或 `lastSeq > server.seq（最高 durable seq）` → **强制快照**；否则按 transcript 补齐 durable 事件。
  - 崩溃重启：seq 从最后一个 durable 事件继续；epoch 不变（同一 transcript）；transcript 丢失/重建 → 新 epoch。
- 客户端必须：每次收到帧都更新 `lastSeq` 与 `epoch`（GUI 现状未更新，属客户端 bug，见 §7）。
- `sessions/settings/usage` 三种 kind 只用于服务端主动推送；查询结果放 `result.data`。

---

## 4. 命令（客户端 → core）

### 4.1 命令全集（v1.1；标注 v0 实现）

| 命令 | 参数 | 回执 data | v0 |
|---|---|---|---|
| `ping` | — | — | ✅ `pong`；**liveness**：有 pending 审批/提问时，owner 任何帧（含 ping）都续期 deadline；客户端在 pending 时建议 ≤60s ping 一次 |
| `auth.login` / `auth.logout` / `auth.whoami` | — | — | ⚠️ HTTP/dev-only：`--dev-auth` 下由 HTTP 处理；WS 上返回 `unsupported`（v1 保留命令名，避免 vendored union 缺类型） |
| `session.list` | — | `{sessions: SessionMeta[]}` | ✅ 唯一会话 shim |
| `session.create` | `title?`, `cwd?` | `{sessionId}` | ✅ 单会话返回当前 id；否则 `conflict` |
| `session.attach` | `sessionId?`, `lastSeq?`, `epoch?` | `{role}` + `snapshot` | ✅ |
| `session.detach` | `sessionId?` | `{}` | ✅ no-op |
| `session.rename` | `sessionId?`, `title` | `{}` | ✅ 广播 `session.meta` |
| `session.close` | `sessionId?` | `{}` | ⚠️ `unsupported`（GUI 提示） |
| `turn.send` | `sessionId?`, `text`, `clientId`, `refs?` | `{turnId}` | ✅ 运行中 → `conflict` |
| `turn.abort` | `sessionId?`, `turnId?` | `{aborted}` | ✅ 过期 turnId → 幂等 no-op |
| `approval.resolve` | `sessionId?`, `blockId`, `decision` | `{resolved}` | ✅ |
| `question.answer` | `sessionId?`, `blockId`, `key?`, `keys?`, `custom?` | `{answered}` | ✅ 兼容 `key` |
| `command.run` | `sessionId?`, `name`, `args` | `{ok, blocks?, changes?}` | ✅ 输出同时发 `command.result` |
| `command.cancel` | `sessionId?`, `name` | `{}` | ❌ v1.2 |
| `settings.get` | — | `{settings: SettingsView}` | ✅ 掩码 |
| `settings.patch` | `patch: SettingsPatch` | `{settings}` | ⚠️ `unsupported`，C3 |
| `mode.set` | `sessionId?`, `mode` | `{}` | ✅ 广播 `session.meta` |
| `usage.summary` | `range`, `sessionId?` | `{range, records, totals}` | ✅ 空用量（costMicros=0） |
| `transcript.fetch` | `sessionId?`, `fromSeq?`, `limit?` | `{events, nextSeq?}` | ❌ v1.2（CLI `/last`） |
| `checkpoint.list` / `checkpoint.undo` | `sessionId?`, `n?` | `{entries}` / `{restored}` | ❌ v1.2 |
| `session.export` | `sessionId?`, `format:"md"\|"json"` | `{path, content?}` | ❌ v1.2 |
| `output.get` | `ref` | `{text, truncated}` | ❌ v1.2 |
| `peers.list` | — | `{peers}` | ❌ v1.2 |

- 所有会话类命令的 `sessionId` 均为可选（v0 校验后忽略），**兼容 GUI 现有调用**。
- `refs`：`{icon,label,kind?:"file"|"skill"|"url",path?}`；内容由 core 在 `cwd` 内解析；错误/截断在 v1.2 补。
- `turn.send` 不接收附件（v1.2）。

### 4.2 幂等与冲突

- `turn.send.clientId`：保留最近 200 个；重复投递返回同一 `turnId`。
- `approval.resolve` / `question.answer`：非 pending（超时/已答/未知）→ `approval_expired` / `question_expired`。
- `session.attach`：幂等；重复 attach 重发快照或补齐。
- 客户端负责排队：`turn.send` 在 working 时返回 `conflict`；客户端不得并发发送（GUI 在 busy 时禁用输入）。

### 4.3 设置与模式

- `SettingsView` 沿用 GUI 类型（provider 掩码、routes、memory/env/team、retry、shell…）；由 core 的 `Config` 映射。
- `SettingsPatch`：浅合并 + 嵌套部分合并；**不接受任何密钥字段**。
- `mode.set` 是 v1.1 新增；同时推送 `session.meta`（含 `mode`）。

---

## 5. 事件（core → 客户端）

判别名**严格沿用 GUI v1**。所有事件都有外层 `seq`。`(new)` = v1.1 新增。

### 5.1 durable（写 transcript，可重放）

| 事件 | 字段 | 说明 |
|---|---|---|
| `turn.start` | `turnId, blockId, n, at, source, msgCount, userText?, clientId?, refs?` | `source:"user"\|"mailbox"`；`msgCount`=开轮前 messages 长度（恢复用） |
| `assistant.start` | `blockId, at, tier` | |
| `assistant.end` | `blockId, text` | **`text` 为权威全文**；客户端用它覆盖 delta 累积 |
| `reasoning.start` | `blockId, at` | |
| `reasoning.end` | `blockId, text, durationMs, tokens` | |
| `tool.start` | `blockId, toolCallId?, at, name, icon?, arg` | `arg` 预览串；`icon` 可选，缺省由客户端按 name 映射 |
| `tool.end` | `blockId, state:"ok"\|"error"\|"denied", output, durationMs, truncated?, foot?, outputRef?` | `output`=预览；`outputRef` 为不透明 id（非路径） |
| `approval.request` | `blockId, at, tool, detail, toolCallId?, path?, diff?, deadlineAt?, subagent?` | `blockId`=线格式请求 id；`diff` 可为 `null` |
| `approval.resolve` | `blockId, state:"allowed"\|"denied", by` | `by:"user"\|"timeout"\|"no_client"\|"crash"\|"shutdown"\|"abort"` |
| `question.request` | `blockId, at, prompt, options:{key,label,description?}[], header?, context?, multiSelect?, allowCustom?, deadlineAt?, subagent?` | |
| `question.resolve` | `blockId, at, key?, keys?, custom?, answerLabel?, by` | `at` 新增（确定性 reducer）；`key` 兼容旧客户端 |
| `tier.switch` | `from, to, reason, at` | 首个 LLM 请求前发出 |
| `stats` | `blockId, turnId, at, durationMs, usage, cumulativeUsage?, toolCalls, iterations, tier, contextUsage?, finishReason?, error?, emptyResponse?, provider?, model?` | **stats = 正常轮末** |
| `banner` | `blockId, at, level, text` | 需要留痕的提示（压缩结果/重试/警告） |
| `session.meta` | `meta: SessionMeta` | 标题/模型/档位/模式变更 |
| `session.status` | `status` | idle/working/waiting/stalled/dead |
| `context` | `context:{used,limit,compactAt}` | |
| `peer.update` | `peers[]` | 跨会话状态（capability `peers`） |
| `error` | `blockId, at, code, message, retryable` | 不终止进程；`blockId/at` 必填以保证 reducer 可确定性重放（旧客户端可忽略） |
| `auth.expired`（保留） | — | v1 union 保留；v0 静态 token 不发送 |
| `turn.aborted`（new） | `turnId, blockId?, at, reason:"user"\|"crash"\|"shutdown"` | **终止轮**，与 stats 二选一 |
| `compact.start` / `compact.end`（new） | `blockId, at; end 带 beforeTokens/afterTokens` | |
| `command.result`（new） | `blockId, name, ok, blocks?, changes?, error?` | blocks 见 §6.1 |
| `session.cleared`（new） | `at` | `/clear`：客户端重置 blocks（保留 meta） |

### 5.2 ephemeral（不写 transcript）

| 事件 | 字段 | 说明 |
|---|---|---|
| `assistant.delta` | `blockId, text` | |
| `reasoning.delta` | `blockId, text` | |
| `tool.progress` | `blockId, text` | v1.2 |
| `activity`（new） | `phase:"llm"\|"tool"\|"approval"\|"compact", since` | 等待相位（capability `activity`） |
| `notice`（new） | `level:"info"\|"warn"\|"error", text` | 瞬时提示（不重放） |

- 仍带外层 `seq`（= 当前最高 durable seq，**不推进计数器**）；合批不产生跳号；客户端只用它检测 transcript 重建。
- 重连不重放 ephemeral；靠 `snapshot.live` + 后续事件恢复。

### 5.3 一轮的终态

- **正常/错误**：`stats`（必有；`error` 字段非空表示本轮失败）。
- **中断**：`turn.aborted`（必有）；不再发 `stats`。
- 两者互斥；客户端以先到者收口 `turnActive`。
- `stats.emptyResponse=true` 表示模型连续空正文（沿用 neo v0.4.1 语义）。

### 5.4 SessionMeta（GUI 依赖的完整形状）

```ts
type SessionStatus = "idle"|"working"|"waiting"|"stalled"|"dead";
type PermissionMode = "ask"|"auto-edit"|"auto-all"|"plan";
type Tier = "deep_reasoning"|"balanced"|"fast"|"default";

interface SessionMeta {
  id: string; title: string; ownerId: string; status: SessionStatus;
  tier: Tier; provider: string; model: string; cwd: string;
  createdAt: number; updatedAt: number; unread: number;
  mode: PermissionMode;        // (new)
}
```

core v0 映射：`ownerId="local"`、`unread=0`、`title=会话名`、`status` 由生命周期得出。
`--resume` 恢复：messages + transcript 视图 + `mode/tier/provider/model`（以 session meta 为准，缺失时回落 config）。

---

## 6. 块、快照、重连

### 6.1 块（沿用 GUI v1，补字段）

- `ApprovalBlock { requestId?, path?, detail?, diff?: FileDiff | null }`
- `QuestionBlock { header?, context?, multiSelect?, allowCustom?, answeredKeys?, custom? }`
- `ToolBlock { icon?, state, foot? }`

**ViewBlock（v1.1 新定义，命令结果用）**：

```ts
type ViewBlock =
  | { kind:"text"; text:string }
  | { kind:"markdown"; text:string }
  | { kind:"kv"; items:{k:string;v:string}[] }
  | { kind:"list"; items:string[]; ordered?:boolean }
  | { kind:"table"; head:string[]; rows:string[][] }
  | { kind:"diff"; file:string; diff:FileDiff }
  | { kind:"notice"; level:"info"|"warn"|"error"; text:string };
```

### 6.2 reducer

- `applyEvent(state,event)` 纯函数在 `protocol/reducer.ts`；由 **serve 层与客户端**共用。
- core 不 import protocol：core 发 `CoreEvent`（含 seq/epoch），serve 映射为协议事件并用 reducer 维护快照视图。
- 新增事件顺序：types → guards（未知放行）→ reducer → fixture → 测试 → 实现。

### 6.3 快照

```ts
SessionSnapshot = {
  meta: SessionMeta; seq: number; epoch: string;   // seq = 最高 durable seq
  blocks: TranscriptBlock[];
  context: { used: number; limit: number; compactAt: number };
  lastTurn?: StatsBlock;
  pendingApprovalId?: string; pendingQuestionId?: string;
  live?: {                                   // capability snapshot.live；blocks 已含 partial 块，live 只标记相位
    turnId: string;
    assistant?: { blockId: string; text: string };
    reasoning?: { blockId: string; text: string };
    tool?: { blockId: string; name: string; startedAt: number };
    activity?: { phase: string; since: number };
  };
}
```

- `attach{lastSeq?,epoch?}`：
  - 无 lastSeq / epoch 不符 / lastSeq > server.seq → 完整快照。
  - 有 lastSeq 且可补齐 → 回放 `seq > lastSeq` 的 durable 事件；再发 `live`。
  - 无法补齐（transcript 被清理）→ 快照。
- **mid-turn attach 的 blocks 必须包含进行中的块**：assistant/reasoning/tool 的 partial 块以真实 `blockId` 出现在 `blocks` 里（文本为当前 partial），`live` 只用于标记相位；客户端不得丢弃这些 blockId 的后续 delta/end。
- 客户端 hydrate：保留未被快照覆盖的本地乐观消息（按 `clientId`）。

---

## 7. 与 GUI v1 的差异（客户端改动清单）

| # | 变更 | GUI 必改？ |
|---|---|---|
| 1 | `ready` 增 `coreVersion/protocolVersion/capabilities/sessionId?/epoch?` | 否（忽略） |
| 2 | `approval.request.path/diff/detail` 可选、`diff` 可为 null | **是**（guards + null 保护） |
| 3 | `question.request` 增 `header/context/multiSelect/allowCustom`；options 变 `{key,...}`；resolve 增 `keys/custom` | **是**（guards + 多选 UI；v0 可先单选） |
| 4 | 新增 `turn.aborted`、`compact.*`、`command.result`、`session.cleared`、`activity`、`notice` | **是**（guards 放行未知 + aborted/cleared 收口） |
| 5 | `assistant.end.text` / `reasoning.end.text` 权威 | **是**（覆盖累积，避免重复/缺字） |
| 6 | `stats` 增 `blockId/turnId/contextUsage/...` | 否（可选） |
| 7 | `snapshot` 增 `epoch/live` | **是**（hydrate live） |
| 8 | `SessionMeta.mode` | **是**（类型 + 显示） |
| 9 | `mode.set` 命令 | **是**（模式切换改走它） |
| 10 | 客户端必须追踪 seq/epoch | **是**（`app.ts:145/231`） |
| 10b | `error` 新增必填 `blockId/at`；`question.resolve` 新增 `at` | **是**（guards/reducer；旧 `Date.now()` 改为读事件） |
| 10c | `snapshot.live` 的 blocks 已包含 partial 块 | **是**（hydrate 不再合成；未知 block 的 delta 需 upsert） |
| 10d | `ping` 语义 = liveness（pending 时续期） | **是**（pending 时 ≤60s ping） |
| 10e | 新增错误码 `question_expired`/`slow_consumer`（GUI `ERROR_KEYS` 需补） | **是** |
| 10f | `auth.expired` 保留（v0 不发）；`auth.*` 命令名保留（WS 返回 unsupported） | **是**（types union 不删） |
| 11 | 未知事件不得导致断连 | **是**（`guards.ts:80`） |
| 12 | 本地 token（保留 dev 登录） | **是**（登录层 endpoint/凭据） |
| 13 | 附件/图片延后；`turn.send` 只 text | v0 不做 |
| 14 | `usage.costMicros=0` | 显示「未计价」即可 |

> GUI 必改文件（约 6 个）：`protocol/{types,guards}`、`state/session.ts`、`state/app.ts`、`transport/hub.ts`、`lib/commands.ts`（catalog）、登录层。详见 `docs/gui-integration.md`。

---

## 8. 错误码与关闭码

`unauthorized` · `forbidden` · `not_found` · `conflict` · `rate_limited` · `timeout` · `approval_expired` · `question_expired` · `session_gone` · `slow_consumer` · `protocol` · `internal`

- 非 pending 的审批/提问（超时/已答/未知）统一 `approval_expired` / `question_expired`；`not_found` 只用于不存在的资源（session/ref）。
- WS 关闭：4400 协议、4401 未授权、4408 慢消费者、1011 内部错误。

---

## 9. 流控与背压

- delta 合批：16ms 或 4KB；同 block 合并，保留当前 durable seq（不推进、不跳号）。
- 每连接队列 512 帧 / 8MB；超限先丢 ephemeral，仍超限断开 4408。
- 客户端重连退避 300ms × 2^n，封顶 5s + jitter。

---

## 10. 契约测试与 vendoring

- `protocol/fixtures.ts`：每种帧/事件正样本 + 坏样本；guards 必拒坏样本、必放未知事件。
- 客户端仓库：`protocol.lock.json`（sourceRepo/sourceCommit/protocolVersion/sha256）；`sync-protocol.sh` 人工同步；CI conformance。
- `commands.json`：命令目录（name/aliases/group/args/version），core 构建生成；客户端 vendor + 校验。
- 禁止跨仓代码依赖（D1）。

---

## 11. 延后与未定

- 附件/图片（v1.2）：`turn.send.attachments` + 上传通道 + 提高帧上限。
- `transcript.fetch` / `output.get` / `checkpoint.*` / `session.export` / `peers.list` / `command.cancel`（v1.2，CLI 纯客户端化前必备）。
- `routing.decision`（`/auto` `/why`）、`goal`/`inbox` 元信息（v1.2）。
- 多客户端租约/审批归属（v0.5 后）。
- 远程 TLS/鉴权（另一项目）。
