# Matrix-Core 工作计划（v0 → v0.5）

> 状态：draft v0.3 · 2026-10-28
> 目标：把 neo 的核心运行时做成**独立仓库、独立进程、独立协议**的 Matrix-Core。
> 范围：只做本地单用户。云端/远程/多租户/CLI 切换不在本项目内（另立）。
> 估算：单人全职、按 neo 现有测试强度；±40%。**v0（C0–C3）约 47 人日（≈9–10 周）**，v0.5 约 15 人日。

---

## 0. 完成定义（DoD）

1. 功能验收条目全过（§3）。
2. `bash scripts/verify.sh` 全绿：tsc → 单元/契约/集成 → e2e → guards；证据落 `docs/evidence/`。
3. 文档同步：PRD/架构/协议/计划/决策受影响部分已更新；wiki 页 + `log.md` 已刷新。
4. 无隐性债务进入下一阶段（显式登记延后项除外）。
5. 所有新增跨进程/持久化代码都有：失败路径测试 + 脱敏检查 + 路径约束测试。

---

## 1. 基线（先核，再动手）

| 项 | 值 | 来源 |
|---|---|---|
| neo 源提交 | `1da7c6f`（v0.4.2-4，v0.4.3 收尾，未打 tag） | `git log` |
| 单测 | **1052 pass / 0 fail / 67 文件**（2026-10-28 实跑 14.46s） | `bun test` |
| PTY | 21/21 | `docs/evidence/v0.4.3-pty.txt` |
| 已知失败 | **无**（`tests/README.md` 写的 1051/1 是旧口径，已过时） | 实跑 + evidence |
| 协议原型 | `neo-agent-app` `a52f1f0`，`gui/src/protocol/` | git log |

> 动作：C0 第一步把上表写入 `docs/evidence/baseline.txt`；之后 core 的 CI 只比较**自己的**数字，不依赖 neo 的闸门。

---

## 2. 里程碑

| 里程碑 | 内容 | 出口 | 估算 |
|---|---|---|---|
| **C0 协议冻结 + 骨架** | 冻结 v1.1、抽出 reducer/fixtures、命令目录 schema、工程骨架 | protocol 单测绿；四份文档一致 | 3d |
| **C0b 纯核心移植** | 只搬**无 ui 依赖**的模块与测试；守卫第一层 | tsc + 纯核心测试绿 | 4d |
| **C1 端口与事件化** | ports、tools 解耦、agent 事件化、组合根、命令层、golden | 无 TTY 进程内完整一轮 + 命令黄金样本 | 15d |
| **C2 协议与服务** | serve/WS/stdio、session shims、持久化/锁/恢复、e2e、conformance harness | PRD 验收 1–8；A9 机械通过；GUI smoke | 16d |
| **C3 硬化与发布** | 混沌、打包/停止/状态、安全、文档、v0.1.0 | verify ALL GREEN + tag | 9d |
| **C4 本地 Hub v0.5** | 注册表 + worker 池 + `session.*` 全量 | GUI 多会话；worker 崩溃恢复 | 15d |
| **C5 CLI 切换**（另立） | CLI 纯客户端化 | CLI 不再内嵌 runtime | 10d+ |

**关键路径**：C0 → C0b → C1 → C2 → C3。C2 可并行外仓 GUI 适配（3–5d）、C3 打包。
**v0 = 3+4+15+16+9 = 47 人日**（约 9–10 周）；不会再出现「4 天 C0」这种跨不过编译的估算。

---

## 3. 阶段任务

### C0 · 协议冻结 + 骨架（3d）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| C0.1 | 基线固化：把 §1 数字写入 `docs/evidence/baseline.txt`；记录 neo/协议源 commit；跑**传递依赖扫描**（含 system-prompt → tools → ui 这类间接依赖） | evidence + `scripts/deps-scan.ts` | 可复跑 |
| C0.2 | 协议抽取：从 `neo-agent-app` 复制 types/guards/fixtures；从 `gui/src/state/session.ts` **提取纯 `applyEvent`** 到 `protocol/reducer.ts`（禁止 `Date.now()`：`error.blockId/at`、`question.resolve.at` 由事件提供）；补 reducer fixtures（固定时钟） | `src/protocol/**` | protocol 单测绿（正/坏样本 + reducer 确定性） |
| C0.3 | 协议冻结评审：按 `protocol-v1.md` §1 冻结判别名；`commands.json` schema + 生成器设计；文档一致性（PRD/架构/协议/计划 同一 commit） | 冻结记录 + 四文档 diff | 无重命名/无第二套命令 |
| C0.4 | 工程骨架：`package.json`(bun)、`tsconfig`、`.gitignore`、`scripts/verify.sh`、目录占位 | 可 `tsc`/`test` 的空项目 | 空跑绿 |
| C0.5 | provenance 修订：补 `sessionName/sessionExport/input/references` 的处置（移植/重写/延后）；删除不存在的假设（如 `scripts/probe`） | `provenance.md` | 清单与代码一致 |
| C0.6 | CI 与 docs:check 最小版：基线比对、协议 lock、`commands.json` **schema**（C1.7 前允许不存在）、文档互链 | `scripts/verify.sh`、`scripts/docs-check.ts` | 故意违规变红 |

