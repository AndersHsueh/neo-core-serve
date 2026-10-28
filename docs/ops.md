# Matrix-Core 运维手册（v0.0.2）

> 状态：**v0.0.2（2026-10-28，验收中）** · 适用：单会话 `serve` + 本地多会话 `hub`。
> 命令与路径以 `src/main.ts` 实现为准；本文按**实际行为**写，未实现项明确标版本。
> 验收与已知限制见 [v0.0.2-acceptance.md](v0.0.2-acceptance.md)；GUI 联调见 [gui-integration-v0.0.2.md](gui-integration-v0.0.2.md)；线格式见 [protocol-v1.md](protocol-v1.md)。

---

## 1. 运行形态

```bash
# 单会话（v0.0.1 路径，行为不变）
matrix-core serve --cwd <项目目录> [--resume <id>] [--port 0]
                  [--mode ask|auto-edit|auto-all|plan] [--tier default|balanced|fast|deep_reasoning]
                  [--stdio] [--token-file <path>] [--dev-auth]

# 多会话 Hub（v0.0.2）
matrix-core hub [--cwd <默认项目目录>] [--port 0] [--token-file <path>] [--dev-auth]

# 生命周期 / 目录
matrix-core status | stop | doctor | version | help
bun run commands:gen      # 改 core/commands/registry.ts 后重生成 protocol/commands.json
```

- **`serve`**：一进程 = 一会话；`--stdio` 不监听端口（stdout 只出帧，日志 stderr）；默认 WS 只绑 `127.0.0.1` 随机端口。
- **`hub`**：Hub 进程**不跑 Agent**；每个会话 spawn 一个 `matrix-core serve --stdio --cwd <dir> [--resume id]` worker。Hub 负责 WS、会话路由、帧转发与流控。
- **发现文件**：`~/.neo/run/core.json`（原子写）：`{url,pid,tokenFile,sessionId,epoch,startedAt}`；Hub 的 `sessionId/epoch` 为空串（会话在 attach 后确定）。token 在 `~/.neo/run/core.token`（0600，64 hex，重启轮换）。
- **鉴权**：WS 子协议 `["neo.v1","bearer.<token>"]`；`--dev-auth` 时 `POST /api/auth/login {email,password}` 返回同一 token（仅回环 + Origin 白名单，非生产鉴权）。
- **Origin 白名单**：`http://127.0.0.1:*`、`http://localhost:*`、`tauri://localhost`；无 Origin（脚本）允许但需 token。
- **单写者 = 同一会话**：`~/.neo/run/locks/<id>/owner.json`（mkdir 独占 + pid 存活校验 + 陈旧锁回收）+ mailbox `.alive` 互认；同 session 双开 → `conflict`。Hub 不直接写会话文件（worker 写）。
- 两个不同会话/服务会互相覆盖 `core.json`（`status/stop` 指向最后写入者）；**没有** `--force` 接管（v0.0.3 候选）。

### Hub 会话语义（v0.0.2）

- `session.list` 返回**磁盘摘要**（`title` 由 id 派生、`provider:""`、`tier:"default"`、`mode:"ask"`；运行中 `status:"working"`）→ 准确值以 `session.attach` 的 `snapshot.meta` 为准。
- `session.create` → spawn worker 并返回 `sessionId`；`session.attach` → 复用/拉起 worker，回 `{role}` + **完整快照**（v0.0.2 不做增量回放）。
- `session.detach` 解绑连接（worker 保活）；`session.close` **只停 worker、不删会话文件**；再次 attach 会 `--resume` 重新拉起。
- **同一 session 同时只允许一个客户端 attach**（第二个 → `conflict`）；换会话先 detach（同一连接绑定一个 session）。
- 转发类命令（turn/abort/approval/question/command/settings/mode/usage/transcript.fetch/session.rename）走绑定的 session；未绑定时可显式带 `sessionId`；都没有 → `conflict`。

---

## 2. 目录与状态

