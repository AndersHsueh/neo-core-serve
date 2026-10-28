# 架构-Matrix-Core

> 最后更新:2026-10-28

## 摘要

Matrix-Core 是「独立进程、无终端依赖、可被多客户端驱动」的 neo 核心。分层为 `protocol`（纯数据，零依赖）← `serve`（同时依赖 core 与 protocol）→ `main`；`core` 独立，不 import serve/protocol/ui。事件分 durable（写 transcript，可重放）与 ephemeral（delta/notice，不落盘）；seq 由 core 分配并持久化，epoch 标识 transcript 世代。持久化用 messages 原子写 + transcript + 轮次对账修复；审批/提问是带 blockId 与滑动 deadline 的请求，策略只在 core。v0 单会话，v0.5 用 Hub + 每会话 worker。详见 `docs/architecture.md`。

## 关键设计

- **分层**：protocol 零依赖；core 独立；serve 做 CoreEvent→SessionEvent 映射与 reducer 快照；main 只做入口。
- **事件**：durable（turn.start/aborted、assistant.end、tool.*、approval/question、stats、banner、context、session.*、error、compact.*、command.result、session.cleared）+ ephemeral（delta、activity、notice）。
- **seq/epoch**：core 分配 seq，**只有 durable 事件推进并落盘**；ephemeral 携带当前 durable seq（不推进）；崩溃后从最后 durable 继续；epoch 不匹配/`lastSeq>最高 durable seq` → 强制快照。
- **恢复**：轮中只落非终态事件；轮末先原子写 messages+meta，再落终态 `stats`/`turn.aborted`；恢复对账 `meta.lastTurnId` vs transcript 尾部，终态唯一；abort 先修 messages 尾部。
- **审批/提问**：线格式 id=blockId；deadline 是安全网（owner 任意帧/`ping`/attach 续期、pending 时客户端 ≤60s ping、断线宽限、无客户端立即收敛）；`allow-session` 仅 write/edit，shell 不放行。
- **安全**：PathPolicy 包裹所有文件操作；EventSink/persist/logger 边界脱敏；outputRef 不透明 id；本地 token/Origin；锁与 mailbox `.alive` 互认。
- **命令**：Command 注册表 + CommandOutcome(ViewBlock)；`commands.json` 单源；交互走 question/approval。
- **进程**：v0 单会话（`~/.neo/run` 发现 + 单实例锁）；v0.5 Hub + worker 池。

## 与旧实现的关系

移植自 [[边界与迁移]] 记录的 neo `1da7c6f`；C0b 只搬纯模块，agent/tools 在 C1 建端口后再搬（否则 `ui/*` 依赖导致编译不过）。`insideCwd` 未调用、脱敏滞后、`meta.path` 信任等已知问题在本仓修正。

## 关联

- 需求：[[计划-Matrix-Core-v0]] · 协议：[[协议-Matrix-Core-v1]] · 决策：[[决策记录-Matrix-Core]] · 迁移：[[边界与迁移]] · 待定：[[待澄清-Matrix-Core]]
- 事实源：`docs/architecture.md`

## 修订记录

- 2026-10-28 初版：分层/事件/生命周期/持久化。
- 2026-10-28 评审修订：seq/epoch 归 core、reducer 归 serve/客户端、恢复对账与尾部修复、deadline 语义、PathPolicy/脱敏、C0 拆分。
