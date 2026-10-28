# neo-core-serve

neo 的核心运行时服务 —— 代号 **Matrix-Core**。

- 定位：从 neo CLI 中分离出来的**独立可运行**核心进程（agent 循环 / 工具 / 会话 / 记忆 / 信箱 / 命令），不依赖终端。
- 客户端：桌面工作台（`neo-agent-app`）先接入；CLI（`neo`）后续切换为客户端。
- 边界：本仓只做 core + serve，不含 TUI、不含 GUI、不含云端多租户。
- 仓库纪律：core / CLI / GUI **三个仓库完全独立**，只以协议 + 文档 + fixtures 为契约（见 [决策 D1](docs/decisions.md)）。

## 状态

**v0.0.1 — 单会话核心服务**（发布收尾：`verify.sh` ALL GREEN，验收记录见 [docs/v0.0.1-acceptance.md](docs/v0.0.1-acceptance.md)）。

- 交付：无 TTY 可运行的 core 进程；WS（`/ws` + `/health` + 本地 token）与 stdio 传输；协议 v1.1；持久化（messages + transcript + epoch/seq）+ 会话锁；审批/提问；命令子集；fake LLM e2e（25 个：stdio/WS/锁/allow-session/提问多选/旧会话重建/中断恢复；`bun test` 共 48 pass / 0 fail / 12 文件）。
- 不做（v0.0.2+）：多会话 Hub / worker 池、附件、`transcript.fetch`/`output.get`/`checkpoint.*`/`session.export`、Windows、远程/云。
- 发布说明：[docs/release-notes/v0.0.1.md](docs/release-notes/v0.0.1.md)。
- 协议 lock：6 文件（types/guards/fixtures/reducer/commands/index），见 [protocol.lock.json](protocol.lock.json)。

## 安装与运行

> 要求 Bun ≥ 1.3。v0.0.1 不做打包分发，直接以源码运行（用法以 `matrix-core help` 输出为准）。

```bash
bun install

# 版本
bun run src/main.ts version

# stdio 模式（测试 / 嵌入 / 无 TTY；stdout 只出协议帧）
bun run src/main.ts serve --stdio

# WS 模式：随机端口，写 ~/.neo/run/core.json（url/pid/tokenFile/sessionId/epoch）
bun run src/main.ts serve --cwd /path/to/project
cat ~/.neo/run/core.json
curl -s http://127.0.0.1:<port>/health

# 生命周期
bun run src/main.ts status   # 读 core.json + pid 存活
bun run src/main.ts stop     # SIGTERM 优雅关闭（abort → flush → persist → 释放锁）
bun run src/main.ts doctor   # run 目录 / token / core.json 自检

# 可选：链接成全局命令 matrix-core
bun link
```

同一 session 同时只能有一个 core（`~/.neo/run/locks/<id>/`），重复启动返回 `conflict`。

常用参数（详见 [ops.md](docs/ops.md)）：

| 参数 | 说明 |
|---|---|
| `--cwd <dir>` | 会话工作目录（工具与命令的路径基准） |
| `--resume <id>` | 恢复已有会话（messages + transcript 对账） |
| `--port 0` | 监听端口；默认 0 = 随机，只绑 `127.0.0.1` |
| `--stdio` | 行分隔帧，不监听端口 |
| `--mode ask\|auto-edit\|auto-all\|plan` | 权限模式 |
| `--tier default\|balanced\|fast\|deep_reasoning` | 模型档位 |
| `--token-file <path>` | 覆盖 token 文件（默认 `~/.neo/run/core.token`） |
| `--dev-auth` | 允许本地 HTTP dev 登录（默认关；仅回环 + Origin 白名单） |

本地 LLM 配置放 `settings.json`（含 API key，**已被 `.gitignore` 忽略，勿提交**）；不配也可用 fake LLM 跑测试。

## 已知限制（v0.0.1）

