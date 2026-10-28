# Matrix-Core 运维手册（v0.0.1）

> 状态：**v0.0.1（2026-10-28）** · 适用：单会话核心服务。
> 命令与路径以 `src/main.ts` 实现为准；本文按**实际行为**写，未实现项明确标「v0.0.2」。
> 验收与已知限制见 [v0.0.1-acceptance.md](v0.0.1-acceptance.md)；线格式见 [protocol-v1.md](protocol-v1.md)。

---

## 1. 运行形态

```
matrix-core serve --cwd <项目目录> [--resume <id>]
                  [--port 0] [--mode ask] [--tier default]
                  [--stdio] [--token-file <path>] [--dev-auth]
matrix-core status | stop | doctor | version | help
```

- `--port 0`（默认）：随机端口，只绑 `127.0.0.1`，写 `~/.neo/run/core.json`。
- `--stdio`：不监听端口，stdin/stdout 行分隔帧（测试/PTY/嵌入）；stdout 只出帧，日志走 stderr。
- 一进程 = 一会话（v0.0.1）；多会话等 Hub（v0.0.2+）。
- **单写者 = 同一会话**：`~/.neo/run/locks/<id>/owner.json`（mkdir 独占 + pid 存活校验 + 陈旧锁回收），并与 mailbox `.alive` 互认；同 session 双开 → `conflict` + 退出码 2。
- **`core.json` 是发现文件**：原子写（tmp+rename），含 `url/pid/tokenFile/sessionId/epoch/startedAt`；**不做**基于它的 pid 拦截，也**没有** `--force` 接管（v0.0.2）。两个不同会话的 core 会互相覆盖该文件（`status/stop` 指向最后写入者）。
- 客户端发现：v0.0.1 直接读 `~/.neo/run/core.json`；`--core-url/--token`、`MATRIX_CORE_URL/TOKEN` 环境变量发现**未实现**（v0.0.2）。

启动成功后 stderr 打印 session/epoch/ws/token/run 路径；`core.json` 形态：

```json
{
  "url": "ws://127.0.0.1:54321/ws",
  "pid": 12345,
  "tokenFile": "/Users/<user>/.neo/run/core.token",
  "sessionId": "20261028-153012-ab12cd",
  "epoch": "9f3c…",
  "startedAt": "2026-10-28T15:30:12+08:00"
}
```

---

## 2. 目录与状态

| 路径 | 内容 | 备注 |
|---|---|---|
| `~/.neo/sessions/<id>.json` | messages + meta | 原子写；路径从 id 重算；与 neo v0.4.3 兼容 |
| `~/.neo/sessions/transcripts/<id>.ndjson` | header(epoch) + durable 事件 | 可重建视图；torn line 丢弃并重写；**v0.0.1 attach 总是快照，不做增量补齐** |
| `~/.neo/sessions/attachments/<id>/` | 图片附件 `$ref` | 协议 v1.2 才启用（v0.0.1 无附件） |
| `~/.neo/run/core.json` / `core.token` | 发现 / 鉴权 | token 0600（64 hex）；core.json 原子写 |
| `~/.neo/run/locks/<id>/` | 单写者锁（owner.json） | 与 mailbox `.alive` 互认；只释放自己的锁 |
| `~/.neo/logs/turns/<date>.jsonl` | 轮次诊断 | 沿用移植实现；多进程写需容忍 |
| `~/.neo/logs/core/<date>.jsonl` | 结构化日志 | **v0.0.1 未实现**（日志走 stderr + turn 诊断）；v0.0.2 |
| `~/.neo/mailbox/` | 身份/心跳/收件箱 | 沿用；core 启动会创建身份并心跳 |
| `~/.neo/env/<machineKey>.json` | 环境事实 | 沿用 |
| `<cwd>/.neo/backups/<id>/` | 写文件检查点 | 沿用（PathPolicy 未接入，见 §8） |
| `<cwd>/.neo/wiki/` | 项目 wiki | 沿用 |

---

## 3. 健康与排障

```bash
curl -s http://127.0.0.1:<port>/health
# {"ok":true,"coreVersion":"0.0.1","protocolVersion":"1.1","state":"idle","uptimeMs":1234}
matrix-core status    # 读 core.json + pid 存活 → 输出 {..., "alive": true|false}；无文件打印「未运行」
matrix-core doctor    # 检查 run 目录 / token / core.json（最小实现）
```

> `/health` 的 `state` 在 v0.0.1 **恒为 `idle`**（未接真实状态）；`protocolVersion` 为字面量。v0.0.2 修。

