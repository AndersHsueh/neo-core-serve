# 项目记忆 · neo-core-serve（Matrix-Core）

> 本文件是仓库级 AI 协作约定，随仓库提交。最后更新：2026-10-28。

## 概览

- 工作目录：`/Users/xueyuheng/research/000-alice-new/neo-core-serve`
- 定位：neo 的核心运行时服务（Agent / 工具 / 会话 / 记忆 / 信箱 / 命令），独立进程、无终端依赖。
- 状态：**v0.0.2（本地多会话 Hub，验收中）**。协议 **v1.2**（加性）已冻结；`matrix-core hub`（每会话 worker）+ PathPolicy + WS 合批/背压 + `transcript.fetch` + 图片附件 + `commands.json` 已落地；`verify.sh` 门禁以最终实跑为准。验收记录见 `docs/v0.0.2-acceptance.md`。
- 上游：`neo` v0.4.3（源提交 `1da7c6f`，冻结中）、`neo-agent-app`（协议原型 `a52f1f0` + GUI）。
- 版本：`package.json` 与 `src/main.ts` 的 `CORE_VERSION` 必须同步；发布 tag `v0.0.2`（上一 tag `v0.0.1`）。

## 基线

- `neo`：**1052 pass / 0 fail / 67 文件** + PTY 21/21（evidence）。
- 本仓 v0.0.1（已发布）：**48 pass / 0 fail / 12 文件**（unit+guards 23 / e2e 25）。
- 本仓 v0.0.2：**92 pass / 0 fail / 22 文件 / 1225 expect**（unit+guards 39 / e2e 53：stdio、WS、WS 合批、锁、allow-session、question、degraded、resilience、path-policy、attachments、transcript-fetch、commands-consistency、hub）；tsc 0 error；`docs:check OK`（31 md / 7 协议 / commands.json 一致）；`verify.sh` ALL GREEN；证据 `docs/evidence/v0.0.2-{tsc,unit,e2e,docs}.txt`。

## 结构

```
docs/                    PRD / 架构 / 协议 / 计划 / 决策 / provenance / ops / GUI 联调
  v0.0.1-* / v0.0.2-*    里程碑简报、验收清单、simplify 记录
  release-notes/         版本发布说明（v0.0.1.md / v0.0.2.md）
  gui-integration-v0.0.2.md  GUI 联调指南（Hub/多会话/附件/checklist）
  evidence/              闸门证据（必须入库）
.neo/wiki/               项目知识库（wiki/ 随仓提交；outputs/ 忽略）
src/
  protocol/              纯数据：types/guards/fixtures/reducer/commands/index + commands.json（冻结，改后须重冻 lock / 重生成目录）
  core/                  运行时：path.ts(PathPolicy) / paths.ts / commands/registry.ts / session-host / protocol-io / tools / memory / wiki / mailbox / env / ui(兼容层)
  serve/                 ws.ts / stdio.ts / frames.ts / batcher.ts / dispatch.ts / auth.ts / types.ts
  hub/                   server.ts（Hub WS + 会话路由）/ worker.ts（每会话 `serve --stdio` 子进程）
  main.ts                matrix-core serve|hub|status|stop|doctor|version|help
scripts/                 verify.sh / docs-check / gen-commands / freeze-protocol / fake-llm / deps-scan
tests/                   guards（协议纯度/core 边界）/ unit（协议、seq/epoch、serve 契约、路径、delta 快路径）/ e2e（stdio、WS、锁、allow-session、question、degraded、resilience、附件、transcript.fetch、路径、命令一致性）
```

## 约定（必须遵守）

- **协议冻结 + lock**：`src/protocol/**` 判别名不得重命名，只加可选字段/新事件/新命令；**改完必须 `bun run freeze:protocol` 重写 `protocol.lock.json`**，否则 `docs:check` 必红。当前 v1.2（7 文件）。
- **命令目录单表**：命令只写在 `src/core/commands/registry.ts`；help/未知命令/客户端面板全部派生；**改完必须 `bun run commands:gen`** 重生成 `src/protocol/commands.json`，`docs:check` 校验漂移。
- **PathPolicy 强制**：所有工具/refs/checkpoint undo/export 的文件路径必须经 `core/path.ts` 的 `resolveRead/resolveWrite`（cwd + realpath + symlink）；用户级目录（`~/.neo/skills|memory`、项目 wiki）是显式豁免。新增 fs 操作不走 PathPolicy = 安全回归。
- **依赖单向**：`protocol` 零依赖；`serve`/`hub` 可 import `core`+`protocol`；`main → serve/hub`。
  - v0.0.2 例外：`src/core/ui/**`（agent 的 stream/render/theme + askUser 类型）仍是兼容层；删它前先把 DTO/端口抽到 `core/ports.ts`。**不要**再加新的 ui 依赖。
