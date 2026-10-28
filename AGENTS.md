# 项目记忆 · neo-core-serve（Matrix-Core）

> 本文件是仓库级 AI 协作约定，随仓库提交。最后更新：2026-10-28。

## 概览

- 工作目录：`/Users/xueyuheng/research/000-alice-new/neo-core-serve`
- 定位：neo 的核心运行时服务（Agent / 工具 / 会话 / 记忆 / 信箱 / 命令），独立进程、无终端依赖。
- 状态：**设计完成（v0.3 评审后），C0 未开工**。
- 上游：`neo` v0.4.3（源提交 `1da7c6f`，冻结中）、`neo-agent-app`（协议原型 `a52f1f0` + GUI）。

## 基线（2026-10-28 实跑）

- `neo`：**1052 pass / 0 fail / 67 文件** + PTY 21/21（evidence）。`neo/tests/README.md` 的「1051/1」是旧口径。
- 本仓：无代码；协议/文档已冻结（protocol v1.1 / PRD v0.3 / architecture v0.3 / work-plan v0.3）。

## 结构

```
docs/                  PRD / 架构 / 协议 / 计划 / 决策 / provenance / ops / GUI 接入
.neo/wiki/             项目知识库（wiki/ 随仓提交；outputs/ 忽略）
src/                   代码（C0 起）
  protocol/            纯数据：types/guards/fixtures/reducer/commands.json
  core/                会话运行时（不 import serve/protocol/ui/tui/input）
  serve/               WS/stdio 外壳、映射、seq/epoch、流控、鉴权
  hub/                 v0.5 多会话 Hub（暂不实现）
  main.ts              matrix-core serve|status|stop|doctor|import|version
tests/ scripts/       单元/契约/集成/混沌/守卫；fake-llm/probe/verify
```

## 约定（必须遵守）

- **协议冻结**：v1 的判别名（`turn.start`、`assistant.end`、`tool.start/end`、`approval.request/resolve`、`tier.switch`、`banner`、`context`…）**不得重命名**；只加可选字段/新事件/新命令。
- **依赖单向**：`protocol` 零依赖；`core` 不 import `serve/protocol`；`serve` 同时 import 两者；`main → serve`。
- **core 无终端**：禁 import `ui/tui/input`；禁 `process.stdout.isTTY`；禁 `process.exit`（`main.ts` 白名单）；日志走注入 Logger。
- **seq/epoch**：core 分配 seq 并随 durable 事件持久化；epoch 标识 transcript 世代；attach 不匹配强制快照。
- **单写者**：`run/locks/<id>/` + mailbox `.alive` 互认；Hub 不写会话文件；路径从 id 重算，不信 `meta.path`。
- **安全默认**：`PathPolicy`（realpath+symlink+cwd）包裹所有文件操作；脱敏在 EventSink/persist/logger 边界；目录 0700/文件 0600；`outputRef` 不透明。
- **stdout 纪律**：stdio 模式 stdout 只出帧；WS 模式 stdout 不写日志；日志 stderr/文件。
- **协议先行**：改行为先改 `docs/protocol-v1.md` + fixtures，再改代码；客户端按 `protocol.lock.json` 同步。
- **文档即契约**：PRD/架构/协议/计划/决策任一变更，同 commit 更新；`docs:check` 闸门校验锁/目录/链接。
- **Wiki 纪律**：里程碑/重要决策更新 `.neo/wiki/wiki/` 主题页 + `log.md`（append-only）；页头 `## 摘要` + `> 最后更新:YYYY-MM-DD`。
- **闸门**：`tsc && bun test && bun run e2e && bun run guards && bun run docs:check`；发布前 `verify.sh` ALL GREEN，证据 `docs/evidence/`。
- **不跨仓依赖**：禁止 `file:`/workspace/submodule 指向 `neo`/`neo-agent-app`；接口只走协议。

## 踩坑（评审已确认）

- **C0 不能直接搬 agent/tools**：`agent.ts` 依赖 `ui/stream|render|theme`，`tools/{types,askUser}` 依赖 `ui/askUser` → 先搬纯模块（C0b），agent/tools 到 C1 建端口后再搬。
- **`insideCwd` 定义了但从未调用**：neo 的 read/write/edit/glob/list 可越出 cwd → 本仓必须用 PathPolicy 全量包裹 + 负样本测试。
- **脱敏必须早于持久化**：工具输出可能含 `.env`/key；先有 EventSink/logger 脱敏，再开 transcript。
- **`saveSession` 信任 `meta.path`**：损坏/陈旧会话可写到任意路径 → 本仓从 id 重算。
- **锁不互认**：core `run/locks` 与 neo mailbox `.alive` 是两套 → 必须互认，否则双开。
- **tests/README 与实跑不一致**：以实跑/evidence 为准（1052/0）。
- **reducer 不在 protocol/**：在 `gui/src/state/session.ts`，要抽到 `protocol/reducer.ts` 并补 fixtures。
- **编译后 `import.meta.url` 推包根会错**：配置根按可执行文件/环境变量/参数解析。
- **工具注册表单例**：一进程一会话；多会话必须 worker（v0.5）。
- **shell/PATH/locale**：继承 neo 的平台坑，测试固定 `LC_ALL=C`、临时 HOME/cwd。

## 当前状态

- 文档：PRD v0.3 / 架构 v0.3 / 协议 v1.1 / 计划 v0.3 / 决策 D1–D15 / provenance / ops / GUI 接入。
- 代码：未开始。
- 下一步：C0（协议冻结 + 骨架，3d）→ C0b（纯核心移植，4d）→ C1（端口/事件化，15d）。

## 下一步候选

1. 跑 `docs:check` 最小版（协议 lock/命令目录/链接）。
2. 与 GUI 约定 dev 登录与 endpoint。
3. 建立 baseline evidence 并开工 C0。
