# 决策记录（ADR）

> 状态：draft · 2026-10-28，2026-11-19 修订 D1/D6/D11/D13
> 格式：编号 · 日期 · 状态 · 背景 · 决策 · 后果。推翻旧决策时保留原文并标注 `Superseded by D#`。

---

## D1 · 仓库完全独立，只以协议为契约

- **日期**：2026-10-28
- **状态**：已定
- **背景**：初版方案建议 `neo` 通过 `file:../neo-core-serve` 依赖 core 包；用户明确担心跨仓依赖的长期问题（发布、CI、版本锁死），要求「分开」。
- **决策**：core / CLI / GUI 三个仓库之间**不允许**代码级依赖（`file:`、workspace、submodule、包注册表都算）。唯一契约是协议 + 文档 + 共享 fixtures；仓库之间通过协议在运行时连接。
- **后果**：
  - core 代码通过「移植 + 冻结旧仓」进入新仓，而不是引用（D2）。
  - 客户端（GUI/CLI）vendor 协议类型/fixtures/命令表，用 conformance 测试防漂移。
  - 过渡期存在两份代码，用「neo 冻结 + CLI 快速切换」压缩窗口（D11；2026-11-19 修订为两阶段，见下）。
- **备选**：`file:` 依赖、submodule、monorepo（均被否）。
- **修订（2026-11-19）**：D1 **对客户端仍然成立**——neo-tui、neo-agent-app、以后的手机端都是客户端，不得引用内核代码，只靠协议连接。开一个窄口：内核只有一份代码住处（neo-core-serve）；过渡期如果旧融合模式还要跑，是让 neo-cli 暂时用 core-serve 里的那份内核，而不是反过来、也不是再复制一份。明确不做：不要把 Hub worker 换成 `neo acp`，不要把「以 neo-cli 为运行时依赖」当成新一代内核。终点见 D11。

---

## D2 · 代码移植而非引用，记录 provenance

- **日期**：2026-10-28
- **状态**：已定
- **背景**：D1 禁止代码依赖；core 需要从 neo 继承成熟实现（agent/llm/tools/memory/wiki/mailbox/session/env/skills/checkpoint）。
- **决策**：从 `neo` 指定 commit 复制核心模块与对应测试到本仓；`docs/provenance.md` 记录来源 commit、文件清单、移植日期、已知改动。之后本仓为唯一真源。
- **后果**：
  - `neo` 只做 critical hotfix；功能改动一律进本仓。
  - 需要一份「移植清单」核对完整性（C0）。
- **备选**：直接在本仓重写（成本高、风险大）。

---

## D3 · 协议源在 core 仓，客户端 vendoring + fixtures

- **日期**：2026-10-28
- **状态**：已定
- **背景**：协议原型在 `neo-agent-app/gui/src/protocol`；core 成为服务端后，契约应跟随服务端演进。
- **决策**：`neo-core-serve/src/protocol/` 为唯一事实源（types/guards/fixtures/reducer/commands.json）。各客户端仓库 vendor 一份，`protocol.lock.json` 记录源 commit + 哈希；`scripts/sync-protocol.sh` 人工同步；CI 跑 conformance。
- **后果**：
  - 客户端不能直接 import core 代码（D1 的必然结果）。
  - 协议变更需要一次「core 发布 → 客户端同步」的动作，按文档纪律执行。

---

## D4 · core 事件化，渲染归客户端；stdout 只走帧

- **日期**：2026-10-28
- **状态**：已定
- **背景**：`agent.ts` 直接写终端（约 40 处），用 `isTTY` 决定流式；协议无法复用行式/ANSI 输出。
- **决策**：Agent 只发领域事件（delta/finished/工具/审批/提问/统计），不 import ui、不渲 markdown、不读 stdout；`streaming` 由调用方注入。`serve` 把 CoreEvent 映射为协议帧；stdio 模式下 stdout 只出帧，日志走 stderr。
- **后果**：
  - 需要把 `StreamFormatter/renderMarkdown/theme` 全部移到客户端侧（CLI 保留现有实现）。
  - 事件表必须一次设计到位（含 durable/ephemeral 区分），否则协议反复。

