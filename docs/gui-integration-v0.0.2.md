# GUI 联调指南（neo-agent-app → Matrix-Core v0.0.2）

> 状态：**draft（随 v0.0.2 实现收敛；未交付项在文中标出）** · 2026-10-28
> 适用：`neo-agent-app`（Preact + WS 客户端）接入本仓 `v0.0.2`（多会话 Hub）。
> 约束：**本仓不改 `neo-agent-app` 代码**；本文件只给改动清单与验收口径。协议以本仓 `docs/protocol-v1.md` + `protocol.lock.json` 为唯一真源。
> 上一版：[gui-integration.md](gui-integration.md)（v0.0.1 单会话）。本版覆盖 Hub/多会话/附件/transcript 回放。

---

## 0. 一句话

GUI 连 **Hub**（`matrix-core hub --dev-auth`）而不是单个 core 进程：`session.list/create/attach/close` 管多会话，每个会话由 Hub 托管的 worker 进程执行，事件与 v0.0.1 同一套协议（新增 `sessions`/`transcript.replay` 能力位、附件、`too_large`）。

---

## 1. 环境准备：`~/.neo/settings.json`

GUI 联调用**用户级配置**，不要放 core 仓库、也不要依赖项目目录：

```jsonc
// ~/.neo/settings.json（权限建议 0600；已被本仓 .gitignore 排除，勿提交）
{
  "default_provider": "ipsa",
  "default_model_tier": "default",
  "providers": [
    {
      "provider_name": "ipsa",
      "provider_type": "openai",
      "base_url": "https://your-gateway/v1",
      "api_key": "sk-…",
      "default_model_name": "deepseek-flash",
      "deep_reasoning_model_name": "glm-5.3-flash",
      "balanced_model_name": "deepseek-flash",
      "fast_model_name": "deepseek-flash"
    }
  ]
}
```

- 配置查找顺序（实际行为）：**会话 cwd 的 `settings.json` → 包根 → `~/.neo/settings.json`**，取第一个存在的，不合并。
- Hub/worker 的 `--cwd` 是**用户项目目录**；项目里没有 `settings.json` 时自然回落到 `~/.neo/settings.json`（推荐做法：只维护一份用户级配置）。
- 项目级 `settings.json` 若含明文 key，启动会发 warn banner；协议/日志/transcript 只出现掩码。
- model 配置错误不会阻塞 Hub 启动，但 worker 首个 turn 会以 `stats.error` 失败——联调前先用 `matrix-core doctor` 或单会话 `serve --stdio` 验证一次 LLM 连通。

---

## 2. 启动 Hub 与发现 endpoint

```bash
# 推荐：dev 登录 + 随机端口（只绑 127.0.0.1）
matrix-core hub --dev-auth

# 指定端口 / 默认会话目录 / token 文件
matrix-core hub --port 5292 --cwd ~/projects/my-app --dev-auth
```

启动后：

- **发现文件**：`~/.neo/run/core.json`（原子写），字段 `{url, pid, tokenFile, sessionId?, epoch?, startedAt}`；`url` 形如 `ws://127.0.0.1:<port>/ws`。
- **token**：`~/.neo/run/core.token`（0600，64 hex）；重启会轮换 → 客户端每次重连都重读。
- **dev 登录**：`POST /api/auth/login {email,password}` → `{token,expiresAt,user}`（仅回环 + Origin 白名单；默认关闭；`--dev-auth` 打开）。GUI 现有登录页可保留，把 endpoint 指向 `http://127.0.0.1:<port>/api/auth/login`。
- **health**：`GET /health` → Hub 形态 `{ok, mode:"hub", coreVersion, protocolVersion, sessions}`（无鉴权、无敏感信息；`sessions` = 运行中 worker 数）。单会话 `serve` 是 `{ok, coreVersion, protocolVersion, state, uptimeMs}`。
- **Origin 白名单**：`http://127.0.0.1:*`、`http://localhost:*`、`tauri://localhost`；无 Origin（脚本）允许但需 token。
- **单实例**：同一 Hub 端口/发现文件；重复启动按 pid/锁拒绝（具体行为以 v0.0.2 `ops.md` 为准）。

客户端连接顺序建议：**读 `core.json` → 读 token（或 dev 登录换 token）→ WS 连接**。v0.0.2 **不实现** `VITE_CORE_URL`/`MATRIX_CORE_URL` 环境变量发现（如需可自己注入 `--core-url` 类逻辑，但协议层不承诺）。

---

