# 协议冻结记录（v1.1）

> 状态：**已冻结** · 2026-10-28 · C0 产出
> 事实源：`src/protocol/{types,guards,fixtures,reducer,commands}.ts` + `protocol.lock.json`
> 上游：`neo-agent-app` `a52f1f0` 的 `gui/src/protocol`（v1 原型）

## 1. 冻结的含义

- **判别名冻结**：`turn.start`、`assistant.start/delta/end`、`reasoning.start/delta/end`、`tool.start/end`、`approval.request/resolve`、`question.request/resolve`、`tier.switch`、`stats`、`banner`、`session.meta/status`、`context`、`peer.update`、`error`、`auth.expired` 一律不改名。
- **只做加法**：新增可选字段、新事件、新命令、新能力位；不得把可选变必填、不得改语义。
- **新增事件（v1.1）**：`turn.aborted`、`compact.start/end`、`command.progress/result`、`session.cleared`、`activity`、`notice`。
- **新增命令（v1.1）**：`mode.set`；`auth.*` 保留命令名（HTTP/dev-only，WS 返回 unsupported）。
- **必填字段收紧**：`error.blockId/at`、`question.resolve.at`（确定性 reducer）；`snapshot.epoch`；`SessionMeta.mode`。
- 破坏性变更 → `v: 2`（客户端与 core 双版本过渡）。

## 2. 文件与哈希

`protocol.lock.json` 记录 6 个协议文件的 SHA-256（types/guards/fixtures/reducer/commands/index）与来源 commit。`docs:check` 会校验哈希；改协议必须重跑 `bun run freeze:protocol` 并提交 lock。

来源基线（只读事实，记录在 `docs/evidence/baseline.txt`）：

```
neo-agent-app a52f1f0
types.ts    4c96cf50…6675c
guards.ts   19e2d558…2e217
fixtures.ts a832b243…36d7
index.ts    80264be8…0f0d3
```

## 3. 客户端（GUI）变更清单

见 `docs/protocol-v1.md` §7 与 `docs/gui-integration.md`。必改文件约 6 个：`protocol/{types,guards}`、`protocol/reducer.ts`（vendor）、`state/app.ts`（seq/epoch、mode.set）、`transport/hub.ts`（未知事件不致命）、`lib/commands.ts`（catalog）、登录层。

## 4. 变更流程

1. 先改 `docs/protocol-v1.md`（语义）+ `fixtures.ts`（样本）。
2. 改 `types.ts` / `guards.ts` / `reducer.ts`，跑 `bun test`。
3. `bun run freeze:protocol` 更新 lock。
4. 同 commit 更新 PRD/架构/计划/wiki；`docs:check` 必须绿。
5. 通知客户端仓按 lock 同步并跑 conformance。

## 5. 未纳入 v1.1（v1.2/后续）

附件/图片、`transcript.fetch`、`output.get`、`checkpoint.*`、`session.export`、`peers.list`、`command.cancel`、`routing.decision`、多客户端租约。