| 现象 | 排查 |
|---|---|
| 连不上 | `core.json` 是否存在 / pid 是否存活（`status`）/ token 权限 / 端口 / Origin |
| 401 | token 随重启轮换 → 客户端重读 `core.json` + `core.token` |
| 会话被锁 | 确认无进程后清理 `run/locks/<id>/`；死进程的锁下次启动自动回收 |
| `session_gone` | 会话文件不匹配/被外部改动；`--resume <id>` 重建 |
| 卡在 working | `~/.neo/logs/turns/` + stderr；审批是否 pending；LLM 连通 |
| 崩溃恢复 | 启动自动对账 + 补 `turn.aborted{crash}`；检查 messages/transcript 尾部 |
| 双开被拒 | 正常；确认旧进程（含 neo CLI）已退出 |
| `status` 指向旧进程 | 不同会话的两个 core 会覆盖 `core.json`；以 `alive` 字段为准 |

---

## 4. 生命周期与锁

- 启动顺序：配置 → env → memory → mailbox → **锁** → session/transcript 对账 → 工具注册 → 监听/stdio。
- 锁：`run/locks/<id>/owner.json {pid, epoch, startedAt}`（mkdir 独占）；与 mailbox `.alive` 互认；pid 死亡/心跳超时 → 回收；只释放自己的锁。
- 优雅关闭（WS 与 stdio 同样处理 SIGTERM/SIGINT）：先 `host.close()`（收口待决项 → 轮中中止发 `turn.aborted{shutdown}` → 修 messages 尾部 → persist → memory.flush → 释放锁）→ 再 `ws.stop()` → 清 `core.json` → 退出。**顺序不能反**：先关 WS 会让客户端收不到终态事件。内部超时兜底 host 2s / ws 1.2s（非架构文档里的 10s 宽限）。
- stdio 模式：stdin 关闭 或 SIGTERM/SIGINT = 优雅关闭；轮中被 SIGTERM 时会发 `turn.aborted{shutdown}`、释放锁，可 `--resume`（e2e/resilience 覆盖）。
- 中止原因：`turn.aborted.reason` 取 `user` / `shutdown` / `crash`。
- 崩溃：锁残留按 pid 回收；transcript 修复；半轮标 `turn.aborted{crash}`，不会把半轮当成功。

---

## 5. 与 neo CLI 共存

- 共享 `~/.neo`：sessions/transcript/mailbox/logs/tmp。
- **同一 session id 禁止双开**（core 锁 + CLI mailbox `.alive` 互认）。
- 交替使用允许：旧 CLI 写 messages 后，core 打开时按 D6 对账（transcript 落后 → 从 messages 重建并标 degraded）。
- 旧 CLI 忽略 transcript；core 不修改旧 CLI 的 `meta.path` 语义（写入前从 id 重算）。
- 日志：core 目前写 stderr + `logs/turns/`；**没有** `logs/core/` 分区（v0.0.2）。
- 切换前建议**备份 `~/.neo/sessions`**；`matrix-core import` 未实现（v0.0.2）。

---

## 6. 升级与回滚

- core 与协议独立版本：升级前看 `ready` 的版本/能力；客户端 conformance 失败拒绝连接。
- 回滚：保留上一个 tag（当前 `v0.0.1`，上一可运行快照为 C0 骨架）；session 文件 `version:1` 向后兼容；transcript 只追加。
- 回滚后旧 core 不认新 transcript → 从 messages 有损重建（标 degraded，新 epoch）。
- 协议 v2：双版本过渡，禁止直接切换。

---

## 7. 打包与分发（v0.0.2，未交付）

- `bun build --compile` 生成单文件（可选）；bin 名 `matrix-core`。**v0.0.1 不做**。
- 编译后**配置根**不能用 `import.meta.url` 推包根：按「`--config-root` → `MATRIX_CORE_ROOT` → 可执行文件目录 → `~/.neo`」解析。
- 干净容器 quick start 作为发布验收；产物带 checksum。

---

## 8. 安全清单（v0.0.1 实况）

- 只绑 `127.0.0.1`；token 0600（64 hex）；日志不打印 token。
- Origin 白名单；`--dev-auth` 默认关，启用时仍限回环 + Origin。
- 密钥只在 core 内存 + 本地 settings（`settings.json` 已被 `.gitignore` 忽略）；协议只给掩码；e2e 扫描协议帧/stderr/transcript/日志无明文 key。
- **路径**：v0.0.1 **未接入** PathPolicy（沿用 neo 的路径检查，`insideCwd` 未全量调用）→ **已知安全缺口**，v0.0.2 修；`outputRef` 未暴露路径（`output.get` 未实现）。
- `plan` 只读；shell 每次审批；allow-session 仅按工具名 `write_file`/`edit_file` 内存记忆（shell 永不；**不校验 cwd/路径**，PathPolicy 未交付）。
- 目录 0700，会话/日志/token 文件 0600。

---

## 9. 证据与验收

```bash
bash scripts/verify.sh
# tsc → unit/guards → e2e → docs:check
# 证据：docs/evidence/v0.0.1-{tsc,unit,e2e,docs}.txt
```

发布前：`verify.sh` ALL GREEN；`doctor` 通过；release notes 更新；wiki `log.md` 追加 milestone；tag 推送。