## 3. WS 握手与鉴权

- 地址：`ws://127.0.0.1:<port>/ws`
- 子协议：`["neo.v1", "bearer.<token>"]`
- 失败：**直接关闭 4401**（不会发送缺 `id` 的 result 帧）；客户端应回登录/重连流程。
- 首帧 `ready`（Hub 版）：

```jsonc
{
  "v": 1, "kind": "ready",
  "user": { "id": "local", "email": "local@localhost", "displayName": "Local", "role": "owner" },
  "coreVersion": "0.0.2",
  "protocolVersion": "1.2",              // 以 protocol.lock.json 为准
  "capabilities": [
    "turn.aborted", "command.structured", "mode.set", "snapshot.live",
    "activity", "question.multi",
    "transcript.replay", "attachments.image",   // v0.0.2 新增
    "sessions"                                   // Hub 额外广告（单会话 serve 没有）
  ],
  "sessionId": "…",   // Hub 模式下可缺省，会话在 attach 后确定
  "epoch": "…"
}
```

> 客户端必须**按 capabilities 降级**：看到 `sessions` 才启用多会话 UI；看到 `transcript.replay` 可用 `transcript.fetch`/增量；看到 `attachments.image` 才开放图片发送。未知 capability 忽略。单会话 `serve` 广告 8 项（无 `sessions`），Hub 广告 9 项。

---

## 4. Hub 会话命令

| 命令 | 请求 | 回执 | GUI 用法 |
|---|---|---|---|
| `session.list` | — | `{sessions: SessionMeta[]}`（磁盘摘要，运行中 status=`working`） | 启动/刷新会话列表；**摘要字段是占位值**（`title` 由 id 派生、`provider:""`、`tier:"default"`、`mode:"ask"`）→ 选中会话后以 `attach` 的 `snapshot.meta` 为准 |
| `session.create` | `{title?, cwd?}` | `{sessionId}` | 「新建会话」→ 拿到 id 后 `attach` |
| `session.attach` | `{sessionId, lastSeq?, epoch?}`（Hub 下 **sessionId 必填**） | `{role}` + `snapshot` 帧 | 切会话；**v0.0.2 总是返回完整快照**（lastSeq/epoch 先接收；增量补齐用 `transcript.fetch`） |
| `session.detach` | `{sessionId}` | `{}` | 关闭视图但 worker 保活（由 Hub 策略决定） |
| `session.close` | `{sessionId}` | `{}` | **仅会话 owner 可 close**（非 owner → `forbidden`）；Hub 等 worker 退出（≤2s）后才回执；会话文件保留，再次 `attach` 会重新拉起 worker（resume） |
| `session.rename` | `{sessionId, title}` | `{}` + 广播 `session.meta` | 重命名 |
| `settings.get` | — | `{settings: SettingsView}`（掩码） | 设置页只读展示 |
| `mode.set` | `{sessionId, mode}` | `{}` + `session.meta` | 模式切换 |
| `usage.summary` | `{range, sessionId?}` | `{range, records, totals}` | 用量（`costMicros=0` 显示「未计价」） |
| `transcript.fetch` | `{sessionId, fromSeq?, limit?}` | `{events:[{seq,event}], nextSeq?}` | 打开历史/断线补齐 |
| `turn.send/abort`、`approval.resolve`、`question.answer`、`command.run` | 同 v0.0.1 | 同 v0.0.1（事件带 `sessionId/seq`） | 发消息/中断/审批/提问/命令 |

**新建会话的可见性**：`session.list` 只读磁盘上的会话文件；`session.create` 后若还没产生持久化（无 title、未发过消息），该会话可能暂不出现在列表里 → GUI 应把 create 返回的 `sessionId` 本地插入列表，attach 后再以 snapshot 校正。

**会话绑定**：Hub 下每条连接同一时刻只绑定一个 session（`attach` 后生效）；换会话需先 `session.detach`（否则 `conflict`）。

- 转发类命令（`turn.send`/`abort`/`approval.resolve`/`question.answer`/`command.run`/`mode.set`/`usage.summary`/`transcript.fetch`/`session.rename`）**必须已 attach**：未绑定时一律 `conflict`，**显式带 `sessionId` 也不能绕过**（Hub 会忽略命令里的 sessionId，只用连接绑定）。
- **唯一例外 `settings.get`**：GUI 启动链会在 attach 前调用；Hub 直接按默认 cwd 读配置返回（不 spawn 会话）。
- v0.0.2 简化：**同一 session 同时只允许一个客户端**，第二个 `attach` → `conflict`（客户端提示「该会话已在别处打开」）。