**验收 C0**：protocol 单测绿；四份文档一致；命令目录 schema 定稿；provenance 无虚构。

---

### C0b · 纯核心移植（4d）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| C0b.1 | 依赖闭包扫描：脚本列出每个 src 模块是否 import `ui/tui/input/index`；生成「纯模块清单」 | `scripts/deps-scan.ts` + 报告 | 清单可复跑 |
| C0b.2 | 只移植纯模块：llm/config/classifier/memory/wiki/mailbox/env/skills/session/checkpoint/shell/contextWindow/turnDiagnostics/maintenance/runtimeTmp（**不含** agent/tools/task/askUser） | `src/core/**` | tsc 绿 |
| C0b.3 | 测试移植：只搬纯模块测试（用 C0b.1 过滤；排除 agent/tools/index spawn/ui 依赖） | `tests/**` | 测试绿，数量记录 |
| C0b.4 | 守卫第一层：core 纯模块禁 import ui/tui/input；protocol 零依赖；stdout/exit 禁令（agent/tools 豁免到 C1） | `tests/guards/imports.test.ts` | 故意违规红 |

**验收 C0b**：tsc 绿；纯核心测试绿；守卫红/绿证据；**不复制 agent/tools**（避免编译不过）。

---

### C1 · 端口与事件化（15d）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| C1.1 | ports/DTO：`Clock/Timer/Random/IdGen/Logger/PathPolicy/ApprovalPort/QuestionPort/EventSink`；`AskUserRequest/Answer` 从 `ui/askUser` 迁入 `core/ports.ts` | `core/ports.ts` | 无 ui 引用 |
| C1.2 | 路径策略：`PathPolicy`（realpath + symlink + 前缀）包裹所有 fs/refs/save/export/undo；**修 neo 的 `insideCwd` 只定义未使用**问题 | `core/path.ts` + 负样本测试 | 逃逸用例全拒 |
| C1.3 | 脱敏边界：`EventSink`/persist 写前脱敏（args/output/error/工具结果）；目录 0700、文件 0600；测试扫描 `sk-…`/token | `core/redact.ts` | 扫描零命中 |
| C1.4 | tools 解耦：`ToolOutcome{output,ok,truncated,outputRef,diff}`；注册表/dispatch 去 ui；`outputRef` 不透明 id + TTL | `core/tools/**` | tool 测试绿 |
| C1.5 | Agent 事件化：去 ui/render/theme/isTTY；delta/end.text 权威；审批/提问走 port；子代理 `subagent` 标记 + notice 节流 | `core/agent/**` | 单测 + golden |
| C1.6 | 组合根：`createSession({cwd,mode,tier,resume,ports})`；`loadConfig({cwd})`（修 process.cwd 依赖）；锁/心跳/mailbox 顺序 | `core/session/**` | 无 TTY 起会话 |
| C1.7 | 命令层：`Command`/`CommandContext`/`CommandOutcome`+**领域块 CommandBlock**；迁移 34 个行为；交互改 question/approval；`commands.json` 生成器 + 漂移守卫；开启 docs:check 的 catalog 存在性 | `core/commands/**` | 命令黄金样本 + catalog 绿 |
| C1.8 | fake-LLM 模块化 + probe 客户端；golden：clock/id/random 注入，同输入同事件序列 | `tests/golden/**` | 确定性通过 |

**验收 C1**：无 TTY 进程内完整一轮（流式/工具/审批/提问/命令/compact）；golden 稳定；core 零 ui 依赖；守卫全量激活。

---

