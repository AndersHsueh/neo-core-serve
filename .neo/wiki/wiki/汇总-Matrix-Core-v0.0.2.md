# 汇总-Matrix-Core-v0.0.2

> 最后更新:2026-10-29

## 摘要

2026-10-28 会话完成 **Matrix-Core 从 0 到 v0.0.2 的两次发布**：先建独立仓 `neo-core-serve` 并冻结协议 v1.1、交付可独立运行的单会话核心 **v0.0.1**（48 tests）；随后按 v0.0.2 范围完成 **PathPolicy / 三处统一 + delta 快路径 / WS 合批·背压 + transcript.fetch / 本地多会话 Hub + 每会话 worker / 图片附件**，协议升 **v1.2**、测试 **92 pass / 0 fail**，发布 **v0.0.2**。最终指针：`47bd5ef`（main + tag `v0.0.2`），`verify.sh` ALL GREEN，未接 CLI、未改 `neo` 仓。本页是一次会话级汇总，细节以 `docs/` 与 [[发布-v0.0.1]]/[[发布-v0.0.2]] 为准。

## 时间线（2026-10-28）

| 阶段 | 结果 |
|---|---|
| 设计/评审 | PRD/架构/协议/计划/决策/迁移文档成型；3 轮评审修正协议判别名、seq 双主、崩溃一致性、审批 deadline、路径逃逸、C0 编译等问题；拆 C0/C0b |
| C0 | 协议 v1.1 冻结（6 文件 lock）、reducer 从 GUI 抽取、骨架 + docs:check、13 契约测试 |
| v0.0.1 | 单会话 core（WS/stdio、锁、恢复、审批/提问、命令子集），48 tests，tag `v0.0.1` |
| v0.0.2 实现 | PathPolicy、paths/命令注册表/frames 统一、delta 快路径、WS EventBatcher、transcript.fetch、Hub+worker、图片附件、commands.json 生成 |
| simplify | reuse/quality/efficiency 三路 reviewer 共 33 条；HIGH 全修（悬空 symlink、Hub owner 悬空、并发 attach、batcher 记账、too_large id、Hub cwd 等） |
| 收尾 | 文档校正（版本状态/验收记录/证据 31 md），tag `v0.0.2` 移到 `47bd5ef`；92 pass / 0 fail |

## 交付物

- **代码**：`src/core/**`（协议源、SessionHost/ProtocolIO、PathPolicy、命令注册表、附件）、`src/serve/**`（WS/stdio、dispatch、frames、batcher、auth）、`src/hub/**`（server/worker）、`src/main.ts`。
- **协议**：v1.2，7 文件 lock（含 `commands.json`），`bun run freeze:protocol` / `commands:gen`。
- **测试**：92 tests / 22 文件（unit+guards 39、e2e 53；0 skip）；证据 `docs/evidence/v0.0.2-{tsc,unit,e2e,docs}.txt`。
- **文档**：PRD/架构/协议/计划/验收/release notes/simplify/GUI 联调指南/ops/README/AGENTS。
- **发布**：`v0.0.1`（`2e7257e` 系列）、`v0.0.2`（功能 `0eca093`；最终 `47bd5ef`），Gitee `andershsueh/neo-core-serve`（私有）。

## 关键决策

- **三仓独立**：`neo`（CLI，冻结）/ `neo-core-serve`（核心服务）/ `neo-agent-app`（GUI）；禁止跨仓代码依赖，协议源放 core，文档/wiki 保持一致。
- **协议只做加法**：事件判别名冻结；v1.2 增 attachments/transcript.fetch/too_large/8MB 帧/capabilities；`commands.json` 由注册表单源生成。
- **单写者 + 对账**：`run/locks/<id>` 与 mailbox `.alive` 互认；messages 原子写 + transcript durable/epoch；崩溃半轮补 `turn.aborted{crash}`。
- **Hub 不内嵌 Agent**：每会话一个 `serve --stdio` worker；Hub 只做进程/帧路由；未绑定连接一律 conflict，close 仅 owner。
- **安全边界**：PathPolicy realpath+symlink 本体+cwd；shell 与 `~/.neo` 用户级目录显式豁免。

## 测试与质量

- 最终：`bun test` **92 pass / 0 fail / 22 文件**；`tsc` 0 error；`verify.sh` **ALL GREEN**；`docs:check` OK（31 md / 7 协议 / commands.json 一致）；0 skip。
- 关键回归：WS SIGTERM 终态、resume 幂等、锁双开、PathPolicy 越界/悬空 symlink、附件链路+恢复、transcript.fetch、Hub 两会话并行/并发 attach/close 后重开、`~/.neo/settings.json` 回落、too_large id 关联。
- GUI 启动链已手工验证：ready 9 caps → session.list → **未 attach 的 settings.get（~/.neo/settings.json，掩码正确）**。

## 已知限制 / 风险

- Hub 无 idle 回收/自动重启、单客户端/会话；attach 仍总快照；历史轮次附件无协议元数据（刷新不可回放）。
- 快照仍由 host 复用 protocol reducer；`core/ui` 兼容层待清；PathPolicy 写入 TOCTOU 留 v0.0.3。
- 附件仅图片 base64，≤5 张/单张 5MB/总 8MB；refs ≤5/200KB。
- 未接 CLI（C5 另立）；未做打包分发、Windows/Linux 实机。
- 风险：GUI 外仓联调（J2–J5）未开始；协议与 GUI vendor 版本需同步。

## 下一步

1. **GUI 联调**：按 `docs/gui-integration-v0.0.2.md` 的 14 项 checklist，起 Hub（`--dev-auth --cwd <项目>`），验证 `neo-agent-app` 的 endpoint/token、多会话、附件、错误码改动。
2. **v0.0.3**：simplify backlog（serve/http 合并、applyStreamDelta 公共 mutator、图片持久化性能、Hub idle/重启/租约、attach 增量）、历史附件协议字段、PathPolicy O_NOFOLLOW/memoize、`core/ui` 清理、打包分发。
3. **CLI 切换（C5）**：另立范围。

## 关联

- 发布：[[发布-v0.0.1]] · [[发布-v0.0.2]]
- 设计：[[架构-Matrix-Core]] · 协议：[[协议-Matrix-Core-v1]] · 计划：[[计划-Matrix-Core-v0]] · 决策：[[决策记录-Matrix-Core]] · 迁移：[[边界与迁移]]
- 文档：`docs/v0.0.2-acceptance.md` · `docs/release-notes/v0.0.2.md` · `docs/v0.0.2-simplify.md` · `docs/gui-integration-v0.0.2.md` · `docs/evidence/v0.0.2-*.txt`
