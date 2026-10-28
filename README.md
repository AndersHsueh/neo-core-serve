# neo-core-serve

neo 的核心运行时服务 —— 代号 **Matrix-Core**。

- 定位：从 neo CLI 中分离出来的**独立可运行**核心进程（agent 循环 / 工具 / 会话 / 记忆 / 信箱 / 命令），不依赖终端。
- 客户端：桌面工作台（`neo-agent-app`）先接入；CLI（`neo`）后续切换为客户端。
- 边界：本仓只做 core + serve，不含 TUI、不含 GUI、不含云端多租户。
- 仓库纪律：core / CLI / GUI **三个仓库完全独立**，只以协议 + 文档 + fixtures 为契约（见决策 D1）。

## 状态

**设计 v0.3 完成（3 个评审 agent 修订后），待开工 C0。** 代码从 C0 协议冻结 + C0b 纯核心移植开始；agent/tools 在 C1 建端口后再搬。

- v0 计划：C0 3d → C0b 4d → C1 15d → C2 16d → C3 9d（共 47 人日）→ v0.1.0。
- 基线：neo 1052 pass / 0 fail / 67 文件 + PTY 21/21（2026-10-28 实跑/evidence）。

## 文档

| 文档 | 内容 |
|---|---|
| [Matrix-Core v0 · PRD](docs/matrix-core-v0-prd.md) | 目标/非目标、边界、功能范围、验收 |
| [架构设计](docs/architecture.md) | 分层、事件模型、生命周期、持久化、失败/安全/测试策略 |
| [协议 v1.1](docs/protocol-v1.md) | WS/stdio 帧、命令、事件、快照、错误码、兼容规则 |
| [工作计划](docs/work-plan.md) | C0–C5 任务、验收、风险、排期 |
| [决策记录](docs/decisions.md) | D1–D15（独立仓库、移植、协议源、事件化、seq/epoch、审批 deadline、PathPolicy、脱敏、共存…） |
| [代码来源](docs/provenance.md) | 移植来源 commit、文件清单、已知差异 |
| [运维手册](docs/ops.md) | 运行/发现/目录/排障/共存/升级/安全清单 |
| [GUI 接入清单](docs/gui-integration.md) | 握手/兼容命令/协议差异/验收 |

## 快速了解

```
┌────────────┐   WS v1.1   ┌──────────────────────────────┐
│ GUI        │────────────▶│  Matrix-Core v0（单会话）     │
├────────────┤             │  Agent / tools / memory /     │
│ CLI（后续）│             │  mailbox / session / commands │
└────────────┘             └──────────────────────────────┘
```

- v0：一个进程 = 一个会话（无 TTY 可跑）。
- v0.5：本地 Hub（会话注册表 + 每会话 worker 子进程）。

## 工作流

- 计划中的闸门：`bun x tsc --noEmit && bun test && bun run e2e && bun run guards && bun run docs:check`，发布前 `bash scripts/verify.sh`。
- 协议判别名冻结（v1.1 只加不改）；客户端 vendor 协议 + fixtures conformance。
- 文档/Wiki 同步纪律见 [AGENTS.md](AGENTS.md) 与 `.neo/wiki/`。