---

## 5. 事件、seq 与流控（v0.0.2 有变化，必须适配）

### 5.1 事件与 seq（与 v0.0.1 相同）

- 帧：`{v:1, kind:"event", sessionId, seq, event:{type,...}}`；**seq 只在信封**，事件体内没有 seq。
- `seq` 是 session 级单调计数，由 core 分配，只随 durable 事件递增并持久化；ephemeral（`*.delta`、`activity`、`notice`）不推进，携带**当前 durable seq**（可重复）。
- 客户端必须持续记录 `lastSeq` 与 `epoch`（收到 event/snapshot 都更新）。
- 终态：一轮以 `stats` 或 `turn.aborted` 收口，两者互斥；`assistant.end.text`/`reasoning.end.text` 是权威全文（覆盖 delta 累积）。

### 5.2 合批（新增，客户端必须容忍）

- 服务端把同一 block 的 delta 合批（16ms 或 4KB 触发 flush，保留最新 seq）。
- 客户端**不能假设 delta 逐 token 到达**：按 `blockId` 累积、以 `*.end.text` 为准；不要对单帧文本长度/分片数做断言。
- 合批不产生 seq 跳号（ephemeral 不推进 seq）；但**不要**对「连续 seq」做断言。

### 5.3 背压与慢消费者

- 每连接队列 512 帧 / 8MB；超限先丢 ephemeral，仍超限关闭 **4408**。
- 客户端收到 4408：停止自动重灌历史，指数退避重连（300ms×2^n，封顶 5s + jitter），attach 后以 snapshot 重建。

### 5.4 断线/重连

1. 记下 `sessionId/lastSeq/epoch`；
2. 重读 `core.json` + token（Hub 重启会换 token/端口）；
3. 重连 → `session.attach{sessionId,lastSeq,epoch}`：**v0.0.2 总是返回完整 `snapshot`**（`lastSeq/epoch` 会被接收但暂不触发增量回放）。客户端以快照重建，保留本地乐观消息按 `clientId` 去重。
4. 需要更早历史 → `transcript.fetch{sessionId, fromSeq, limit}` 分页拉取（`fromSeq` 含、默认从 1、`limit` 默认 200/最大 1000；`nextSeq` 存在则续拉，否则到底）。

---

## 6. 附件/图片（新能力）

- 发送：`turn.send` 增加可选 `attachments: [{kind:"image", mime:"image/png"|"image/jpeg"|"image/webp", dataBase64:"…"}]`。
  - 每轮 ≤ **5 张**，单张 ≤ **5MB**；v0.0.2 的**入站**帧上限为 **8MB**（含附件，超限回 `too_large`；极端超大帧可能先被 WS 传输层关闭连接）。服务端下发的事件帧另有流控（合批/背压）。
  - 超限 → `too_large` 错误码（`result.ok=false`），客户端提示压缩/减少张数。
- 服务端：解码 → 写 `~/.neo/sessions/attachments/<sessionId>/img-N.<ext>` → 用户消息加 `image_url` part；会话 JSON 只存 `$ref`，resume 时 hydrate。
- 展示：**v0.0.2 协议不回传附件元数据**（`turn.start`/`UserBlock` 没有 attachments 字段，durable 事件里也不含图片）→ 历史轮次的图片无法从 snapshot/`transcript.fetch` 还原；本轮发送后由客户端本地预览/缓存，刷新或重连后图片不再显示（v0.0.3 补协议字段）。客户端不要自己拼 `~/.neo` 路径。
- 不在本版：剪贴板图片自动粘贴、非图片附件、拖拽上传通道（v0.0.3+）。

---

## 7. neo-agent-app 需改的文件（约 7 处）