| 路径 | 内容 | 备注 |
|---|---|---|
| `~/.neo/sessions/<id>.json` | messages + meta | 原子写；路径从 id 重算 |
| `~/.neo/sessions/transcripts/<id>.ndjson` | header(epoch) + durable 事件 | 可重建视图；torn line 丢弃并重写；回放用 `transcript.fetch` |
| `~/.neo/sessions/attachments/<sessionId>/img-N.<ext>` | 图片附件 | v0.0.2 新增；会话 JSON 存 `$ref`，resume hydrate |
| `~/.neo/run/core.json` / `core.token` | 发现 / 鉴权 | token 0600；core.json 原子写（Hub 的 sessionId/epoch 为空） |
| `~/.neo/run/locks/<id>/` | 单写者锁（owner.json） | 与 mailbox `.alive` 互认；只释放自己的锁 |
| `~/.neo/logs/turns/<date>.jsonl` | 轮次诊断 | worker 写（多进程容忍） |
| `~/.neo/logs/core/<date>.jsonl` | 结构化日志 | **未实现**（v0.0.3 候选；当前日志走 stderr + turn 诊断） |
| `~/.neo/mailbox/` | 身份/心跳/收件箱 | worker 启动创建身份并心跳 |
| `~/.neo/env/<machineKey>.json` | 环境事实 | 沿用 |
| `<cwd>/.neo/backups/<id>/` | 写文件检查点 | 经 PathPolicy 约束 |
| `<cwd>/.neo/wiki/` | 项目 wiki | 超长输出/导出同理 |
| `src/protocol/commands.json` | 命令目录（仓库内） | `bun run commands:gen` 生成；`docs:check` 校验漂移 |

---

## 3. 健康与排障

```bash
curl -s http://127.0.0.1:<port>/health
# serve: {"ok":true,"coreVersion":"0.0.2","protocolVersion":"1.2","state":"idle","uptimeMs":1234}
# hub:   {"ok":true,"mode":"hub","coreVersion":"0.0.2","protocolVersion":"1.2","sessions":2}
matrix-core status    # 读 core.json + pid 存活 → {..., "alive": true|false}
matrix-core doctor    # run 目录 / token / core.json（最小实现）
```

> 单会话 `/health` 的 `state` 仍恒为 `idle`（未接真实状态）；Hub 的 `/health` 报 `mode:"hub"` + 运行中 worker 数（`sessions`）。协议版本以常量/`ready` 为准。

| 现象 | 排查 |
|---|---|
| 连不上 | `core.json` 是否存在 / pid 是否存活（`status`）/ token 权限 / 端口 / Origin |
| 401 | token 随重启轮换 → 客户端重读 `core.json` + `core.token`；dev 登录重取 |
| `conflict` attach | 该 session 已被另一客户端占用（v0.0.2 单客户端）；或当前连接已绑定别的 session（先 detach） |
| `conflict` 发命令 | 未 attach 且命令没带 `sessionId`；先 attach |
| worker 起不来 | cwd 不存在 / settings 无可用 provider / `--resume` id 不存在；看 Hub stderr（`[hub] spawn worker…`、`[worker cwd] …`）；可单独 `serve --cwd …` 复现 |
| 会话被锁 | 确认无进程后清理 `run/locks/<id>/`；死进程的锁下次启动自动回收 |
| 客户端被断 4408 | 队列 512 帧/8MB 超限（慢消费者）：退避重连，attach 后以快照重建 |
| 附件 `too_large` | >5 张 / 单张 >5MB / 帧 >8MB；或 mime 不是 png/jpeg/webp |
| 图片历史不到 | `$ref` 未 hydrate / 附件目录被删；不要删 `sessions/attachments` |
| `/help` 与 `commands.json` 不一致 | 未跑 `bun run commands:gen`；`docs:check` 会红 |
| 工具报路径拒绝 | 目标在 cwd 外（PathPolicy）；用户级目录（skills/memory/wiki）是豁免项 |
| `session_gone` | worker 不存活/会话文件被外部改动；重新 attach（会 `--resume`） |
| Hub 退出后 worker 残留 | Hub 退出会给所有 worker SIGTERM；确认无遗留进程后可手工清理锁目录 |

---

## 4. 生命周期与锁

- **worker 启动顺序**：配置 → env → memory → mailbox → **锁** → session/transcript 对账 → 工具注册 → stdio ready。
- **锁**：`run/locks/<id>/owner.json {pid, epoch, startedAt}`（mkdir 独占）+ pid 存活校验（EPERM 算存活）+ 陈旧锁 rename 抢占 + 只释放自己的锁；与 mailbox `.alive` 互认。
- **Hub 停止（SIGTERM/SIGINT）**：停收帧 → 关闭所有连接/batcher → 对所有 worker SIGTERM →（500ms 后 SIGKILL 兜底）→ 清理 `core.json` → 退出。
- **worker 停止**：SIGTERM → 收口待决项 → 轮中发 `turn.aborted{shutdown}` → 修 messages 尾 → persist → memory.flush → 释放锁。
- **worker 崩溃**：Hub 检测退出 → 删除运行态、向 attach 的客户端发 `session.status{status:"dead"}` 并解绑；**不自动重启**（无退避），下次 attach 重新 spawn `--resume`，以磁盘 transcript/messages 恢复到最后完成轮。
- **空闲回收**：**未实现**（v0.0.3 候选）；worker 会一直驻留到 close/detach 策略或 Hub 退出。
- **Hub 退出**：给所有 worker SIGTERM（500ms 后 SIGKILL 兜底）；Hub 异常退出时 worker 的 stdin 关闭 → 自行优雅收尾（落盘/释放锁），随后可被新 Hub `--resume`。
- **session.close**：只停 worker、不删会话文件；再 attach 走 resume。

