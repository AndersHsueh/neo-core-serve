# 项目记忆 · neo-core-serve（Matrix-Core）

> 本文件是仓库级 AI 协作约定，随仓库提交。最后更新：2026-10-28。

## 概览

- 工作目录：`/Users/xueyuheng/research/000-alice-new/neo-core-serve`
- 定位：neo 的核心运行时服务（Agent / 工具 / 会话 / 记忆 / 信箱 / 命令），独立进程、无终端依赖。
- 状态：**v0.0.1（单会话核心服务，发布收尾）**。协议 v1.1 冻结；core 已移植 + session-host/protocol-io；serve（WS/stdio/dispatch/auth）已通；`verify.sh` ALL GREEN。验收记录见 `docs/v0.0.1-acceptance.md`。
- 上游：`neo` v0.4.3（源提交 `1da7c6f`，冻结中）、`neo-agent-app`（协议原型 `a52f1f0` + GUI）。
- 版本：`package.json` 与 `src/main.ts` 的 `CORE_VERSION` 必须同步；发布 tag `v0.0.1`。

## 基线（2026-10-28 实跑）

- `neo`：**1052 pass / 0 fail / 67 文件** + PTY 21/21（evidence）。`neo/tests/README.md` 的「1051/1」是旧口径。
- 本仓 v0.0.1：**48 pass / 0 fail / 12 文件 / 656 expect**（unit+guards 23 / e2e 25：stdio 13、WS 3、锁 1、allow-session 1、question 2、degraded 1、resilience 4）；tsc 0 error；`docs:check OK`（24 md / 6 协议文件）；`verify.sh` ALL GREEN；证据 `docs/evidence/v0.0.1-{tsc,unit,e2e,docs}.txt`。
- WS / 锁 / allow-session / 重连的自动化在 tester 补测中；po 已用仓库外冒烟脚本覆盖 WS 握手/health/token 权限/双开/attach epoch/status/stop。

## 结构

```
docs/                    PRD / 架构 / 协议 / 计划 / 决策 / provenance / ops / GUI 接入
  v0.0.1-brief.md        v0.0.1 实现简报（团队分工与验收口径）
  v0.0.1-acceptance.md   v0.0.1 验收清单（A–I 组 + 已知限制 + 未交付）
  release-notes/         版本发布说明（v0.0.1.md）
  v0.0.1-simplify.md     v0.0.1 代码审查清单（po 报告：P0/P1/P2 + 文件:行）
  evidence/              闸门证据（必须入库）
.neo/wiki/               项目知识库（wiki/ 随仓提交；outputs/ 忽略）
src/
  protocol/              纯数据：types/guards/fixtures/reducer/commands/index（冻结，改后须重冻 lock）
  core/                  会话运行时（移植自 neo + session-host 组合根 + protocol-io；ui/ 为 v0.0.1 兼容层）
  serve/                 ws.ts / stdio.ts / dispatch.ts / auth.ts / types.ts（HostPort 端口）
  main.ts                matrix-core serve|status|stop|doctor|version|help
scripts/                 verify.sh / docs-check / deps-scan / freeze-protocol / fake-llm
tests/                   guards（协议纯度/core 边界）/ unit（协议、seq/epoch、serve 契约）/ e2e（stdio、WS、锁、allow-session、question、degraded、resilience）
```

## 约定（必须遵守）

- **协议冻结 + lock**：`src/protocol/**` 的判别名不得重命名，只加可选字段/新事件/新命令。**改完必须 `bun run freeze:protocol` 重写 `protocol.lock.json`**，否则 `docs:check` 必红。
- **依赖单向**：`protocol` 零依赖；`serve` 可 import `core`+`protocol`；`main → serve`。
  - ⚠️ v0.0.1 例外：`src/core/**` 仍 import `src/core/ui/**`（agent/tools 移植遗留），「core 零 ui」尚未达成；v0.0.2 删除兼容层 + 守卫升级。**不要**再加新的 ui 依赖。
- **core 无终端**：禁 `process.stdout.isTTY`（改用注入的 `streaming`）、禁 `process.exit`（`main.ts` 白名单）、日志走注入 Logger / stderr。
- **seq/epoch**：core 分配 seq 并随 durable 事件持久化；epoch 标识 transcript 世代；attach 不匹配强制快照；ephemeral 不推进 seq。
- **单写者**：`run/locks/<id>/` + mailbox `.alive` 互认；路径从 id 重算，不信 `meta.path`。
- **安全默认**：目标态是「路径在 cwd 内 + symlink 解析（PathPolicy）」；**v0.0.1 尚未接入 PathPolicy**（已知缺口，v0.0.2 必做）。密钥只掩码；token 0600、目录 0700；`outputRef` 不透明。
- **stdout 纪律**：stdio 模式 stdout 只出帧；WS 模式日志只走 stderr/文件。
- **协议先行**：改行为先改 `docs/protocol-v1.md` + fixtures，再改代码；客户端按 `protocol.lock.json` 同步。
- **文档即契约**：PRD/架构/协议/计划/决策/发布说明任一变更同 commit 更新；`docs:check` 校验 lock/链接/版本一致。
- **Web/证据**：`bash scripts/verify.sh` ALL GREEN 才发布；证据写 `docs/evidence/`（**必须入库**，勿 ignore）。
- **.gitignore 约定**：忽略 `node_modules/ dist/ coverage/ *.tsbuildinfo .run/ .DS_Store settings.json *.local .env .neo/wiki/outputs/ .neo/wiki/.locks/ .neo/{backups,tmp,exports}/`；**不要忽略** `src/protocol/**`、`protocol.lock.json`、`tests/`、`scripts/`、`docs/evidence/`。本地 `settings.json` 可能含明文 key，用模板代替提交。
- **不跨仓依赖**：禁止 `file:`/workspace/submodule 指向 `neo`/`neo-agent-app`；接口只走协议。
- **Wiki 纪律**：里程碑/重要决策更新 `.neo/wiki/wiki/` 主题页 + `log.md`（append-only）；页头 `## 摘要` + `> 最后更新:YYYY-MM-DD`。