1. **单会话**：一进程 = 一会话；无 Hub、无会话注册表（多会话语义在 v0.0.2+）。
2. **无附件/图片**：`turn.send` 只接受 text。
3. **`core/ui` 兼容层保留**：移植的 `agent/tools` 仍依赖 `src/core/ui/*`，「core 零 ui 依赖」在 v0.0.1 未完全达成，v0.0.2 清理。
4. **部分协议命令未实现**：`command.cancel`、`transcript.fetch`、`output.get`、`checkpoint.*`、`session.export`、`peers.list`；`session.close`、`settings.patch`、`auth.*` 返回 `unsupported`。
5. **审批简化**：allow-session 只对 `write_file/edit_file` 记忆（shell 永不）；**没有**断线宽限/`no_client`/deadline 滑动续期，只按固定超时收敛（默认 120s，`MATRIX_CORE_APPROVAL_TIMEOUT_MS` 可注入）；审批不带 `diff`。
6. **WS 无合批/背压**：协议 §9 的 16ms/4KB 合批与 4408 慢消费者断开未实现（v0.0.2）。
7. **`session.attach` 总是返回完整快照**：不按 `lastSeq` 补齐增量，capabilities 不广告 `transcript.replay`。
8. **快照在 host 生成**：`core` 运行时 import `protocol/reducer`（架构 §5.4 要求由 serve 生成），v0.0.2 移回 serve。
9. **崩溃恢复保守**：半轮一律补 `turn.aborted{crash}`，不补 `stats`。
10. **`matrix-core import`、`--force` 接管、doctor 完整自检**：未交付（v0.0.2）；单实例依靠会话锁。
11. **用量空计量**：`usage.costMicros = 0`（客户端显示「未计价」）。
12. **无打包**：未做 `bun build --compile` 单文件分发；仅 `bun run` / `bun link`。
13. **平台**：仅 macOS 实机验证；Windows 不支持，Linux 未实机验收。
14. **恢复粒度**：以轮为单位，不承诺 fsync 级持久性。

完整清单与未交付项：[验收清单](docs/v0.0.1-acceptance.md) §2/§5/§8。

## 文档

| 文档 | 内容 |
|---|---|
| [v0.0.1 验收清单](docs/v0.0.1-acceptance.md) | 范围/非目标、闸门、A–I 组验收项、已知限制、上手、排障 |
| [v0.0.1 发布说明](docs/release-notes/v0.0.1.md) | 功能、协议、架构偏差与 v0.0.2 清理计划、升级/回滚 |
| [Matrix-Core v0 · PRD](docs/matrix-core-v0-prd.md) | 目标/非目标、边界、功能范围、验收 |
| [架构设计](docs/architecture.md) | 分层、事件模型、生命周期、持久化、失败/安全/测试策略 |
| [协议 v1.1](docs/protocol-v1.md) | WS/stdio 帧、命令、事件、快照、错误码、兼容规则 |
| [工作计划](docs/work-plan.md) | C0–C5 任务、验收、风险、排期 |
| [决策记录](docs/decisions.md) | D1–D15（独立仓库、移植、协议源、事件化、seq/epoch、审批 deadline、PathPolicy、脱敏、共存…） |
| [协议冻结记录](docs/protocol-freeze.md) | v1.1 冻结范围、lock 哈希、变更流程 |
| [命令目录 schema](docs/commands-catalog.md) | commands.json 形状与单一来源规则 |
| [代码来源](docs/provenance.md) | 移植来源 commit、文件清单、已知差异 |
| [运维手册](docs/ops.md) | 运行/发现/目录/排障/共存/升级/安全清单 |
| [GUI 接入清单](docs/gui-integration.md) | 握手/兼容命令/协议差异/验收 |

## 快速了解

```
┌────────────┐   WS v1.1   ┌──────────────────────────────┐
│ GUI        │────────────▶│  Matrix-Core v0.0.1（单会话） │
├────────────┤             │  Agent / tools / memory /     │
│ CLI（后续）│             │  mailbox / session / commands │
└────────────┘             └──────────────────────────────┘
```

- v0.0.1：一个进程 = 一个会话（无 TTY 可跑）。
- v0.0.2+：本地 Hub（会话注册表 + 每会话 worker 子进程）。

## 工作流（闸门）

```bash
bun x tsc --noEmit          # 类型
bun test                    # 单元 + 契约 + e2e
bun run docs:check          # 协议 lock / 文档链接 / 版本一致
bash scripts/verify.sh      # 四段合一（tsc → unit+guards → e2e → docs），证据落 docs/evidence/
```

- 发布前 `verify.sh` 必须 **ALL GREEN**；证据提交到 `docs/evidence/`。
- 协议判别名冻结（v1.1 只加不改）；改 `src/protocol/**` 后必须 `bun run freeze:protocol` 重写 lock，否则 `docs:check` 会红。
- 文档/Wiki 同步纪律见 [AGENTS.md](AGENTS.md) 与 `.neo/wiki/`。