---

## D5 · v0 单会话进程；v0.5 用 Hub + 每会话 worker

- **日期**：2026-10-28
- **状态**：已定
- **背景**：工具注册表是模块级单例，重复注册抛错；现 CLI 多开即多进程；GUI 需要多会话。
- **决策**：v0 一个 core 进程 = 一个会话（先证明核心可独立运行）；v0.5 增加 `hub` 子命令：会话注册表 + 按需 spawn worker（每会话一个子进程）。
- **后果**：
  - v0 不做 `session.*` 命令；GUI 先单会话联调。
  - 成本可接受（实测核心 import 10–12ms / RSS 43MB；CLI --version 30ms）。
- **备选**：把工具注册表改成 per-session（改动大、收益低，否）。

---

## D6 · 持久化：messages + durable transcript + seq/epoch + 对账

- **日期**：2026-10-28
- **状态**：已定
- **背景**：现 session 文件只存 messages；重启后无法重建思维链/工具输出/审批历史；协议快照需要 blocks；崩溃/abort 会让 messages 与视图不一致。
- **决策**：
  - `messages` 仍是 LLM 上下文真源，按轮原子写（tmp+rename）。
  - `transcripts/<id>.ndjson`：首行 header `{epoch,createdAt}`，之后只写 durable 事件（含 seq）；不写 delta。
  - `seq` 由 core 分配并随 durable 事件持久化；`epoch` 标识 transcript 的世代，重建即换 epoch。
  - `turn.start` 记录 `msgCount`；轮末**先落 messages，再落终态事件**；恢复时按 `meta.lastTurnId` 与 transcript 尾部对账：一致→补 stats，不一致→丢弃半轮视图、messages 截断到 msgCount、补 `turn.aborted{crash}`。
  - abort：先修 messages 尾部（去掉悬空 `assistant(tool_calls)`/不完整 tool 结果），再落盘，最后发 `turn.aborted`；mailbox 轮同样适用。
  - 单写者 = core 进程；Hub 不写会话文件（v0.5）；session 文件路径从 id 重算，不信任 `meta.path`。
  - 锁：`~/.neo/run/locks/<id>/` 与 mailbox `.alive` 互认；pid + 心跳 + 过期回收。
- **后果**：
  - 快照/恢复保真；半轮不会污染下一轮 LLM 请求。
  - transcript 需要滚动/保留策略（30 天，可配）；torn last line 需容错。
- **备选**：只存 messages（有损，否）；完整事件日志含 delta（写放大，否）。
- **修订（2026-11-19）**：Hub **可以**写事件留档（transcript）；对话正文（messages）仍由 worker 写。这不改变「messages 是 LLM 上下文真源、路径从 id 重算」的其余约定。

---

## D7 · 审批/提问：blockId 为线格式 id，deadline 是安全网

- **日期**：2026-10-28
- **状态**：已定
- **背景**：现有 `confirm()` 是 `Promise<boolean>`，无 request id、无 deadline、无断线兜底；`ask_user` 只在 TTY 注册；固定 120s 会误杀正在看 diff 的用户。
- **决策**：
  - 线格式请求 id = `blockId`（ULID）；core 内部 requestId 与之 1:1，不引入第二套 id。
  - deadline 语义：**owner 在线即滑动延长**（默认 30min；owner 任意帧/`ping`/attach 都续期；`ping` 定义为 liveness，pending 时客户端 ≤60s 一次）；owner 断开后 60s 宽限；无客户端立即收敛（审批 deny、提问 cancel）。
  - `by`：`user | timeout | no_client | crash | shutdown | abort`；所有 pending 在 abort/崩溃/关闭时统一 resolve。
  - `allow-session` 仅对 write/edit（cwd 内）生效；**shell 永不内存放行**；不落盘。
  - 无人值守（mailbox 轮）：写操作默认拒绝一次并 banner 提示，不反复弹审批。
  - 非 pending 的 resolve 统一返回 `approval_expired`/`question_expired`。