- **core 无终端**：禁 `process.stdout.isTTY`（用注入 `streaming`）、禁 `process.exit`（`main.ts` 白名单）、日志走注入 Logger / stderr；守卫 `core-boundary.test.ts` 强制。
- **seq/epoch**：core 分配 seq 并随 durable 事件持久化；epoch 标识 transcript 世代；ephemeral 不推进 seq；`session.attach` v0.0.2 **总返回完整快照**（增量留待下版；历史用 `transcript.fetch`）。
- **Hub 单客户端/会话**：同一 session 同时只允许一个客户端 attach（第二个 → `conflict`）；换会话先 `session.detach`；`session.close` 只停 worker、**不删会话文件**（再 attach 走 `--resume`）。worker **无空闲回收/无自动重启**：崩溃后 Hub 发 `session.status{dead}` 并解绑，需再次 attach 重拉。
- **单写者**：`run/locks/<id>/` + mailbox `.alive` 互认；路径从 id 重算，不信 `meta.path`；Hub 不直接写会话文件（worker 写）。
- **WS 流控**：`serve/batcher.ts` 16ms/4KB/64 帧 flush、同 block delta 合并（保留最新 seq）；队列 512 帧/8MB；超限先丢 ephemeral，仍超 → 关闭 4408。帧上限 **8MB**（含附件）。
- **安全默认**：密钥只掩码；token 0600、目录 0700；`outputRef` 不透明；附件按 mime 三选一 + 数量/大小限制，超限 `too_large`。
- **stdout 纪律**：stdio 模式 stdout 只出帧；WS/Hub 日志只走 stderr；worker stdout = 协议帧。
- **协议先行**：改行为先改 `docs/protocol-v1.md` + fixtures，再改代码；客户端按 `protocol.lock.json` 同步。
- **文档即契约**：PRD/架构/协议/计划/决策/发布说明任一变更同 commit 更新；`docs:check` 校验 lock/命令目录/链接/版本一致。
- **证据**：`bash scripts/verify.sh` ALL GREEN 才发布；证据写 `docs/evidence/`（**必须入库**，勿 ignore）。
- **.gitignore 约定**：忽略 `node_modules/ dist/ coverage/ *.tsbuildinfo .run/ .DS_Store settings.json *.local .env .neo/wiki/outputs/ .neo/wiki/.locks/ .neo/{backups,tmp,exports}/`；**不要忽略** `src/protocol/**`（含 `commands.json`）、`protocol.lock.json`、`tests/`、`scripts/`、`docs/evidence/`。本地 `settings.json` 可能含明文 key，用模板/`~/.neo/settings.json` 代替提交。
- **不跨仓依赖**：禁止 `file:`/workspace/submodule 指向 `neo`/`neo-agent-app`；接口只走协议。
- **Wiki 纪律**：里程碑/重要决策更新 `.neo/wiki/wiki/` 主题页 + `log.md`（append-only）；页头 `## 摘要` + `> 最后更新:YYYY-MM-DD`。

## 踩坑（评审与实作确认）