## 踩坑（评审与实作确认）

- **协议改了没重冻 lock**：v0.0.1 期间 `types/guards` 做了合法 v1.1 加法（sessionId 可选、`turn.abort.turnId`、`question.answer.keys/custom`），但没跑 `freeze:protocol` → `docs:check` 红。改协议 = 改代码 + 改 lock + 改文档，三件一起做。
- **错误码**：v0.0.1 已把 `question_expired`/`slow_consumer`/`unsupported` 加进 `HubErrorCode`（v1.1 加法）。但 **`serve/dispatch.ts` 的 `question.answer` 失败分支仍返回 `approval_expired`**（应 `question_expired`）——po 冒烟实测复现，待修。
- **WS 与 stdio 的帧构造有两条路径**：`serve/stdio.ts` 复用 `dispatch.eventFrame()`（会剥离事件体内的 seq），`serve/ws.ts` 仍内联拼帧（事件体内带 seq、`/health` 的 protocolVersion 硬编码 "1.1"、state 恒 "idle"）。改协议帧形状时两处都要改。v0.0.2 统一。
- **`sessions`/`usage` 双帧（已修）**：v0.0.1 曾对 `session.list`/`usage.summary` 同时推 kind 帧与 `result`；现已只回 `result.data`（协议 §3）。改动时别再引入第二种推送。
- **C0 不能直接搬 agent/tools**：`agent.ts` 依赖 `ui/stream|render|theme`，`tools/{types,askUser}` 依赖 `ui/askUser` → v0.0.1 妥协为复制 `ui/` 兼容层。清理顺序：先建 ports/DTO，再删 ui。
- **`core/ui` 只保留被 agent/tools 真正引用的部分**：收尾期已删 `console/toolLine/toolLog/transcript/hotkeys` 等无用复制；现存 `askUser/render/select/stream/theme`。删 `core/ui` 前先确认 `agent.ts`/`protocol-io.ts` 的 import 全部改为 ports。
- **版本号双源**：`package.json` 与 `src/main.ts CORE_VERSION` 必须同步 bump（`docs:check` 校验）；`verify.sh` 默认证据前缀 `v0.0.1`。
- **fake LLM 用 `PORT=0`**：`bun run scripts/fake-llm.ts` 打印 `FAKE_LLM_READY port=<n>`；e2e 必须读这行避免端口冲突；场景 `tool-then-answer|narration|ask-user|write-then-answer|slow|resume`。
- **`insideCwd` 定义了但从未调用**（neo 遗留）：read/write/edit/glob/list 可越出 cwd → v0.0.2 必须 PathPolicy 全量包裹 + 负样本测试。
- **脱敏必须早于持久化**：工具输出可能含 `.env`/key；先有 EventSink/logger 脱敏，再开 transcript。
- **`saveSession` 信任 `meta.path`**：损坏/陈旧会话可写到任意路径 → 本仓从 id 重算。
- **锁不互认**：core `run/locks` 与 neo mailbox `.alive` 是两套 → 必须互认，否则双开。
- **编译后 `import.meta.url` 推包根会错**：配置根按可执行文件/环境变量/参数解析。
- **工具注册表单例**：一进程一会话；多会话必须 worker（v0.0.2+）。
- **shell/PATH/locale**：继承 neo 的平台坑，测试固定 `LC_ALL=C`、临时 HOME/cwd，不碰真实 `~/.neo`。

## 当前状态

- 文档：PRD v0.3 / 架构 v0.3 / 协议 v1.1（已重冻）/ 计划 v0.3 / 决策 D1–D15 / provenance / ops / GUI 接入 / v0.0.1 验收清单 + 发布说明。
- 代码：`src/protocol`（冻结）、`src/core`（移植 + session-host + protocol-io + 单写者锁）、`src/serve`（ws/stdio/dispatch/auth）、`src/main.ts`（serve/status/stop/doctor/version/help）。
- 测试：unit+guards 23（协议契约/seq-epoch/serve 契约/守卫）；e2e 25（stdio 13 + WS 3 + 锁 + allow-session + question 2 + degraded 1 + resilience 4）。
- 发布收尾：版本已 bump `0.0.1`；剩余 tag `v0.0.1` 由 Lead 打。
- 下一步：v0.0.2（删 `core/ui`、快照移 serve、PathPolicy、脱敏边界、审批 liveness、WS 流控、Hub 设计）。

## 下一步候选

1. v0.0.2：ports/DTO 抽取 → 删 `src/core/ui/` → 守卫升级为 core 全域禁 ui；快照移 serve。
2. PathPolicy 全量接入 + 负样本测试（安全验收前置）；脱敏边界前移到 EventSink/persist。
3. 审批 liveness（deadline 滑动/断线宽限/`no_client`/diff）+ WS 合批/背压/4408。
4. Hub（v0.5）：会话注册表 + 每会话 worker；先补 `transcript.fetch`/`session.export`。
5. 打包：`bun build --compile` + 配置根解析 + doctor 完整版 + `matrix-core import`。
