# neo-core-serve

neo 的核心运行时服务 —— 代号 **Matrix-Core**。

- 定位：从 neo CLI 中分离出来的**独立可运行**核心进程（agent 循环 / 工具 / 会话 / 记忆 / 信箱 / 命令），不依赖终端。
- 客户端：桌面工作台（`neo-agent-app`）先接入；CLI（`neo`）后续切换为客户端。
- 边界：本仓只做 core + serve + hub，不含 TUI、不含 GUI、不含云端多租户。
- 仓库纪律：core / CLI / GUI **三个仓库完全独立**，只以协议 + 文档 + fixtures 为契约（见 [决策 D1](docs/decisions.md)）。

## 状态

**v0.0.2 — 本地多会话 Hub**（`verify.sh` ALL GREEN；`bun test` **92 pass / 0 fail / 22 文件**；验收记录见 [docs/v0.0.2-acceptance.md](docs/v0.0.2-acceptance.md)）。

| 版本 | 主题 | 关键能力 |
|---|---|---|
| v0.0.1（已发布） | 单会话核心服务 | 无 TTY core、WS/stdio、协议 v1.1、持久化+锁、审批/提问、命令子集 |
| **v0.0.2（本版）** | **多会话 Hub + 安全/流控/附件** | PathPolicy、路径/命令/帧统一、WS 合批背压、`transcript.fetch`、`matrix-core hub`（每会话 worker）、图片附件、`commands.json` |

- 交付：`matrix-core hub [--port 0] [--dev-auth] [--cwd DIR]`；`session.list/create/attach/detach/close/rename`；PathPolicy（cwd + realpath + symlink）；WS 合批（16ms/4KB/64 帧）+ 队列 512 帧/8MB + 慢消费者 4408；`transcript.fetch`；`turn.send.attachments`（图片）。
- 不做（v0.0.3+）：CLI 接入、多客户端同会话、远程/TLS、非图片附件、`settings.patch` 写入、打包分发。
- 发布说明：[docs/release-notes/v0.0.2.md](docs/release-notes/v0.0.2.md)（v0.0.1 见 [v0.0.1](docs/release-notes/v0.0.1.md)）。
- 协议：**v1.2**（加性）；lock 7 文件，见 [protocol.lock.json](protocol.lock.json)。

## 安装与运行

> 要求 Bun ≥ 1.3。不做打包分发，直接以源码运行（用法以 `matrix-core help` 输出为准）。

```bash
bun install

# 版本
bun run src/main.ts version

# 单会话：stdio（测试 / 嵌入 / 无 TTY；stdout 只出协议帧）
bun run src/main.ts serve --stdio

# 单会话：WS（随机端口，写 ~/.neo/run/core.json）
bun run src/main.ts serve --cwd /path/to/project

# 多会话 Hub（GUI 联调用这个）：--dev-auth 打开本地登录端点
bun run src/main.ts hub --port 0 --dev-auth --cwd ~/projects
cat ~/.neo/run/core.json       # {url,pid,tokenFile,...}
curl -s http://127.0.0.1:<port>/health

# 生命周期
bun run src/main.ts status   # 读 core.json + pid 存活
bun run src/main.ts stop     # SIGTERM 优雅关闭（worker 收尾 → 释放锁 → 清理 core.json）
bun run src/main.ts doctor   # run 目录 / token / core.json 自检

# 命令目录（改动 core/commands/registry.ts 后必须重生成）
bun run commands:gen
```

配置：LLM/模型放 **`~/.neo/settings.json`**（GUI 联调推荐；查找顺序 `--cwd` 的 `settings.json` → 包根 → `~/.neo/settings.json`，取第一个存在的、不合并）。本地 `settings.json` 可能含明文 key，已被 `.gitignore` 忽略。

## 架构速览

```
                 ┌──────────────── matrix-core hub ─────────────────┐
 GUI ── WS ────▶ │  session.list/create/attach/close（Hub 不跑 Agent）│
                 │   ├─ worker: serve --stdio --cwd A（会话 A）      │
                 │   └─ worker: serve --stdio --cwd B（会话 B）      │
                 └──────────────────────────────────────────────────┘
 单会话：matrix-core serve [--stdio]  （v0.0.1 路径，协议不变）
```

- **Hub**：只做进程管理 + 帧转发；每会话一个 worker 子进程（stdout 只出协议帧，日志 stderr）。
- **worker**：就是 v0.0.1 的 `serve --stdio`，会话文件/transcript/锁语义不变。
- **协议**：同一套 WS v1.2；Hub 额外广告 `sessions` capability，`session.attach` 总是返回完整快照（历史用 `transcript.fetch`）。