### C2 · 协议与服务（16d）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| C2.1 | serve 映射：CoreEvent→SessionEvent（透传 seq/epoch）、CommandOutcome→ViewBlock；合批/背压/角色 | `serve/mapping.ts`、`host.ts` | 契约测试 |
| C2.2 | WS/stdio/auth：token、Origin、`--dev-auth`、`/health`、4401/4408；`core.json` 原子写 + 单实例 | `serve/**`、`main.ts` | A1/A9 部分 |
| C2.3 | session shims：list/create/attach/detach/rename/close；settings.get 映射；settings.patch(unsupported)；usage.summary 空；mode.set | `serve/commands/**` | GUI 启动链可跑 |
| C2.4 | 持久化：transcript(header/epoch/seq)、turn.start{msgCount}、messages 原子写、轮末对账、崩溃修复、torn line、陈旧 transcript 重建算法 | `core/persist/**` | A6/A7 |
| C2.5 | 锁与共存：`run/locks/<id>/` + 与 neo CLI mailbox `.alive` 互认；`.alive` 缺失时用 session 文件 mtime/hash 检测外部写入；路径从 id 重算；日志分区；maintenance 边界 | `core/session/lock.ts`、ops 文档 | 双开/接管/清理 |
| C2.6 | 审批/提问 RPC：注入 Timer；owner 在线滑动 deadline、断线宽限、无客户端立即收敛；`by` 全枚举；allow-session 仅写文件 | `serve/approvals.ts` | A3/A4 |
| C2.7 | e2e：stdio 完整轮/审批/提问/abort/重连/崩溃；**in-repo GUI conformance harness**（fixtures + dummy 场景 + reducer 一致性）；GUI 手工 smoke 仅作补充 | `tests/e2e/**` | A2/A5/A6/A9（机械） |
| C2.8 | **GUI 适配（外仓，并行）**：guards 放未知事件、ready/user、seq 追踪、dev 登录、mode、snapshot.live、命令 catalog 同步 | `neo-agent-app` 改动清单 | GUI 启动 + 单会话 |
| C2.9 | 导入/迁移：备份、只读导入旧会话、`matrix-core import`；旧 CLI 与 core 交替使用的对账 | `main.ts import` | 老会话可开 |

**验收 C2**：PRD §8 的 1–8；GUI 单会话联调；kill -9 恢复；双开拒绝；旧会话可读。

---

### C3 · 硬化与发布（9d）

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| C3.1 | 混沌：断线/慢读/kill -9/磁盘只读/超大输出/时钟跳变/epoch 不匹配 | `scripts/chaos` | 全过 |
| C3.2 | 打包与进程管理：`bun build --compile`、bin、`stop/status`、`core.json` pid 校验、编译后配置根修复 | `dist/`、`main.ts` | 干净容器 quick start |
| C3.3 | 安全评审：token/Origin/路径/脱敏/outputRef/日志；fuzz 协议 | 检查表 + 测试 | 无高危 |
| C3.4 | 观测：结构化日志、doctor、health、事件回放 | `core/logging`、`main.ts` | 排障演练 |
| C3.5 | 文档发布：architecture/protocol/PRD 定稿、ops 手册、release notes v0.1.0、wiki 刷新、tag | docs + tag | verify ALL GREEN |
| C3.6 | soak：8h 长会话（fake-LLM 循环 + 定时工具）记录 RSS/句柄/transcript 增长；阈值超限即修 | `scripts/soak.ts` + 报告 | RSS 增长 < 20% |

**验收 C3**：混沌全过；干净机器可跑；v0.1.0 tag 已推；证据齐全；wiki log 有 milestone。

---

### C4 · 本地 Hub v0.5（15d）

| ID | 任务 | 产出 | 估算 |
|---|---|---|---|
| C4.1 | 会话注册表（id/cwd/state/lastActive，原子写） | `hub/registry.ts` | 2d |
| C4.2 | worker 池：spawn/健康/空闲回收/崩溃重启；stdout 协议、日志 stderr | `hub/pool.ts`、`worker/main.ts` | 4d |
| C4.3 | `session.*` 全量 + WS 多路复用 + attach/detach/close | `hub/**` | 3d |
| C4.4 | attach 磁盘旧会话 = spawn+resume；单写者校验；孤儿回收 | `hub/**` | 2d |
| C4.5 | Hub 混沌：worker 崩溃/端口占用/僵尸/磁盘满 | tests | 2d |
| C4.6 | GUI 多会话联调 + 租约（owner/observer） | 联调记录 | 2d |

**验收 C4**：GUI 列出/创建/切换会话；两会话并行；kill worker 恢复；Hub 崩溃后会话可恢复。

---

### C5 · CLI 切换（另立，10d+）

- neo 仓把 CLI 改为纯客户端：连接本地 core（`~/.neo/run/core.json`）；缺失时提示/spawn。
- 纯客户端化前必备：`transcript.fetch`、`checkpoint.*`、`session.export`、`output.get`、附件/图片、`command.cancel`、`peers.list`。
- CLI 的 TUI 保留；删除内嵌 runtime。
- 独立排期，不计入 v0。

---

## 4. 验收矩阵

| # | 场景 | 阶段 |
|---|---|---|
| A1 | 无 TTY 启动 + ready/health | C2 |
| A2 | 一轮：流式/思维链/工具/stats/落盘 | C1/C2 |
| A3 | 审批 allow/deny/timeout/no-client；滑动 deadline | C2 |
| A4 | 提问 单选/多选/自定义/取消 | C2 |
| A5 | 命令 tier/clear/compact/context + 结构化结果 + session.cleared | C1/C2 |
| A6 | 断线重连 + abort 一致性 + epoch 检查 | C2 |
| A7 | 崩溃恢复（kill -9）+ 旧会话兼容 + torn line | C2/C3 |
| A8 | 守卫：import/stdout/exit/单写者/catalog/脱敏/路径 | C0b/C1/C3 |
| A9 | GUI 启动链 + 单会话：**conformance harness 绿**（外仓手工 smoke 仅补充） | C2 |
| A10 | GUI 多会话 + worker 崩溃恢复 | C4 |

