# 代码与协议来源（Provenance）

> 状态：draft v0.2 · 2026-10-28
> 用途：记录本仓代码从哪里来、按什么规则同步、哪些是新增。D1/D2 要求仓库独立，因此**没有子模块、没有 file: 依赖**，只有一次性移植 + 本仓演进。

---

## 1. 来源

| 来源仓 | 路径 | 提交 | 说明 |
|---|---|---|---|
| `neo` | `/Users/xueyuheng/research/000-alice-new/neo` | `1da7c6f`（`v0.4.2-4-g1da7c6f`，v0.4.3 收尾，未打 tag） | 核心运行时与对应测试。基线：**1052 pass / 0 fail / 67 文件 + PTY 21/21**（2026-10-28 实跑） |
| `neo-agent-app` | `/Users/xueyuheng/research/000-alice-new/neo-agent-app` | `a52f1f0` | WS 协议 v1 原型（types/guards/fixtures）+ GUI reducer 参考（`gui/src/state/session.ts`） |

协议文件 SHA-256（源，2026-10-28）：

```
4c96cf508db01743ca27e7d5b084545768cf6b508425b758d0c1d2292786675c  gui/src/protocol/types.ts
19e2d55821f40d06252db544a6d10c7a4efc8db91fc3ec6a0b8bda91dda2e217  gui/src/protocol/guards.ts
a832b2433427faad9e96d187b9077d27aa2eca125d6ace7f73ded25cc0a536d7  gui/src/protocol/fixtures.ts
80264be8e3738f802eb2b9955c81fcc298444e87ab62397c938483879450f0d3  gui/src/protocol/index.ts
```

> `tests/README.md` 里「1051 pass / 1 fail」是旧口径；2026-10-28 实跑与 `docs/evidence/v0.4.3-tests.txt` 均为 **1052/0**。

---

## 2. 移植清单

### 2.1 第一批（C0b，纯模块，无 ui 依赖）

| 模块 | neo 路径 | 备注 |
|---|---|---|
| llm | `src/llm.ts` | 原样 |
| config | `src/config.ts` | C1 加 `cwd` 参数（去 `process.cwd` 依赖） |
| classifier | `src/classifier/` | 原样 |
| memory | `src/memory/` | 原样 |
| wiki | `src/wiki/` | 原样 |
| mailbox | `src/mailbox/` | 原样（身份/锁/心跳） |
| env | `src/env/` | 原样 |
| skills | `src/skills.ts` | 原样 |
| （不搬）system-prompt | `src/system-prompt.ts` | **C1 再搬**：它 value-import `toolNames` → tools → ui，C0b 会编译不过；C1 先拆 `toolNames` 纯常量或改注入 |
| session | `src/session.ts` | C1/C2 增加 transcript/锁/路径重算；图片 `$ref` 逻辑保留 |

| checkpoint | `src/checkpoint.ts` | 原样；C1 接 PathPolicy |
| shell | `src/shell.ts` | 原样（唯一真源规则继续） |
| contextWindow | `src/contextWindow.ts` | 原样 |
| turnDiagnostics | `src/turnDiagnostics.ts` | 原样；C2 日志分区 |
| maintenance | `src/maintenance.ts` | 原样；C2 与 core 清理互斥 |
| runtimeTmp | `src/runtimeTmp.ts` | 原样；C1 改 outputRef 不透明 id |

**不移植（留在 CLI）**：`src/ui/`、`src/tui/`、`src/input/`（`references.ts` 除外，见下）、`attachments.ts`、`paste.ts`、`clipboard.ts`、`hotkeys.ts`、`index.ts`、`git.ts`（只服务状态栏）。

### 2.2 第二批（C1，先建端口再搬）