- **协议改了没重冻 lock**：v1.1/v1.2 期间多次因为 `types/guards` 已改而 `protocol.lock.json` 未重写，`docs:check` 红。改协议 = 改代码 + 改 lock + 改文档，三件一起做。
- **命令目录与 help 漂移**：v0.0.1 的命令散在 switch/数组/help 三处；v0.0.2 收敛到 `registry.ts` 后，改命令必须 `commands:gen`，否则 `docs:check` 红。
- **`session.attach` 语义**：v0.0.2 实现**总是返回完整快照**（`lastSeq/epoch` 接收但不回放）；协议文档 v1.2 已同步。客户端不要等增量，用 `transcript.fetch`。
- **`transcript.fetch.fromSeq`**：实现 `e.seq >= from`（**含**）；协议文档 v1.2 已写「含」。改实现/改文档要同步，否则分页差一条。
- **Hub `session.list` 是磁盘摘要**：`title` 由 id 派生、`provider:""`、`tier:"default"`、`mode:"ask"`、运行中 `status:"working"`；GUI 选中后以 `session.attach` 的 `snapshot.meta` 为准。
- **Hub `session.close`**：只停 worker，会话文件保留；再 attach 会 `ensureWorker` 重新 `--resume` 拉起（不是 `not_found`）。
- **Hub 未绑定命令**：转发类命令优先用连接绑定 session；未绑定也可显式带 `sessionId`（v0.0.2 实现允许）；两者都没有 → `conflict`。
- **Hub 能力位**：单会话 `serve` 广告 8 项（v0.0.1 的 6 + `transcript.replay`/`attachments.image`）；Hub 额外 + `sessions`（9 项）。客户端按 capabilities 降级。
- **worker 只走 stdio 帧**：Hub 通过 `WorkerClient` 解析 worker stdout 帧；任何 worker 直接写 stdout 的非帧文本都会破坏 Hub（守卫/测试按 `nonJsonStdout` 思路防）。
- **合批影响客户端假设**：delta 会被合并（16ms/4KB/64 帧），不要断言逐 token/连续 seq；`*.end.text` 权威。
- **`core/ui` 只保留被 agent 真正引用的部分**：v0.0.1 收尾已删 `console/toolLine/toolLog/transcript/hotkeys`；现存 `askUser/render/select/stream/theme`。删 `core/ui` 前先抽 ports。
- **PathPolicy 写入窗口**：`resolveWrite` 校验后到实际写入之间目标可能被换成 symlink（已知，v0.0.3 用 O_NOFOLLOW）；不要把它当完整防护。
- **C0 不能直接搬 agent/tools**：`agent.ts` 依赖 ui，`tools` 依赖 ui/askUser → 兼容层妥协；清理顺序：先建 ports/DTO，再删 ui。
- **版本号双源**：`package.json` 与 `src/main.ts CORE_VERSION` 必须同步 bump（`docs:check` 校验）；`verify.sh` 默认证据前缀要跟版本走。
- **fake LLM 用 `PORT=0`**：`bun run scripts/fake-llm.ts` 打印 `FAKE_LLM_READY port=<n>`；e2e 必须读这行避免端口冲突；场景以 `scripts/fake-llm.ts` 文件头为准（含附件/allow-session）。
- **`insideCwd` 定义了但从未调用**（neo 遗留）：v0.0.2 已用 PathPolicy 全量包裹工具/refs/undo；新增 fs 操作必须走它。
- **脱敏必须早于持久化**：工具输出可能含 `.env`/key；先有 EventSink/logger 脱敏，再开 transcript。
- **`saveSession` 信任 `meta.path`**：损坏/陈旧会话可写到任意路径 → 本仓从 id 重算。
- **锁不互认**：core `run/locks` 与 neo mailbox `.alive` 是两套 → 必须互认，否则双开。
- **编译后 `import.meta.url` 推包根会错**：配置根按可执行文件/环境变量/参数解析。
- **工具注册表单例**：一进程一会话；多会话必须 worker（v0.0.2 Hub 即此方案）。
- **shell/PATH/locale**：继承 neo 的平台坑，测试固定 `LC_ALL=C`、临时 HOME/cwd，不碰真实 `~/.neo`。

## 当前状态

- 文档：PRD / 架构 / **协议 v1.2（已冻结）** / 计划 / 决策 / provenance / ops / GUI 联调 v0.0.2 / v0.0.2 验收清单 + 发布说明。
- 代码：`src/protocol`（v1.2 + `commands.json`）、`src/core`（PathPolicy、paths、commands registry、session-host、protocol-io）、`src/serve`（frames/batcher/dispatch/auth/ws/stdio）、`src/hub`（server + worker）、`src/main.ts`（serve/hub/…）。
- 测试：unit+guards 39 + e2e 53（PathPolicy 负样本、命令一致性、附件、transcript.fetch、ws 合批、hub 多会话）。
- 发布收尾：版本 `0.0.1 → 0.0.2` bump、verify 证据、tag `v0.0.2`（Lead 统一执行）。
- 下一步：与 `neo-agent-app` 联调（按 `docs/gui-integration-v0.0.2.md`）；v0.0.3 候选见下。

## 下一步候选

1. v0.0.3：`session.attach` 增量回放（transcript.replay 真正可用）、附件 O_NOFOLLOW、审批 liveness（滑动/宽限/no_client/diff）、`settings.patch`、`session.export`/`checkpoint.*`。
2. 多客户端租约/协作（v0.5+）、Hub 观测（结构化日志/指标/完整 doctor）。
3. 打包分发：`bun build --compile` + 配置根解析 + `matrix-core import`。
4. GUI 联调反馈回路：协议 conformance（vendored lock + commands.json）、错误码/降级补齐。