> 外部 neo 闸门不在 core CI 里跑；core 只保证「不改 neo」+ 基线记录。A9 的出口是 core 仓的 **conformance harness**（fixtures + dummy 场景 + reducer 一致性）；GUI 仓的 e2e/手工 smoke 只作补充。

---

## 5. 闸门与证据

```bash
bun x tsc --noEmit
bun test
bun run e2e        # stdio 端到端
bun run guards     # 边界/纪律/脱敏/路径
bun run docs:check # 文档/命令目录/协议 lock 一致性
bash scripts/verify.sh
```

证据：`docs/evidence/<version>-{tsc,tests,e2e,guards,docs}.txt`；发布 tag 前 ALL GREEN。

---

## 6. 风险登记

| ID | 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|---|
| R1 | 移植带入隐性 UI 依赖，C0 编译不过 | 高 | 高 | C0b 只搬纯模块；agent/tools 到 C1；依赖扫描先行 |
| R2 | 协议与 GUI 对不齐，联调拖延 | 高 | 高 | C0 冻结判别名；fixtures 双向；GUI 适配单独 workstream（3–5d） |
| R3 | 两仓独立导致双份代码漂移 | 中 | 高 | neo 冻结；bug 只在本仓；wiki 记录 cherry-pick；C5 尽快 |
| R4 | transcript 膨胀/写放大 | 中 | 中 | 只落 durable；30 天/大小滚动；cleanup 与 CLI 互斥 |
| R5 | 慢客户端内存增长 | 中 | 中 | 队列上限 + delta 合并 + 4408 |
| R6 | 锁残留/双写/旧 CLI 不认 core 锁 | 高 | 中 | 锁契约（与 mailbox .alive 互认）+ pid 校验 + 启动自检 + 双开测试 |
| R7 | 密钥进入 transcript/日志 | 高 | 中 | C1.3 边界脱敏（先于持久化）；测试扫描；目录 0700 |
| R8 | 路径逃逸（neo 现有 insideCwd 未调用） | 高 | 高 | C1.2 PathPolicy 全量包裹 + 负样本测试；C3 复核 |
| R9 | 打包/编译后配置根失效（import.meta.url/pkgRoot） | 中 | 高 | C3.2 编译测试；配置根按「可执行文件目录/环境变量/显式参数」优先 |
| R10 | Hub worker 生命周期复杂（僵尸/端口/信号） | 中 | 中 | C4 混沌周；先单会话稳定 |
| R11 | Windows 平台差异 | 中 | 低 | v0 不做；与 neo PD-1 一起排期 |
| R12 | 文档/协议再次分叉 | 中 | 中 | `docs:check` 闸门（协议 lock/命令目录/链接）+ 同 PR 更新纪律 |

---

## 7. 文档与 wiki 同步

**事实源层级**：PRD（范围）→ architecture（设计）→ protocol（线格式）→ work-plan（排期）→ decisions（ADR）→ wiki（知识沉淀）。

规则：

- 行为/协议变更：同 PR 更新对应文档；`docs:check` 失败即阻断。
- 每个里程碑：更新 wiki 主题页 + `log.md`；页头 `## 摘要` + `> 最后更新:YYYY-MM-DD`。
- `raw/` 只读；主题页重写为当前最优综述；历史进修订记录。
- 发布 tag 同步 release notes。

---

## 8. 启动清单（C0 开工前）

- [ ] 确认基线：1052/0/67（实跑）+ PTY 21/21（evidence）写入 `baseline.txt`
- [ ] 确认移植源 commit：neo `1da7c6f`、app `a52f1f0`
- [ ] 冻结 v1.1 判别名（本任务 C0.3）
- [ ] 确定 `matrix-core` bin/端口/token/core.json 路径
- [ ] 与 GUI 侧约定联调方式（dev 登录 endpoint / token 注入）
- [ ] 建立 `.neo/wiki` 骨架与首批页面（已完成）
- [ ] 建立 `docs:check` 最小版本（协议 lock、命令目录、文档链接）

---

## 9. 排期视图

```
Week 1      C0 ███  C0b ████
Week 2-4    C1 ███████████████
Week 5-7    C2 ████████████████   （C2.8 GUI 适配并行）
Week 8-9    C3 █████████
Week 10-12  C4 ███████████████
Week 13+    C5（另立）
```
