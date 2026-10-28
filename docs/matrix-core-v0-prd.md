# Matrix-Core v0 —— PRD 与接口规格

> 状态：draft v0.1 · 2026-10-28
> 上游：`neo` v0.4.3（1052 tests / 67 files，PTY 21/21）· `neo-agent-app` 的 WS 协议原型 · `neo/docs/neo-deployment-target.html`
> 范围：把 neo 的核心运行时抽成**可独立运行**的进程。云端、远程、多租户不在本期。
> 纪律：本文是规格，代码实现以本文为准；冲突时先改本文再改代码。

---

## 0. 一句话

**Matrix-Core = 一个不需要终端的 neo 核心进程。** 它跑 Agent 循环、工具、会话、记忆、信箱和斜杠命令，对外用 WS v1 说话。CLI 这一期**不改**，GUI 先接。

```
┌──────────┐   WS v1    ┌──────────────────────────────┐
│  GUI     │──────────▶ │  Matrix-Core (v0: 单会话)     │
├──────────┤            │  Agent / tools / memory /     │
│  CLI     │  (v0 内嵌) │  mailbox / session / commands │
└──────────┘            └──────────────────────────────┘
```

---

## 1. 目标 / 非目标

### 1.1 目标

1. core 进程可在**无 TTY** 环境启动，跑完整一轮：流式正文/思维链 → 工具调用 → 审批/提问 → 命令 → 会话落盘。
2. CLI 与 core **共用同一份核心代码**，不出现第二套 runtime。
3. 对外协议复用 `neo-agent-app/gui/src/protocol` 的 v1 形状：子集 + 向后兼容扩展。
4. 进程模型分两步：**v0 = 单会话**（一个进程 = 一个会话，即目标架构里的 worker）；**v0.5 = 本地多会话 Hub**（会话注册表 + 每会话一个 worker 子进程）。
5. 现有闸门不被破坏：`neo` 的 1052 tests + PTY 21/21；core 新增协议契约测试与边界守卫。

### 1.2 非目标（本期明确不做）

- 云端、远程访问、多租户、OIDC/登录体系、对象存储、跨设备同步
- CLI thin client 改造（默认仍内嵌 runtime；`--attach` 后续版本）
- Windows 实机适配（PD-1 尚未验收）
- 附件/图片协议（v0 只接收文本；图片与 @ 引用在 v0.1 补）
- Tauri 壳、自动更新、分发打包

---

## 2. 边界与代码归属

### 2.1 归属表

| 归属 | 内容 |
|---|---|
| **core** | `agent.ts` `llm.ts` `config.ts` `classifier/` `tools/` `memory/` `wiki/` `mailbox/` `env/` `skills.ts` `session.ts` `system-prompt.ts` `checkpoint.ts` `shell.ts` `contextWindow.ts` `turnDiagnostics.ts` `maintenance.ts` `runtimeTmp.ts` |
| **client（留在 CLI/GUI）** | `ui/` `tui/` `input/` `attachments.ts` `paste.ts` `clipboard.ts` `hotkeys.ts`、入口 REPL、标题动画、readline/composer |
| **shared（独立目录）** | `protocol/`：帧类型 + guards + fixtures（唯一事实源） |

### 2.2 硬规则（必须由守卫测试保证）

1. `core/**` 不得 import `ui/`、`tui/`、`input/`、CLI 入口。
2. `core/**` 不得读 `process.stdout.isTTY`；是否流式由调用方注入（`streaming: boolean`）。
3. `core/**` 不得调用 `process.exit`、不得注册进程信号；生命周期归 `serve/` 或 CLI。
4. 协议模式下 **stdout 只走帧**；日志/告警一律 stderr。
5. 密钥只存在于 core 内存；`settings.get` 只返回掩码，协议永不携带明文 apiKey。

> 现状依据：`agent.ts` 有约 40 处 `console.*` 直写、4 个 `ui/*` import、1 处 `process.stdout.isTTY`（`neo/src/agent.ts:661`）；`index.ts` 的 `main()` 约 1487 行，混着装配、REPL、命令与渲染。