---

## 5. 与 neo CLI 共存

- 共享 `~/.neo`：sessions/transcript/attachments/mailbox/logs/tmp。
- **同一 session id 禁止双开**（core 锁 + CLI mailbox `.alive` 互认）；Hub 下同一 session 还受「单客户端」限制。
- 交替使用允许：旧 CLI 写 messages 后，core 打开时按 D6 对账（transcript 落后 → 从 messages 重建并标 degraded）。
- 旧 CLI 忽略 transcript/attachments；core 不修改旧 CLI 的 `meta.path` 语义（写入前从 id 重算）。
- 日志：worker 写 stderr + `logs/turns/`；`logs/core/` 分区未实现。
- 切换前建议**备份 `~/.neo/sessions`**；`matrix-core import` 未实现（v0.0.3 候选）。

---

## 6. 升级与回滚

- **v0.0.1 → v0.0.2**：协议 v1.1→v1.2（加性，无破坏性）；会话/transcript 格式不变；新增 `attachments/` 目录与 `commands.json`（仓库内）。单会话 `serve` 行为兼容，旧客户端可不改。
- 升级前看 `ready.capabilities`（单会话 8 项；Hub 9 项含 `sessions`）与 `protocolVersion`（1.2）；客户端 conformance 失败拒绝连接。
- 回滚到 v0.0.1：会话文件可直接读；v0.0.1 忽略附件字段（历史文本不受影响）；不要用 v0.0.1 继续发图片。
- 保留 tag `v0.0.1`；协议破坏性变更才升 v2（当前没有）。

---

## 7. 打包与分发（未交付）

- `bun build --compile` 单文件、bin `matrix-core`、checksum：v0.0.3 候选。
- 编译后**配置根**不能用 `import.meta.url` 推包根：按「`--config-root` → `MATRIX_CORE_ROOT` → 可执行文件目录 → `~/.neo`」解析。

---

## 8. 安全清单（v0.0.2 实况）

- 只绑 `127.0.0.1`；token 0600（64 hex）；日志不打印 token；`--dev-auth` 默认关。
- Origin 白名单；非白名单 403；WS 鉴权失败 4401。
- 密钥只在 core 内存 + 本地 settings（`~/.neo/settings.json` 推荐；含 key 的 `settings.json` 已被 `.gitignore` 忽略）；协议只给掩码；e2e 扫描协议帧/stderr/transcript/日志无明文 key。
- **PathPolicy（v0.0.2 已接入）**：read/write/edit/list_dir/glob/grep 的路径参数、`@refs`、checkpoint undo 走 `core/path.ts`（cwd + realpath + symlink；`session.export` 未交付）；`..` 逃逸/外部绝对路径/symlink 逃逸拒绝。**已知窗口**：`resolveWrite` 校验后到实际写入之间目标可能被换成 symlink（v0.0.3 O_NOFOLLOW）。
- 附件：mime 三选一 + ≤5 张/≤5MB，超限 `too_large`；入站帧 >8MB → `too_large`；原始 base64 不写日志/transcript。
- 注意：v0.0.2 协议不回传附件元数据 → 历史轮次图片不可渲染（v0.0.3）。
- `plan` 只读；shell 每次审批；allow-session 仅按工具名 `write_file`/`edit_file` 内存记忆（shell 永不；**不校验 cwd/路径**）。
- 目录 0700，会话/日志/token 文件 0600。

---

## 9. 证据与验收

```bash
bun run commands:gen        # 命令目录变更后
bash scripts/verify.sh      # tsc → unit+guards → e2e → docs
# 证据：docs/evidence/v0.0.2-{tsc,unit,e2e,docs}.txt
```

发布前：`verify.sh` ALL GREEN；`docs:check` 通过（协议 lock 7 文件 + `commands.json` 一致）；release notes/README/AGENTS 更新；tag `v0.0.2`。
