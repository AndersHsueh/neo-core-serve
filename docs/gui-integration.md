# GUI 接入清单（neo-agent-app → Matrix-Core）

> 状态：draft v0.2 · 2026-10-28
> 目的：让现有 GUI（Preact + WS 客户端 + reducer）用**明确、可控**的改动连上真 core。
> 前提：GUI 当前连 `dummy-serv`，协议源在 `neo-agent-app/gui/src/protocol`。本清单只改 protocol vendor、登录/连接、reducer/guards、命令表；不动视觉与信息架构。
> 关联：协议见 `protocol-v1.md`；排期见 `work-plan.md` C2.8；预计 **3–5 人日（GUI 仓）**。

---

## 1. 连接与鉴权

| 步骤 | 现状（dummy） | 接 core 后 |
|---|---|---|
| 登录 | `POST /api/auth/login {email,password}` → token | **保留同一 HTTP 端点**；core 在 `--dev-auth` 下接受任意本地账号并映射到 `local` 用户；默认关闭时由启动参数/环境注入 token |
| token | `sessionStorage` | 不变；token 来自登录响应或注入 |
| WS 地址 | `ws://127.0.0.1:5292/ws?lang=zh` | 读 `~/.neo/run/core.json` 的 `url`（或 `VITE_CORE_URL`） |
| 子协议 | `["neo.v1","bearer.<token>"]` | 不变 |
| ready | `{kind:"ready",user}` | 保持；core 返回 `{user:{id,email,displayName,role}}` + `coreVersion/protocolVersion/capabilities/epoch` |
| 失败 | — | 4401 直接关闭；客户端走登录/重连；`auth.expired` 本轮不实现 |
| 重连 | 指数退避 + attach | 不变；attach 带 `lastSeq`+`epoch`（见 §3） |

---

## 2. v0 兼容命令（core 侧提供）

GUI 启动链：`session.list` → `settings.get` → `session.attach` → `usage.summary`。v0 单会话也必须提供：

| 命令 | v0 行为 | GUI 注意 |
|---|---|---|
| `session.list` | 返回唯一会话 | 正常渲染 |
| `session.create` | 返回当前 id 或 `conflict` | 冲突时 toast，不崩 |
| `session.rename` | 改标题 + 广播 `session.meta` | 无 |
| `session.close` | `unsupported` | toast 容错 |
| `session.attach` | `{role}` + `snapshot` | 需要 `epoch/live` 处理 |
| `settings.get` | `{settings: SettingsView}`（掩码） | 无 |
| `settings.patch` | `unsupported`（C3 后实现） | toast 容错 |
| `mode.set` | 切换并广播 `session.meta` | 模式切换改走它 |
| `usage.summary` | `{range, records:[], totals:{...0}}` | 显示「未计价」 |

> 这些 shim 让 GUI 启动逻辑基本不动；多会话语义等 v0.5 Hub。

---

## 3. 必须改的 GUI 文件（约 6 处）

| 文件 | 改动 |
|---|---|
| `gui/src/protocol/types.ts` | 补 `SessionMeta.mode`、`ApprovalBlock.diff: FileDiff\|null`、`QuestionBlock.header/context/multiSelect/allowCustom/answeredKeys/custom`、`ToolBlock.icon?/foot?`、新事件（`turn.aborted/compact.*/command.result/session.cleared/activity/notice`）、`ViewBlock`、`snapshot.epoch/live`；`tool.start.icon` 缺失时按 name 本地映射 |
| `gui/src/protocol/guards.ts` | **未知事件放行**（不再 fail）；`ready.user.email` 必填；`snapshot` 要求 `meta/context/epoch`；放宽 `approval.request` 的 `path/diff` |
| `gui/src/protocol/reducer.ts` | 从 `state/session.ts` 抽出纯 `applyEvent`（与 core 的 `protocol/reducer.ts` 同源），补新事件分支：`turn.aborted` 收口、`session.cleared` 清 blocks、`assistant.end.text` 覆盖、`snapshot.live` 恢复 |
| `gui/src/state/app.ts` | **追踪 seq/epoch**（每次 event/snapshot 更新）；`onReady` 继续 `session.list/settings.get/attach`；`mode.set` |
| `gui/src/transport/hub.ts` | 未知事件不致命；4401 回登录；请求超时保留 |
| `gui/src/lib/commands.ts` | 改为从 vendor 的 `commands.json` 生成/校验（不再手写 28 条） |

可选：`features/transcript` 渲染 `notice`（toast）与 `activity`（spinner 文案）；不实现也能跑。

---

## 4. 协议 vendoring（GUI 仓）

1. 从 core 仓复制 `src/protocol/{types,guards,fixtures,reducer}.ts` + `commands.json` 到 `gui/src/protocol/`（替换现有）。
2. 写 `protocol.lock.json`：`{sourceRepo, sourceCommit, protocolVersion, sha256}`。
3. 加 `protocol-conformance` 测试：fixtures 全过、坏样本被拒、未知事件放行、reducer 与 core 的 golden 一致。
4. `scripts/sync-protocol.sh --from ../../neo-core-serve` 人工同步；CI 校验 lock。
5. **禁止**代码依赖/子模块（D1）。

---

## 5. 行为差异与降级

| 差异 | GUI 处理 |
|---|---|
| `diff` 可能为 null / `path` 可能缺失 | 审批卡显示 `detail` 文本；无 diff 不崩 |
| `question` 多选/自定义 | v0 先支持单选；多选 UI 后续（core 仍能收发） |
| `notice/activity` 未知 | 忽略或 toast；不报协议错 |
| `assistant.end.text` 权威 | 用它覆盖 delta 累积（避免缺字） |
| `snapshot.live` | `hydrate` 恢复 partial 文本/工具相位 |
| `usage.costMicros=0` | 显示「未计价」 |
| 事件 seq 可能跳号 | 只用 `lastSeq` 续传，不做连续性断言 |
| `session.close/settings.patch` unsupported | toast 容错 |

---

## 6. 验收清单（GUI 侧）

- [ ] core `--dev-auth` 启动；GUI 登录 → `ready`（user/epoch/capabilities）。
- [ ] 会话列表显示唯一会话；attach 后看到历史 snapshot。
- [ ] 发消息：流式正文/思维链、工具卡、stats；`assistant.end.text` 不重复。
- [ ] 写文件审批：allow/deny 生效；diff 为 null 时显示 detail。
- [ ] ask_user 单选回答；多选在后续版本验证。
- [ ] 切 tier：`tier.switch` + 状态更新。
- [ ] 刷新/断网：attach(lastSeq, epoch) 补发或快照，不重影。
- [ ] 命令面板 `/compact` `/tier deep` 有结果；命令表来自 `commands.json`。
- [ ] core 重启：GUI 重连、token 重读、快照恢复；旧 core.json 有 pid 校验。
- [ ] 协议 conformance 测试绿；lock 哈希一致。

---

## 7. 不在本清单

- 多会话工作台（v0.5 Hub）。
- 图片/附件（v1.2）。
- 设置页写入（settings.patch，C3 后）。
- Tauri 壳/分发。
