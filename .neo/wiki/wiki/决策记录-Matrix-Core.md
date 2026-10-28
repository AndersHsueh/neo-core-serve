# 决策记录-Matrix-Core

> 最后更新:2026-10-28

## 摘要

已定 15 条决策。核心：三仓完全独立、只以协议为契约（D1）；代码一次性移植（D2）；协议源在 core 仓、客户端 vendoring（D3）；core 事件化、渲染归客户端（D4）；v0 单会话→v0.5 Hub+worker（D5）；messages+transcript+seq/epoch+对账修复（D6）；blockId 审批/提问 + 滑动 deadline（D7）；命令层结构化 + 单一 catalog（D8）；本地 token（D9）；semver+protocol v1+capabilities（D10）；neo 冻结（D11）；文档/wiki 同步（D12）；PathPolicy（D13）；边界脱敏（D14）；与 neo CLI 共存/迁移（D15）。详见 `docs/decisions.md`。

## 决策一览

| 编号 | 决策 |
|---|---|
| D1 | 三仓完全独立，禁止 file:/workspace/submodule，只以协议为契约 |
| D2 | 从 neo 指定 commit 一次性移植；provenance 记录 |
| D3 | 协议源在 core 仓；客户端 vendor + conformance；reducer 抽到 protocol/ |
| D4 | core 事件化，渲染归客户端；stdout 只走帧 |
| D5 | v0 单会话；v0.5 Hub + 每会话 worker |
| D6 | messages + durable transcript + seq/epoch；轮末先 messages 后终态；对账修复 |
| D7 | blockId 为线格式 id；deadline 安全网（在线滑动/断线宽限/无客户端收敛）；allow-session 不含 shell |
| D8 | 命令层结构化（ViewBlock）+ commands.json 单源 |
| D9 | 本地 token + Origin；--dev-auth 默认关 |
| D10 | core semver + protocol v1 + capabilities |
| D11 | neo v0.4.3 冻结；CLI 后续纯客户端 |
| D12 | 文档即契约；里程碑更新 wiki + log |
| D13 | PathPolicy 包裹所有文件操作（修 insideCwd 未调用） |
| D14 | 脱敏在 EventSink/persist/logger 边界，先于持久化 |
| D15 | 与 neo CLI 共存：锁互认、路径重算、日志分区、import/backup |

## 关联

- 完整背景/后果：`docs/decisions.md`
- 设计：[[架构-Matrix-Core]] · 协议：[[协议-Matrix-Core-v1]] · 计划：[[计划-Matrix-Core-v0]] · 迁移：[[边界与迁移]]

## 修订记录

- 2026-10-28 初版：D1–D12。
- 2026-10-28 评审修订：D6/D7 重写；新增 D13–D15。
