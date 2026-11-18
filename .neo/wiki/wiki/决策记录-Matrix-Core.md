# 决策记录-Matrix-Core

> 最后更新:2026-11-19

## 摘要

已定 15 条决策（D1/D6/D11/D13 于 2026-11-19 修订）。核心：对客户端仍只以协议为契约（D1），但内核只有一份代码住处在 neo-core-serve，过渡期融合模式可暂时用这份内核；不要包 `neo acp`。代码一次性移植（D2）；协议源在 core 仓（D3）；core 事件化（D4）；Hub+worker（D5）；messages 仍由 worker 写，Hub 可以写 transcript 留档（D6）；审批/提问（D7）；命令目录（D8）；本地 token（D9）；semver+capabilities（D10）；两阶段真源——现在原型仍在 neo-cli，追平后天平转到 core-serve（D11）；文档/wiki 同步（D12）；PathPolicy 作为新一代默认留在 core-serve，不改 neo-cli TUI 默认行为（D13）；脱敏（D14）；与 neo CLI 共存/迁移（D15）。详见 `docs/decisions.md`。

## 决策一览

| 编号 | 决策 |
|---|---|
| D1 | 对客户端仍只以协议为契约；内核只有一份住处（core-serve），过渡期融合模式可暂时用这份内核；不包 neo acp |
| D2 | 从 neo 指定 commit 一次性移植；provenance 记录 |
| D3 | 协议源在 core 仓；客户端 vendor + conformance；reducer 抽到 protocol/ |
| D4 | core 事件化，渲染归客户端；stdout 只走帧 |
| D5 | v0 单会话；v0.5 Hub + 每会话 worker |
| D6 | messages 仍由 worker 写；Hub 可以写 transcript 留档；seq/epoch；轮末先 messages 后终态；对账修复 |
| D7 | blockId 为线格式 id；deadline 安全网（在线滑动/断线宽限/无客户端收敛）；allow-session 不含 shell |
| D8 | 命令层结构化（ViewBlock）+ commands.json 单源 |
| D9 | 本地 token + Origin；--dev-auth 默认关 |
| D10 | core semver + protocol v1 + capabilities |
| D11 | 两阶段：现在原型/真源在 neo-cli，追平后天平转到 core-serve；不包 neo acp |
| D12 | 文档即契约；里程碑更新 wiki + log |
| D13 | PathPolicy 包裹所有文件操作，作为新一代默认留在 core-serve；不改 neo-cli TUI 默认行为 |
| D14 | 脱敏在 EventSink/persist/logger 边界，先于持久化 |
| D15 | 与 neo CLI 共存：锁互认、路径重算、日志分区、import/backup |

## 关联

- 完整背景/后果：`docs/decisions.md`
- 设计：[[架构-Matrix-Core]] · 协议：[[协议-Matrix-Core-v1]] · 计划：[[计划-Matrix-Core-v0]] · 迁移：[[边界与迁移]]

## 修订记录

- 2026-10-28 初版：D1–D12。
- 2026-10-28 评审修订：D6/D7 重写；新增 D13–D15。
- 2026-11-19 修订：D11 改为两阶段真源；D1 对客户端仍成立并开内核住处窄口；D6 允许 Hub 写 transcript；D13 明确 PathPolicy 留在 core-serve。
