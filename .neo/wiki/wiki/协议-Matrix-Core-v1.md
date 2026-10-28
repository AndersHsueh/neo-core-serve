# 协议-Matrix-Core-v1

> 最后更新:2026-10-28

## 摘要

客户端与 core 的唯一契约是 WS 协议 v1.1：JSON 信封 + seq/epoch + attach 续传 + 快照，**冻结 v1 的判别名**（`turn.start`、`assistant.start/delta/end`、`tool.start/end`、`approval.request/resolve`、`question.request/resolve`、`tier.switch`、`banner`、`context`），只做加法。命令有回执，事件无回执；durable 事件写 transcript 可重放，ephemeral（delta/notice/activity）不落盘。新增能力：`turn.aborted`、`compact.*`、`command.result`、`session.cleared`、`mode.set`、session shims、`--dev-auth`、`snapshot.live`。协议源在 `neo-core-serve/src/protocol`，客户端 vendoring + fixtures conformance。详见 `docs/protocol-v1.md`。

## 传输与鉴权

- WS `ws://127.0.0.1:<port>/ws`，子协议 `["neo.v1","bearer.<token>"]`；token 文件 0600。
- Origin 白名单；失败直接关闭 4401；`--dev-auth` 提供本地 HTTP 登录（默认关）。
- `--stdio`：行分隔帧，stdout 只出帧、日志 stderr；`/health` 无敏感信息。

## 命令/事件

- 命令：session.list/create/attach/detach/rename/close、turn.send/abort、approval.resolve、question.answer、command.run、settings.get/patch、mode.set、usage.summary、ping（liveness，pending 时续期）；auth.* 保留为 HTTP/dev-only；v1.2 加 transcript.fetch/checkpoint.*/session.export/output.get/peers.list/command.cancel。
- 事件：turn.start、assistant.*、reasoning.*、tool.*、approval.*、question.*、tier.switch、stats（正常轮末）、banner、context、session.meta/status、peer.update、error、turn.aborted（中断）、compact.*、command.result、session.cleared。
- seq 由 core 分配并持久化（仅 durable 推进）；ephemeral 携带当前 durable seq；epoch 不符/`lastSeq>最高 durable seq` → 快照；mid-turn 快照的 blocks 含 partial 块。
- 未知事件客户端必须放行（capability 降级）；未知命令报错；`error.blockId/at`、`question.resolve.at` 必填（确定性 reducer）。

## 客户端改动

GUI 需改约 6 处：protocol types/guards、reducer、app.ts（seq/epoch、mode.set）、hub.ts（未知事件不致命）、commands.json 同步、登录层。详见 `docs/gui-integration.md`。

## 关联

- 设计：[[架构-Matrix-Core]] · 计划：[[计划-Matrix-Core-v0]] · 决策：[[决策记录-Matrix-Core]] · 迁移：[[边界与迁移]]
- 事实源：`docs/protocol-v1.md`

## 修订记录

- 2026-10-28 初版。
- 2026-10-28 评审修订：判别名冻结（去掉 rename 方案）、seq 归 core、epoch、stats 收口、notice 改 ephemeral、GUI 改动清单。