| 模块 | 处理 |
|---|---|
| agent | 移植后立即事件化：去 `ui/*`、去 `process.stdout.isTTY`、去 40 处 console；`AskUserRequest/Answer` 从 `ui/askUser.ts` 迁入 `core/ports.ts` |
| tools | 移植 `tools/index.ts`、各工具、`task.ts`、`shellMarks/fileList/webSearch`；去 ui 依赖；`ToolOutcome` + outputRef |
| askUser | `tools/askUser.ts` 保留但不 import ui；DTO 来自 `core/ports.ts` |

### 2.3 需要重写（不直接复制）

| 能力 | 原因 | 方案 |
|---|---|---|
| `@refs` 解析 | `input/references.ts` 属于客户端；协议要求 core 在 cwd 内解析 | C1 重写 `core/refs.ts`（PathPolicy + 预算 + 截断/错误） |
| 会话命名 | `src/sessionName.ts` 是 CLI 侧随机角色池 | C1/C2 在 core 实现（createIdentity/rename 需要） |
| 导出 | `src/sessionExport.ts` 依赖 CLI 渲染 | C2 在 core 实现 `session.export`（markdown/json） |
| 附件 | `paste/clipboard` 在客户端；`session.ts` 的 `$ref` 序列化保留 | v1.2 加协议附件 |
| probe 客户端 | neo 没有 `scripts/probe` | C1 新建（fake-LLM + 脚本化客户端） |

### 2.4 测试移植

- 基线：neo **1052 pass / 0 fail / 67 文件**（实跑）。
- 只搬不依赖 `ui/tui/input/index/agent spawn` 的测试；用 `scripts/deps-scan.ts`（C0b.1）生成清单，写入本节。
- 入口 spawn 类（cli-json、skills-cli、skills-command、tier-command、commands）留在 neo。
- 依赖 agent/tools 的测试随 C1 移植（先完成端口）。

---

## 3. 协议抽取

| 文件 | 来源 | 处理 |
|---|---|---|
| `types.ts` / `guards.ts` / `fixtures.ts` / `index.ts` | `neo-agent-app/gui/src/protocol/` | 原样复制 → 按 protocol-v1.md 做**加法**（不重命名） |
| `reducer.ts` | **不存在于 protocol/**；来自 `gui/src/state/session.ts` 的 `applyEvent` | C0.2 提取纯函数到 `protocol/reducer.ts` + 补 fixtures；GUI 继续用自己的副本并跑 conformance |
| `commands.json` | 新生成 | C1.7 由 core 命令注册表生成 |

---

## 4. 同步规则

- 移植是一次性的；C0b/C1 合并后本仓为**唯一真源**。
- `neo` 冻结：只接受 critical hotfix；不向本仓双向同步功能。
- 必须从 neo cherry-pick 时：在本仓重新实现/移植，并在 `.neo/wiki/wiki/log.md` 记一条，附 neo 提交号。
- 协议变更按 `protocol-v1.md` §10 的 vendoring 流程同步客户端。

---

## 5. 已知差异（移植时主动修改）

| 文件 | 改动 | 原因 |
|---|---|---|
| `agent.ts` | 去 UI/事件化；`streaming` 取代 `isTTY`；delta/end.text 权威 | D4 |
| `tools/*` | 审批/提问走 port；`ToolOutcome`；outputRef 不透明 id | D4/D7 |
| `session.ts` | transcript/epoch/锁/原子写/路径重算/尾部修复 | D6/D15 |
| `config.ts` | `loadConfig({cwd})`；项目级明文 key 告警 | 会话 cwd / 安全 |
| `commands/*` | 新写（从 `index.ts` 的 `handleCommand` 迁移） | D8 |
| 日志 | 结构化 + stderr 纪律 + 分区 | 观测/共存 |
| 路径 | 统一 `PathPolicy` | D13 |
| 脱敏 | EventSink/persist/logger 边界 | D14 |

---

## 6. 许可与归属

私有仓库；代码来自用户自有项目 `neo`，无第三方许可冲突。运行时仅依赖 Bun（无外部运行库）。