- **后果**：
  - 不会因「用户看 diff 超过 2 分钟」误拒；客户端断线也不会永久挂起。
  - 需要注入 Timer 以便测试确定性。

---

## D8 · 命令层结构化结果 + 单一 catalog

- **日期**：2026-10-28
- **状态**：已定
- **背景**：`handleCommand` 1000 行、14 参数，展示与逻辑混杂；CLI/GUI 命令表已漂移（39 vs 28）。
- **决策**：core 内 `Command` 注册表 + `CommandOutcome{blocks, changes, error}`；交互统一走 `ctx.ask/askUser/approve`；构建时生成 `protocol/commands.json`（名称/别名/分组/参数摘要），客户端 vendor 并做内容守卫。客户端专属命令（help/last/exit/输入快捷键）不进 core。
- **后果**：
  - 命令实现不打印；渲染归客户端。
  - 命令行为需要黄金样本覆盖。

---

## D9 · 本地鉴权：127.0.0.1 + token 文件 + Origin 白名单

- **日期**：2026-10-28
- **状态**：已定
- **背景**：本地 Hub 若裸监听，本机任意进程/网页都可连；云端鉴权不在本期。
- **决策**：只绑 `127.0.0.1`；随机端口；`~/.neo/run/core.token`（0600）；WS 子协议 `bearer.<token>`；Origin 白名单（localhost/127.0.0.1/tauri）；`/health` 无敏感信息。
- **后果**：测试需读取 token 文件；stdio 模式仅本地测试、无鉴权。

---

## D10 · 版本：core semver + protocol v1 + capabilities

- **日期**：2026-10-28
- **状态**：已定
- **背景**：独立仓库后，core 与客户端独立发版，必须能协商。
- **决策**：core 用 semver tag；协议 `v:1` 内只做向后兼容扩展；`ready` 携带 `coreVersion/protocolVersion/capabilities[]`；客户端按能力降级；破坏性变更升 `v:2`。
- **后果**：客户端必须有 conformance 测试；协议变更流程写入 work-plan §7。

---

## D11 · 两阶段真源：先以 neo-cli 为原型，追平后天平转到 core-serve

- **日期**：2026-10-28
- **状态**：已修订（2026-11-19）
- **背景**：D1 之后 CLI 无法共享 core 代码；若继续在 neo 加功能，会与 core 双份维护。2026-11-19 拍板终点：运行时只住在 neo-core-serve，neo-cli 仍是原型机，不能再按「neo 立刻冻结在 v0.4.3、本仓已经是唯一真源」执行。
- **原决策（2026-10-28）**：`neo` 停留在 v0.4.3（critical hotfix 除外）；core v0 稳定后，把 CLI 改为客户端（连接本地 core，缺失时提示/自动 spawn），并删除内嵌 runtime。CLI 的 TUI/输入层全部保留。
- **决策（2026-11-19 两阶段）**：
  1. **现在**：原型/真源还在 neo-cli。功能在 neo-cli 验证；追平是把已验证的能力真正做进 core-serve 的内核。禁止再从 neo-cli 复制后双线维护。
  2. **追平完成后天平转到 core-serve**：运行时只住在 neo-core-serve（daemon + 内核 + 多会话）。neo-tui、neo-agent-app、以后的手机端都是客户端，只靠协议连接。两边对齐后，融合结构的 neo-agent 退役。`neo` 命令可以留，但只负责启动 TUI 去连 daemon。
  3. **明确不做**：不要把 Hub worker 换成 `neo acp`，不要把「core-serve 去调 neo-cli / 包一层 neo acp」当成新一代内核。测试里钉死某个 neo-cli commit 做对照可以，那是夹具，不是运行时依赖。
- **后果**：
  - CLI 切换（纯客户端化）仍是独立工作，不属于把运行时再搬回 neo-cli。
  - 过渡期融合模式如果还要跑，是让 neo-cli 用 core-serve 里的那份内核，而不是反过来（见 D1 窄口）。

---

