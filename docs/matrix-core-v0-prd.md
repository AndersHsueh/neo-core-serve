# Matrix-Core v0 —— PRD

> 状态：draft v0.3 · 2026-10-28
> 上游：`neo` v0.4.3（源提交 `1da7c6f`）· `neo-agent-app` 的 WS 协议原型（`a52f1f0`）
> 下游：[architecture.md](architecture.md) · [protocol-v1.md](protocol-v1.md) · [work-plan.md](work-plan.md) · [decisions.md](decisions.md) · [ops.md](ops.md) · [gui-integration.md](gui-integration.md)
> 范围：把 neo 的核心运行时抽成**可独立运行**的进程。云端、远程、多租户、CLI 切换不在本期。

---

## 0. 一句话

**Matrix-Core = 一个不需要终端的 neo 核心进程。** 它跑 Agent 循环、工具、会话、记忆、信箱和斜杠命令，对外用 WS v1.1 说话。core / CLI / GUI 三个仓库**完全独立**，只以协议 + fixtures + 文档为契约。

---

## 1. 目标 / 非目标

### 1.1 目标

1. core 进程可在**无 TTY** 环境启动，跑完整一轮：流式 → 工具 → 审批/提问 → 命令 → 落盘。
2. core 不 import `ui/`/`tui/`/`input/`，不读 stdout，不 `process.exit`（`main.ts` 白名单）。
3. 协议沿用 GUI v1 的判别名，只做加法（v1.1）；GUI 作为第一个消费者，改动清单化。
4. 进程模型：v0 单会话；v0.5 本地 Hub（注册表 + 每会话 worker）。
5. 会话可恢复：崩溃后回到最后完成轮；半轮标记 aborted；messages 与 transcript 对账。
6. **安全默认值**：路径约束（cwd 内）、密钥零外泄、输出脱敏、本地 token。
7. 仓库独立：无 `file:`/workspace/submodule；客户端 vendor 协议 + conformance。

### 1.2 非目标

- 云端、远程访问、多租户、OIDC、对象存储、跨设备同步
- 多用户鉴权（仅本地 token + 可选 dev 登录）
- CLI thin client 改造（neo 冻结；C5 另立）
- Windows 实机（PD-1 未验收）
- 附件/图片（v1.2）、Tauri 壳、分发签名

---

## 2. 用户与场景

| 角色 | 场景 | 本期价值 |
|---|---|---|
| GUI（`neo-agent-app`） | 浏览器/Tauri 连本地 core，跑会话 | 第一个真实消费者，验证协议 |
| 自动化/CI | `matrix-core serve --stdio` + probe | 无 TUI 验收、回归 |
| CLI 用户（后续） | `neo` 连本地 core | C5 之后；本期保证协议就绪 |

---

## 3. 仓库与依赖（已定）

- **完全独立**：禁止代码级依赖；唯一契约是 WS 协议 + fixtures + `commands.json` + 文档。
- **代码来源**：从 neo `1da7c6f` 移植纯核心；协议从 app `a52f1f0` 抽取；reducer 从 `gui/src/state/session.ts` 提取。provenance 记录。
- `neo` 冻结 v0.4.3（只 critical hotfix）；本仓为唯一真源。
- 详见 decisions D1/D2/D3/D11。

---

## 4. 边界

| 归属 | 内容 |
|---|---|
| **core** | agent/llm/config/classifier/tools/memory/wiki/mailbox/env/skills/session/system-prompt/checkpoint/shell/contextWindow/turnDiagnostics/maintenance/runtimeTmp/persist/commands + `sessionName`/`sessionExport` 的 core 版实现 |
| **client** | ui/tui/input/attachments/paste/clipboard/hotkeys、REPL、标题动画、登录页 |
| **shared** | protocol（types/guards/fixtures/reducer/commands.json） |

硬规则与守卫见 [architecture.md](architecture.md) §3。

---

## 5. 功能范围（v0）

### 5.1 会话

- 单会话：`--cwd`、`--mode`、`--tier`、`--resume <id>`；启动参数覆盖 config。
- 落盘：messages（LLM 真源）+ transcript（durable 事件 + epoch/seq）+ 单写者锁。
- 崩溃恢复：对账 messages/transcript、半轮 aborted、torn line 容错、旧会话有损重建。
- 锁：`~/.neo/run/locks/<id>/` 与 mailbox `.alive` 互认；`.alive` 缺失时用会话文件 mtime/hash 检测外部写入；双开拒绝；路径从 id 重算，不信任 `meta.path`。

### 5.2 对话

- 一轮：事件流、工具、审批、提问、abort、stats、context、compact。
- 子代理：同进程隔离；审批/提问透传并带 `subagent` 标记；进度 notice 节流。
- 上下文压缩、空响应重试、窗口探测（沿用 neo）。

### 5.3 审批与提问

- 审批：`ask/auto-edit/auto-all/plan`；`allow/deny/allow-session`；**allow-session 仅 write/edit（cwd 内），shell 永不内存放行**。
- deadline 是安全网：owner 在线滑动延长；断线 60s 宽限；无客户端立即拒绝/取消。
- 提问：单选/多选/自定义；选项 `{key,label}`；超时取消。
- diff：write/edit 尽量提供；`diff` 可为 null，客户端需保护。

### 5.4 命令