## 已知限制（v0.0.2）

1. **同一 session 同时只允许一个客户端 attach**（第二个 → `conflict`）；换会话需先 `session.detach`。
2. **Hub 仅本地回环**：无远程/TLS/多租户。
3. **附件仅图片**（png/jpeg/webp）：每轮 ≤5 张、单张 ≤5MB；WS/stdio 帧上限 8MB；无剪贴板自动粘贴/拖拽通道/缩略图。
4. **worker 生命周期最小实现**：**无空闲回收、无自动重启/退避**；worker 崩溃后 Hub 向 attach 的客户端发 `session.status{dead}` 并解绑，需再次 `session.attach` 重新拉起（`--resume`）。Hub 退出时 worker 收到 SIGTERM；Hub 异常退出时 worker 因 stdin 关闭而自行收尾。
5. **`session.attach` 不做增量补齐**：v0.0.2 总返回完整快照；`lastSeq/epoch` 已接收、回放留待下版（`transcript.fetch` 可用于分页/回溯）。
6. **`session.close` = 停该会话 worker，不删会话文件**；再次 attach 会 `--resume` 重新拉起。
7. **PathPolicy 有已知窗口**：`resolveWrite` 校验后到实际写入之间目标可能被换成 symlink（v0.0.3 用 O_NOFOLLOW 收口）。
8. **未实现协议命令**：`settings.patch`（`unsupported`）、`session.export`、`checkpoint.*`、`command.cancel`、`peers.list`。
9. **平台**：macOS 实机验证；Windows/Linux 未实机验收。无打包分发。
10. **CLI 未接入**：`neo` 仓不改。

完整清单与未交付项见 [v0.0.2 验收清单](docs/v0.0.2-acceptance.md) §5/§8 与 [发布说明](docs/release-notes/v0.0.2.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [v0.0.2 验收清单](docs/v0.0.2-acceptance.md) | 范围/非目标、闸门、A–J 验收项、已知限制、上手、排障 |
| [v0.0.2 发布说明](docs/release-notes/v0.0.2.md) | 功能、协议 v1.2 增量、破坏性变更（无）、升级/回滚、未交付 |
| [GUI 联调指南 v0.0.2](docs/gui-integration-v0.0.2.md) | `~/.neo/settings.json`、`hub --dev-auth`、发现/握手、多会话、事件/seq、附件、联调 checklist |
| [v0.0.1 验收清单](docs/v0.0.1-acceptance.md) / [发布说明](docs/release-notes/v0.0.1.md) | 单会话基线 |
| [Matrix-Core v0 · PRD](docs/matrix-core-v0-prd.md) | 目标/非目标、边界、功能范围、验收 |
| [架构设计](docs/architecture.md) | 分层、事件模型、生命周期、持久化、失败/安全/测试策略 |
| [协议 v1.2](docs/protocol-v1.md) | WS/stdio 帧、命令、事件、快照、错误码、兼容规则 |
| [工作计划](docs/work-plan.md) | C0–C5 任务、验收、风险、排期 |
| [决策记录](docs/decisions.md) | D1–D15 |
| [协议冻结记录](docs/protocol-freeze.md) | v1.2 冻结范围、lock 哈希、变更流程 |
| [命令目录 schema](docs/commands-catalog.md) | `commands.json` 形状与单一来源规则 |
| [代码来源](docs/provenance.md) | 移植来源 commit、文件清单、已知差异 |
| [运维手册](docs/ops.md) | 运行/发现/目录/排障/共存/升级/安全清单 |

## 工作流（闸门）

```bash
bun x tsc --noEmit          # 类型
bun test                    # 单元 + 守卫 + e2e
bun run docs:check          # 协议 lock / commands.json / 文档链接 / 版本一致
bash scripts/verify.sh      # 四段合一（tsc → unit+guards → e2e → docs），证据落 docs/evidence/
```

- 发布前 `verify.sh` 必须 **ALL GREEN**；证据提交到 `docs/evidence/`。
- 协议判别名冻结（v1.x 只加不改）；改 `src/protocol/**` 后必须 `bun run freeze:protocol` 重写 lock。
- 改 `src/core/commands/registry.ts` 后必须 `bun run commands:gen`；`docs:check` 校验漂移。
- 文档/Wiki 同步纪律见 [AGENTS.md](AGENTS.md) 与 `.neo/wiki/`。
