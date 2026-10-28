# neo-core-serve 知识库 — 索引

> 内容导向的目录：每个主题页一行，给出链接、一句话摘要与元数据。
> 最后更新:2026-10-28

## 一句话定位

记录 **Matrix-Core**（neo 核心运行时服务）的架构决策、协议契约、迁移与共存规则、排期与风险，供后续会话与协作者快速召回「为什么这样设计、现在做到哪」。

## 当前状态

**C0 完成（协议 v1.1 冻结 + reducer + 骨架 + docs:check）；C0b 待开工。**
基线：neo **1052 pass / 0 fail / 67 文件** + PTY 21/21（2026-10-28 实跑/evidence；`tests/README.md` 的 1051/1 是旧口径）。
事实源：`docs/matrix-core-v0-prd.md`、`architecture.md`、`protocol-v1.md`、`work-plan.md`、`decisions.md`、`protocol-freeze.md`。

## 主题目录

### 架构与协议

| 主题 | 页面 | 一句话摘要 | 元数据 |
|---|---|---|---|
| 架构 | [[架构-Matrix-Core]] | protocol 零依赖 / core 独立 / serve 映射 + reducer 快照；durable/ephemeral、seq/epoch、恢复对账、审批 deadline、PathPolicy/脱敏、v0 单会话→Hub | 2026-10-28 |
| 协议 | [[协议-Matrix-Core-v1]] | 冻结 v1 判别名，只加可选字段/新事件；命令有回执、事件无回执；attach/seq/epoch/快照；GUI 改动 6 处；客户端 vendoring + conformance | 2026-10-28 |

### 计划与决策

| 主题 | 页面 | 一句话摘要 | 元数据 |
|---|---|---|---|
| 计划 | [[计划-Matrix-Core-v0]] | C0 3d → C0b 4d → C1 15d → C2 16d → C3 9d；v0 共 47d；C4 Hub 15d；C5 另立 | 2026-10-28 |
| 决策 | [[决策记录-Matrix-Core]] | D1 仓库独立 / D2 移植 / D3 协议源 / D4 事件化 / D5 单会话→Hub / D6 持久化 seq/epoch / D7 审批 deadline / D8 命令层 / D9 鉴权 / D10 版本 / D11 neo 冻结 / D12 文档 wiki / D13 PathPolicy / D14 脱敏 / D15 共存迁移 | 2026-10-28 |

### 迁移与开放问题

| 主题 | 页面 | 一句话摘要 | 元数据 |
|---|---|---|---|
| 边界与迁移 | [[边界与迁移]] | 三仓独立；C0b 纯模块 + C1 agent/tools 两批移植；共存规则（锁互认/路径重算/日志分区/import）；C5 CLI 切客户端 | 来源 neo `1da7c6f` |
| 待澄清 | [[待澄清-Matrix-Core]] | Q1 CLI 切换后仓形态 / Q2 远程项目边界 / Q3 transcript 保留期 / Q4 多客户端权限 | 4 条开放 |

## 来源清单

- 需求：[`docs/matrix-core-v0-prd.md`](../../../docs/matrix-core-v0-prd.md)
- 设计：[`docs/architecture.md`](../../../docs/architecture.md)
- 协议：[`docs/protocol-v1.md`](../../../docs/protocol-v1.md)
- 计划：[`docs/work-plan.md`](../../../docs/work-plan.md)
- 决策：[`docs/decisions.md`](../../../docs/decisions.md)
- 代码来源：[`docs/provenance.md`](../../../docs/provenance.md)
- 运维：[`docs/ops.md`](../../../docs/ops.md)
- GUI 接入：[`docs/gui-integration.md`](../../../docs/gui-integration.md)
- 日志：[[log]]

## 维护提醒

新增/改名/删除页面后同步本索引；每页保持 `## 摘要` + `> 最后更新`；`log.md` 只追加；结论与 `docs/` 冲突时以 `docs/` 为准。