- 34 个行为：非交互 + 带参形式；菜单型走 `question.request`；长命令有进度/结果；`/clear` 发 `session.cleared`。
- 结构化结果：core 用领域块 `CommandBlock`，serve 映射为协议 `ViewBlock`（text/markdown/kv/list/table/diff/notice），fixtures 对齐。
- 客户端专属（help/last/exit/输入）不进 core。
- 命令目录 `commands.json` 单源 + 漂移守卫。

### 5.5 记忆 / wiki / 信箱 / 技能 / 环境

- memory bridge：自动捕获/召回/蒸馏；`remember`。
- wiki：`wiki_search`/`wiki_write`/`/wiki-lint`；`/ingest`（C4 后）。
- mailbox：身份/心跳/`send_message`/`list_peers`/watchdog/`/peers`/`/inbox`。
- skills：发现/加载/预算；`use_skill`。
- env：本机探测 + prompt 注入；`/env`。

### 5.6 配置与安全

- **实际行为**：`loadConfig` 取第一个存在的 settings 文件（cwd → 包根 → `~/.neo`），不做跨文件合并；core 必须把**会话 cwd** 传进去（修 `process.cwd` 依赖）。
- 协议/日志/transcript 不出现明文 key；`settings.get` 掩码；项目级明文 key 启动告警。
- `PathPolicy`：所有文件操作 realpath + symlink + cwd 前缀；负样本测试。
- `outputRef` 为不透明 id，不暴露路径；TTL 清理。
- 本地 token 0600；WS Origin 白名单；`--dev-auth` 默认关。

---

## 6. 非功能需求

| 维度 | 要求 |
|---|---|
| 启动 | 无 TTY 冷启动 < 200ms |
| 流式 | delta 合批 16ms/4KB；端到端延迟 ≤ 现 CLI + 20ms |
| 恢复 | kill -9 后回到最后完成轮；messages/transcript 对账；不丢已落盘消息 |
| 稳定 | 8h 会话 RSS 增长 < 20%（跑一次 soak，不承诺 72h） |
| 安全 | 路径不逃逸；密钥零外泄；协议/日志/transcript 扫描零命中 |
| 兼容 | 协议 v1 内向后兼容；客户端 conformance 失败即拒绝连接 |
| 可观测 | 结构化日志 + turn 诊断 + health/doctor；排障不靠猜 |

---

## 7. 协议概要（详见 protocol-v1.md）

- 传输：WS `/ws` + 本地 token；`--stdio`；`/health`；`--dev-auth` 本地登录。
- 命令：session.*（含 v0 shims）、turn.send/abort、approval.resolve、question.answer、command.run、settings.get/patch、mode.set、usage.summary、ping。
- 事件：`turn.start`、`assistant.start/delta/end`、`reasoning.*`、`tool.start/end`、`approval.request/resolve`、`question.request/resolve`、`tier.switch`、`stats`、`banner`、`context`、`session.meta/status`、`peer.update`、`error`、`turn.aborted`、`compact.*`、`command.result`、`session.cleared`。
- seq 由 core 分配并持久化；epoch 识别 transcript 重建；attach 支持补齐/快照；未知事件客户端降级。

---

## 8. 验收标准

1. 无 TTY 启动：`/health`、WS `ready`（user 含 email）。
2. 完整轮：流式/思维链、工具、stats、messages + transcript 落盘。
3. 审批：allow/deny/timeout/no-client；滑动 deadline；进程不挂。
4. 提问：多选 + 自定义；取消路径正确。
5. 命令：tier 切换 + 广播；clear/compact/context；结构化结果；`session.cleared`。
6. 断线重连：attach 补齐/快照；epoch 不匹配强制快照；abort 状态一致。
7. 崩溃恢复：kill -9 后对账、半轮 aborted、torn line 容错；旧会话可读。
8. 守卫：import 边界、stdout/exit、单写者、catalog、脱敏、路径全绿。
9. GUI 启动链 + 单会话：core 仓 conformance harness 绿（外仓 GUI smoke 仅补充）。
10. `neo` 仓库不被修改；基线记录（1052/0/67 + PTY 21/21 evidence）。

---

## 9. 里程碑

见 [work-plan.md](work-plan.md)：C0 协议冻结 3d → C0b 纯核心移植 4d → C1 端口/事件化 15d → C2 协议服务 16d → C3 硬化 9d（v0 共 **47 人日**）→ C4 Hub 15d。C5 CLI 切换另立（10d+）。

---

## 10. 风险

见 [work-plan.md](work-plan.md) §6。最高：移植隐性 UI 依赖、协议/GUI 对不齐、双仓漂移、路径逃逸、脱敏滞后、锁/共存。

---

## 11. 已决策 / 待决策

**已决策**：D1 仓库独立、D2 移植、D3 协议源、D4 事件化、D5 单会话→Hub、D6 持久化/seq/epoch、D7 审批提问、D8 命令层、D9 本地鉴权、D10 版本、D11 neo 冻结、D12 文档/wiki 纪律、D13 路径策略、D14 脱敏边界、D15 共存/迁移。

**待决策**：CLI 切换后的仓形态；远程项目边界；transcript 保留期；多客户端权限。

---

## 12. 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-28 | v0.1 | 初稿 |
| 2026-10-28 | v0.2 | 改为独立仓库；协议源迁入本仓 |
| 2026-10-28 | v0.3 | 按评审修订：判别名冻结、seq/epoch、恢复对账、审批 deadline 语义、路径/脱敏/共存、C0 拆分、基线 1052/0、工期 47d |