## D12 · 文档与 wiki 同步纪律

- **日期**：2026-10-28
- **状态**：已定
- **背景**：用户要求「变更文档和 wiki 库保持一致性」。
- **决策**：
  - PRD/架构/协议/计划/决策为单一事实源，任何行为变更同 PR 更新。
  - 每个里程碑更新 wiki 主题页 + `log.md`；页头必须 `## 摘要` + `> 最后更新:YYYY-MM-DD`。
  - `raw/` 只读；主题页可重写为当前最优综述；历史进修订记录。
  - 发布 tag 同步 release notes。
- **后果**：DoD 里包含文档与 wiki，不可跳过。

---

## D13 · 路径策略：PathPolicy 包裹所有文件操作

- **日期**：2026-10-28
- **状态**：已定
- **背景**：neo 的 `tools/index.ts` 定义了 `insideCwd` 却**从未调用**；read/write/edit/glob/list 可解析到 cwd 之外；`@refs` 解析在 CLI 侧（本仓不共享代码）。
- **决策**：新增 `PathPolicy`（realpath + symlink 解析 + cwd 前缀）包裹所有文件操作：工具、@refs 解析、session 保存/导出、checkpoint undo、wiki/memory 写。负样本测试（`../`、绝对路径、symlink 逃逸、大小写/Unicode 变体）进 CI。
- **后果**：比 neo 现状更严；可能改变少数「读系统文件」的用法，需在 PRD 的非目标里说明。
- **修订（2026-11-19）**：PathPolicy 作为新一代默认留在 core-serve；不要改 neo-cli TUI 的默认行为来迁就本仓。

---

## D14 · 脱敏边界：写盘/写日志前脱敏

- **日期**：2026-10-28
- **状态**：已定
- **背景**：工具输出可能包含 `.env`/密钥；transcript 会持久化工具事件；原计划把脱敏放到 C3，晚于持久化。
- **决策**：脱敏在 `EventSink`/persist/logger 边界统一做（C1.3，先于 C2 持久化）：参数、输出、错误、命令结果；目录 0700、文件 0600；测试扫描 `sk-…`、token 形态。`outputRef` 不暴露路径。
- **后果**：可能损失部分调试信息；需要「调试模式」显式关闭脱敏（默认关）。

---

## D15 · 与 neo CLI 共存与迁移

- **日期**：2026-10-28
- **状态**：已定
- **背景**：过渡期 neo CLI 与 core 共享 `~/.neo`（sessions/mailbox/logs/tmp），但两套锁不互认；`saveSession` 使用 JSON 里的 `meta.path`；日志/清理可能互相删除。
- **决策**：
  - **锁契约**：core 的 `run/locks/<id>/` 与 mailbox `.alive` 互认；任一存在即拒绝双开；启动时校验 pid 存活与心跳。`.alive` 缺失（如 `-p` 非交互 CLI）时，core 仍持自己的锁并在打开/落盘前校验会话文件未被外部改动（mtime/hash）。
  - 路径从 id 重算（`~/.neo/sessions/<id>.json`），不信任 `meta.path`。
  - 日志分区：core 写 `logs/core/`，turn 诊断沿用 `logs/turns/`；清理只碰自己命名空间；与 CLI 的 maintenance 互斥（锁内执行）。
  - **导入/迁移**：提供 `matrix-core import <id>`（只读打开旧会话、不写 transcript）；切换前可 `backup`；旧 CLI 写过的会话由 core 打开时按 D6 对账重建。
  - 交替使用（先 CLI 后 core）允许；同时运行同一会话禁止。
- **后果**：共存期操作更严格；需要在 ops 手册里写清「什么时候必须停 CLI」。

---

## 待决策（不属于 D 系列）

1. CLI 切换后的仓库形态：留在 `neo` 仓 / 新建 `neo-agent-cli`。
2. 远程访问项目如何复用协议（TLS、反向代理、鉴权）。
3. transcript 保留策略的默认值（30 天是否合适）。
4. 多客户端协作权限（v0.5 后的 owner/observer 模型）。