| 文件 | 改动 |
|---|---|
| `gui/src/protocol/{types,guards,fixtures,reducer}.ts` | 从本仓 vendor 更新（含 `too_large`、`attachments`、`transcript.fetch`、Hub capabilities）；`guards` 未知事件放行、`ERROR_KEYS` 补 `too_large`/`question_expired`/`slow_consumer` |
| `gui/src/protocol/commands.json` + `protocol.lock.json` | vendor 本仓生成的命令目录（`bun run commands:gen` 产物）与 lock；CI 校验哈希/漂移 |
| `gui/src/transport/hub.ts` | 读 `~/.neo/run/core.json` + token；dev 登录 endpoint；4401 回登录；4408 退避重连；请求超时保留；attach 带 lastSeq/epoch |
| `gui/src/state/app.ts` | seq/epoch 追踪；多会话列表（session.list/create/attach/close）；当前 session 绑定；重连恢复 |
| `gui/src/state/session.ts`（reducer） | 用 vendored `protocol/reducer.ts` 替换/对齐；`turn.aborted` 收口、`session.cleared` 清 blocks、`assistant.end.text` 覆盖、`snapshot.live` 恢复 |
| `gui/src/lib/commands.ts` | 从 `commands.json` 生成命令面板（不再手写） |
| 附件 UI（composer/transcript） | 选择/粘贴图片 → base64 随 `turn.send.attachments` 发送；超限提示；历史附件渲染只读 |

> 可选：`notice`/`activity` 渲染为 toast/spinner 文案；不实现也能跑。

---

## 8. 联调验收 checklist（GUI 侧）

前置：`~/.neo/settings.json` 配好且 LLM 连通（可先用 fake LLM 跑通）。

- [ ] `matrix-core hub --dev-auth` 启动；GUI 读 `core.json` → dev 登录拿 token → WS 子协议握手 → `ready` 含 `sessions` capability。
- [ ] `session.list` 显示磁盘 + 运行中会话；`session.create` 新建 → `attach` → 出现空 snapshot。
- [ ] 发消息：流式正文/思维链、工具卡、`stats`；`assistant.end.text` 不重复/不缺字（合批下仍正确）。
- [ ] 审批卡：allow/deny/allow-session 生效；`diff` 缺失时显示 `detail`。
- [ ] 提问：单选 `key`、多选 `keys`、自定义 `custom` 三类回答都能收口。
- [ ] `command.run`（/tier、/clear、/compact）结果块渲染；未知命令 toast 不崩。
- [ ] 两会话并行：A 跑 turn 时切 B 发消息互不影响；`session.list` 状态正确。
- [ ] `session.close`（owner）后 worker 终止（回执前已退出）；非 owner close → `forbidden`；再次 `attach` 同一 id 能重新拉起并恢复历史（resume）。
- [ ] 刷新/断网：重连 `attach` 以完整快照重建、不重影；`transcript.fetch{fromSeq,limit}` 翻历史/续拉正确。
- [ ] 慢消费者场景（可选）：构造高频 delta + 不读 → 收到 4408 后能退避重连恢复。
- [ ] 附件：发 1 张 PNG → fake LLM 收到 image_url；本轮本地预览正常；**历史/刷新后图片不显示属 v0.0.2 已知限制**（协议无附件元数据）；>5 张 / >5MB / 帧 >8MB 返回 `too_large` 且提示（注意：帧 >8MB 的服务端回帧当前 id 关联有缺陷，见 acceptance D6）。
- [ ] worker 崩溃（手工 kill worker 子进程）：GUI 收到断开/错误后重连，`attach` 能恢复到最后完成轮。
- [ ] 协议 conformance：vendored guards/fixtures 全过、未知事件放行、`protocol.lock.json` 哈希一致。

---

## 9. 常见问题

| 现象 | 排查 |
|---|---|
| WS 4401 | token 过期/轮换：重读 `core.json` + `core.token`（Hub 重启会换） |
| `conflict`（attach/命令） | 该 session 已被另一客户端占用（v0.0.2 单客户端）；或未 attach 就发会话命令（不能用显式 sessionId 绕过）；换会话未 detach |
| 消息没有流式 | 服务端合批 + 客户端按帧渲染；检查是否把 delta 当完整文本；`*.end.text` 兜底 |
| 图片发送失败 `too_large` | 张数/单张大小/帧上限（8MB）；压缩或减少 |
| 附件历史丢失 | `$ref` 需要服务端 hydrate；客户端不要删 `~/.neo/sessions/attachments` |
| 断线后重影/重复 | snapshot 后按 `clientId` 去重乐观消息；`assistant.end.text` 覆盖 delta |
| `sessions` capability 缺失 | 连的是单会话 `serve` 而不是 `hub`（或版本旧） |

---

## 10. 不在本版（v0.0.3+）

- CLI 接入（`neo` 仓不改）。
- 多客户端同时 attach 同一会话（租约/协作，v0.5+）。
- 远程/TLS/多租户。
- 非图片附件、剪贴板自动粘贴、附件 CDN/缩略图。
- `settings.patch` 写入（仍 `unsupported`）、`session.export`、`checkpoint.*`。
