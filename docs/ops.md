# Matrix-Core 运维手册（v0）

> 状态：draft v0.2 · 2026-10-28
> 适用：**未发布**。命令与路径以实现为准；本文随 C2/C3 更新。

---

## 1. 运行形态

```
matrix-core serve --cwd <项目目录> [--resume <id>]
                  [--port 0] [--mode ask] [--tier default]
                  [--stdio] [--token-file <path>] [--dev-auth]
matrix-core status | stop | doctor | version
# 客户端在 pending 审批/提问时每 ≤60s 发 ping（liveness，续期 deadline）
matrix-core import <session-id>     # 只读导入旧会话（不写 transcript）
```

- `--port 0`（默认）：随机端口，写 `~/.neo/run/core.json`。
- `--stdio`：不监听端口，stdin/stdout 行分隔帧（测试/PTY/嵌入）。
- 一进程 = 一会话（v0）；多会话等 `matrix-core hub`（v0.5）。
- **单实例**：`core.json` 原子写（tmp+rename）+ pid 校验；已有存活实例时拒绝启动（`--force` 才能接管）。旧 `core.json` 不作为「存活」依据。

启动成功后：

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

客户端发现：显式 `--core-url/--token` → `MATRIX_CORE_URL/TOKEN` → `~/.neo/run/core.json`。

---

## 2. 目录与状态

| 路径 | 内容 | 备注 |
|---|---|---|
| `~/.neo/sessions/<id>.json` | messages + meta | 与 neo v0.4.3 兼容；原子写；路径从 id 重算 |
| `~/.neo/sessions/transcripts/<id>.ndjson` | header(epoch) + durable 事件 | 新增；可重放；torn line 容错 |
| `~/.neo/sessions/attachments/<id>/` | 图片附件 `$ref` | 沿用 |
| `~/.neo/run/core.json` / `core.token` | 发现/鉴权 | token 0600；core.json 原子写 |
| `~/.neo/run/locks/<id>/` | 单写者锁（owner.json） | 与 mailbox `.alive` 互认 |
| `~/.neo/logs/core/<date>.jsonl` | core 结构化日志 | 仅 core 命名空间；CLI 不写 |
| `~/.neo/logs/turns/<date>.jsonl` | 轮次诊断 | 沿用；多进程写需容忍 |
| `~/.neo/mailbox/` | 身份/心跳/收件箱 | 沿用 |
| `~/.neo/env/<machineKey>.json` | 环境事实 | 沿用 |
| `<cwd>/.neo/backups/<id>/` | 写文件检查点 | 沿用；C1 接 PathPolicy |
| `<cwd>/.neo/wiki/` | 项目 wiki | 沿用 |

---

## 3. 健康与排障

```bash
curl -s http://127.0.0.1:<port>/health
# {"ok":true,"coreVersion":"0.1.0","protocolVersion":"1.1","state":"idle","uptimeMs":1234}
matrix-core status
matrix-core doctor --cwd <dir>
```

| 现象 | 排查 |
|---|---|
| 连不上 | `core.json` 是否存在/pid 是否存活/token 权限/端口/Origin |
| 401 | token 轮换（重启）→ 客户端重读 |
| 会话被锁 | 确认无进程后清理 `run/locks/<id>/`；或等 pid/心跳过期回收 |
| `session_gone` | 锁/文件不匹配；`--resume <id>` 重建 |
| 卡在 working | `logs/core`/`logs/turns`；审批是否 pending；LLM 连通 |
| 崩溃恢复 | 启动自动对账 + 补 `turn.aborted{crash}`；检查 messages/transcript 尾部 |
| 双开被拒 | 正常；确认旧进程（含 neo CLI）已退出 |

---

## 4. 生命周期与锁

- 启动顺序：配置 → env → memory → mailbox → **锁** → session/transcript 对账 → 工具注册 → 监听。
- 锁：`run/locks/<id>/owner.json {pid, epoch, startedAt}`（mkdir 独占）；与 mailbox `.alive` 互认；pid 死亡/心跳超时 → 回收。
- 优雅关闭（SIGTERM/SIGINT）：停止收帧 → abort（修 messages 尾部）→ memory.flush → persist → 释放锁 → 退出（10s 宽限，二次信号强退）。
- 崩溃：锁残留按 pid/心跳回收；transcript 修复；不会把半轮当成功。

---

## 5. 与 neo CLI 共存

- 共享 `~/.neo`：sessions/transcript/mailbox/logs/tmp。
- **同一 session id 禁止双开**（core 锁 + CLI mailbox `.alive` 互认）。
- 交替使用允许：旧 CLI 写 messages 后，core 打开时按 D6 对账（transcript 落后 → 从 messages 重建并标 degraded）。
- 旧 CLI 忽略 transcript；core 不修改旧 CLI 的 `meta.path` 语义（写入前从 id 重算）。
- 日志分区：core 只写 `logs/core/`；`logs/turns` 容忍并发；maintenance 清理只碰自己命名空间。
- 切换前建议 `matrix-core import <id>` 只读验证 + 备份 sessions。

---

## 6. 升级与回滚

- core 与协议独立版本：升级前看 `ready` 的版本/能力；客户端 conformance 失败拒绝连接。
- 回滚：保留上一个 tag；session 文件 `version:1` 向后兼容；transcript 只追加。
- 协议 v2：双版本过渡，禁止直接切换。

---

## 7. 打包与分发（C3）

- `bun build --compile` 生成单文件（可选）；bin 名 `matrix-core`。
- 编译后**配置根**不能用 `import.meta.url` 推包根：按「`--config-root` → `MATRIX_CORE_ROOT` → 可执行文件目录 → `~/.neo`」解析。
- 干净容器 quick start 作为发布验收；产物带 checksum。

---

## 8. 安全清单

- 只绑 `127.0.0.1`；token 0600；日志不打印 token。
- Origin 白名单；`--dev-auth` 默认关，启用时仍限回环 + Origin。
- 密钥只在 core 内存 + 本地 settings；协议只掩码；transcript/日志脱敏（D14）。
- 文件操作统一 `PathPolicy`（cwd + realpath + symlink）；`outputRef` 不暴露路径。
- `plan` 只读；shell 每次审批；allow-session 不覆盖 shell。
- 目录 0700，会话/日志/token 文件 0600。

---

## 9. 证据与验收

```bash
bash scripts/verify.sh
# tsc → 单元/契约/集成 → e2e → guards → docs:check
# 证据：docs/evidence/<version>-{tsc,tests,e2e,guards,docs}.txt
```

发布前：verify ALL GREEN；`doctor` 干净环境通过；release notes 更新；wiki `log.md` 追加 milestone；tag 推送。