---

## 3. 仓库与依赖策略（待拍板）

现状：`neo` 是单仓（runtime + CLI + 测试）；协议原型在 `neo-agent-app/gui/src/protocol`。

**推荐路径（分三步，避免同时改仓库边界和行为）：**

1. **P0/P1 在 `neo` 内做**：抽 `src/app.ts`（组合根）+ `src/commands.ts`（命令实现）+ 核心事件化。测试网和 PTY 都在 `neo`，回归成本最低。
2. **一次性机械迁移**：`git mv` 核心目录 + 对应测试到 `neo-core-serve/src/core/`；`neo/package.json` 增加路径依赖 `"matrix-core": "file:../neo-core-serve"`；CLI 改为 import。
3. **协议源迁入 `neo-core-serve/src/protocol/`**：GUI 通过 path alias / `file:` 依赖消费同一份类型；fixtures 作为跨端契约测试。迁移期间 GUI 的 `protocol/` 只读，禁止双写。

**备选：**
- git submodule（可复现、但本地开发摩擦大）
- 直接把核心搬到新仓开发（会牺牲现有测试网，不推荐）

> 该决策影响目录结构与 CI，**落地前必须先确认**。本文档不假设最终形态。

---

## 4. 接口规格 v0

### 4.1 传输

- **WS** `/ws`，JSON 文本帧；信封沿用原型：`ClientMessage/ServerMessage`，`v: 1`。
- 本地监听 `127.0.0.1:<port>`（默认随机，写入 `~/.neo/run/core.json`）；**仍校验 token**（`~/.neo/run/core.token`），避免本机任意进程连入。
- `--stdio`：同一帧格式按行分隔，供测试脚本 / PTY 使用；核心 handler 与传输无关（帧进 → 帧出）。
- 错误：`result{ok:false,error:{code,message,retryable}}`；协议不兼容直接拒帧。

### 4.2 客户端 → core（v0 子集）

| 命令 | 参数 | 语义 |
|---|---|---|
| `ping` | — | 返回 `pong` |
| `attach` | `lastSeq?` | 订阅当前会话；返回 `snapshot`。v0 单会话，重复 attach 幂等 |
| `turn.send` | `text`, `clientId` | 发起一轮；运行中再发 → `conflict`（客户端自行排队） |
| `turn.abort` | — | 中断当前轮，最终发 `turn.aborted` + `stats` |
| `approval.resolve` | `blockId`, `decision: allow\|deny\|allow-session` | 回应写盘审批；挂起项不存在 → `approval_expired` |
| `question.answer` | `blockId`, `keys: string[]`, `custom?` | 回应 `ask_user`；多选/自由输入 |
| `command.run` | `name`, `args: string[]` | 执行斜杠命令；结果走事件（v0 不类型化） |
| `settings.get` | — | 返回掩码后的设置视图 |

延后：`session.list/create/close`、`usage.summary`、`auth.*`（v0.5+）。

### 4.3 core → client（v0 子集）

`ready` · `result{id}` · `snapshot{sessionId, seq, snapshot}` · `pong`

事件（每条带 `sessionId`/`seq`，seq 单调）：

| 事件 | 关键字段 |
|---|---|
| `turn.start` | `turnId, blockId, n, at, userText?, clientId?` |
| `assistant.start/delta/end` | `blockId, (at,tier) / text / （结束）` |
| `reasoning.start/delta/end` | `blockId, text / durationMs, tokens` |
| `tool.start/end` | `name, icon, arg / state, output, durationMs, truncated` |
| `approval.request/resolve` | `tool, path?, detail, diff?, deadlineAt / decision` |
| `question.request/resolve` | `prompt, options, multiSelect, allowCustom / keys, custom` |
| `tier.switch` | `from, to, reason, at` |
| `stats` | `durationMs, usage, toolCalls, iterations, tier, turnId` |
| `context` | `used, limit, compactAt` |
| `banner` | `level, text` |
| `error` | `code, message, retryable` |
| `session.meta/status` | 标题/模型/档位/模式/状态 |
| **`turn.aborted`（新增）** | `turnId, at`（原型缺失，必须补） |

**重连**：客户端 `attach{lastSeq}`；缺口小则补发事件，缺口过大则发全量 `snapshot`。

**快照 v0 口径（有损，已知）**：session 文件只存 `messages`，所以重启后只能重建 `user/assistant/tool` 块与 `lastTurn`；思维链、工具原始输出、审批历史不可重建。完整事件日志留 v0.5。

### 4.4 与原型协议的差异（v1.1，全部向后兼容）

1. `approval.request.diff` 改为**可选**（neo 当前只有 `approve(tool, detail: string)`，工具层未透出结构化 diff；v0 传 `detail` + 空 diff）。
2. `question` 增加 `keys[]` / `custom`（现有 `ask_user` 支持多选 + 自由输入；原型只有单选 `key`）。
3. 新增 `turn.aborted`。
4. `command.run` 仍只回 ack，命令输出走 `banner`/`assistant` 事件；结构化 `CommandResult` 留 v0.5。
5. `Usage.costMicros` 置 0（neo 没有价格表）。
6. 附件/图片不做；`turn.send` 只收 `text`。
7. 本地 token 代替 `auth.login`；`auth.*` 事件与命令不做。

---

## 5. 进程模型

### 5.1 v0：单会话

启动顺序（对齐现 `main()` 的装配顺序）：

```
flags(cwd/port/mode/tier/session) 
  → loadConfig(cwd) → applyTier / switchProvider
  → env / modelWindow 探测
  → memory bridge
  → mailbox identity + acquire .alive
  → session create/resume（单写者）
  → classifier
  → Agent + registerTool(task/remember/ask_user/send_message/list_peers/wiki_*)
  → serve（WS + 可选 stdio）
```

关闭：停止收帧 → abort 当前轮 → `memory.flush()` → `persist(session)` → release `.alive` → exit。

- **单写者**：只有 core 进程写 session 文件；Hub（v0.5）只读注册表。
- **崩溃**：v0 进程退出即会话结束；v0.5 由 Hub 负责重启与 turn 边界恢复。
- **成本参考（实测）**：核心 6 模块冷 import 10–12ms / RSS 43MB，完整 CLI 启动 30ms —— worker 模型可行。

### 5.2 v0.5：本地多会话 Hub

- 会话注册表（id / cwd / 状态 / 最后活跃）→ 按需 spawn worker 子进程。
- `session.list/create/attach/close`；attach 到磁盘旧会话 = spawn + resume。
- worker 的 cwd/config/env 在 spawn 时确定（不能用进程级全局 env 覆盖多会话）。
- worker stdout 只走协议，日志走 stderr；空闲回收 + 崩溃重启策略。

---

## 6. 状态与配置

| 项 | v0 口径 |
|---|---|
| settings 搜索 | `cwd/settings.json` → 包根 → `~/.neo/settings.json`（沿用 `config.ts` 现状）；会话 cwd 由启动参数决定 |
| 用户级状态 | `~/.neo/`：sessions / mailbox / skills / env / logs / run |
| 项目级状态 | `<cwd>/.neo/`：wiki / backups / tmp / exports |
| 密钥 | 只进 core；`settings.get` 掩码；协议不携带 |
| 会话身份 | core 进程 = 会话进程；`.alive` + pid + heartbeat 由 core 持有，CLI 断开不释放 |
| 环境探测 | core 在本机采集（env probe 写 `~/.neo/env/<machineKey>.json`） |

---

## 7. 命令支持矩阵（v0）

| 分组 | 命令 | v0 策略 |
|---|---|---|
| 非交互（直接回结果） | `clear` `compact` `context` `cost` `history` `why` `tools` `env` `skills` `sessions` `export` `save` `checkpoints` `undo` `goal` `memory status/list` `remember` `tier`+别名 `auto` `rename` | 支持；输出走事件 |
| 带参数即可（无菜单） | `mode <ask\|auto-edit\|auto-all\|plan>` `tier <名>` `provider <名>` `model <id>` `memory on/off` | 支持 |
| 菜单型（改用 `question.request`） | `provider`/`model`/`mode`/`memory forget` 无参形式 | v0.1 实现；v0 先要求带参数 |
| 延后 | `resume`（会话生命周期，v0.5）`ingest`（子代理 + 长任务）`inbox`（跨会话信箱）`last`（客户端内存）`init`（需 confirm，v0.1） | v0.5 / v0.1 |

> 命令表与实现必须单一来源；CLI 与 GUI 的漂移守卫在迁移后继续覆盖（现 `tests/commands.test.ts` 扫的是 `index.ts`，迁移时要改指 `commands.ts`）。

---

## 8. 验收标准

1. 无 TTY 启动：`GET /api/health` 正常，WS `ready`。
2. 完整一轮（fake-llm + probe 客户端）：流式正文/思维链、工具调用、工具输出、`stats`、session 文件落盘。
3. 审批：`write_file` 触发 `approval.request`；deny → 不写；allow → 写；**无响应 → 超时自动拒绝，进程不挂**。
4. 提问：`ask_user` 触发 `question.request`；多选 + 自定义文本回传后，模型继续。
5. 命令：`command.run: tier deep` 生效并广播 `tier.switch`；`clear/compact/context` 正常。
6. 断线重连：`attach{lastSeq}` 拿到补齐事件或快照；运行中 abort 后状态一致。
7. 守卫：core 目录 import 禁令、`process.stdout/exit` 禁令、协议 fixtures 契约测试全绿。
8. `neo` 现有闸门不变：1052 tests + PTY 21/21 全绿（CLI 行为零变化）。

---

## 9. 里程碑与估算（单人全职，±50%）

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 抽 `app.ts` + `commands.ts`；`agent.messages/mode` 方法化；审批超时/abort；命令表单一化；守卫改指 | 3–5 天 |
| P1 | `streaming` 注入替代 isTTY；`ProtocolConsole`（AgentIO → 协议事件）；单会话 WS 服务 + token + health；审批/提问 RPC；命令子集 | 1.5–2.5 周 |
| P2 | 核心事件化（去掉 agent 内渲染）；快照/重连稳定；命令输出结构化；守卫与契约测试补齐 | 1 周 |
| v0.5 | 会话注册表 + worker 池 + `session.*` + attach/回收/重启；GUI 多会话可用 | 2–3 周 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 两套 runtime 漂移 | 单一 core 代码；CLI 与 core 共用同一包；迁移后禁止复制 |
| 协议与实现漂移 | `protocol/` 单源 + fixtures 契约测试；未知事件/命令拒绝 |
| 会话文件双写 | 单写者 = core/worker；Hub 不写 session 文件 |
| 审批挂起 | request id + turn 绑定 + `deadlineAt` 超时默认拒绝 + abort 兜底 |
| 命令层仍带展示语义 | P0 先抽 `CommandContext`；P2 再拆「结构化结果 vs 客户端渲染」 |
| 快照有损 | v0 明示；v0.5 加事件日志/块持久化 |
| 密钥泄露 | 只在 core；协议只发掩码；日志脱敏 |
| PTY 债务 | P0/P1 不动 PTY；v0.5 前把 PTY 改成 hub+client 双进程 |
| 跨仓依赖摩擦 | 优先 `file:` 依赖 + 固定提交；CI 同时检两个仓 |

---

## 11. 未决问题（需要拍板）

1. **仓库依赖策略**：`file:` 依赖 / submodule / monorepo，三选一（见 §3）。
2. **协议源归属**：迁到 `neo-core-serve/src/protocol`，还是留在 `neo-agent-app` 由 core 消费？
3. **迁移时机**：P1 就在 `neo` 内做完再搬，还是提前搬（影响测试网）。
4. **快照保真度**：v0 接受有损，还是先加事件日志？
5. **附件/图片**：v0.1 做到什么程度（CLI 的粘贴图片是现有能力，不能长期缺失）。
