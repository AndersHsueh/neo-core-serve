# 联调-neo-agent-app-v0.1.0

> 最后更新:2026-10-29

## 摘要

2026-10-29，`neo-agent-app`（Preact GUI）完成与 **Matrix-Core v0.0.2 Hub 的真实联调**，不再使用 `dummy-serv` 仿真。GUI 侧交付 `v0.1.0`（tag `v0.1.0` → commit `de68bcc`）：发现即登录、多会话绑定、流式渲染（含完整 markdown）、审批/提问、命令面板、图片附件、断线/崩溃恢复；e2e 切真实 Hub + 真实 LLM，**12 用例全绿**，单测 **47 pass**，Hub 协议探测 **14 PASS / 0 FAIL**。联调同时暴露 7 项后端问题/文档纠偏（create 落盘时机、worker 不回收、握手 401 vs 4401 等），已记入 GUI 仓联调报告，作为 v0.0.3/文档修订输入。

## 背景

v0.0.2 发布时 GUI 联调（验收清单 J2–J5）仍为 ⬜，`docs/gui-integration-v0.0.2.md` 只是改动指南。本次由 Lead + 三个子代理（协议探测 / 渲染层 / e2e）完成端到端接入，验证「三仓独立、只靠协议契约协作」这条架构假设。

## GUI 侧交付（对应联调指南 §7 的 7 处改动）

- **发现**：dev 由 Vite 中间件代读 `~/.neo/run/core.json` + `core.token`，`GET /__neo/endpoint` 返回 `{url, token, user, coreVersion, protocolVersion}`；客户端「发现即登录」，重连时重新发现（Hub 重启换端口/token）。
- **握手/传输**：`neo.v1` + `bearer.<token>` 子协议；401/1002/1006/4408 统一退避重连；ready 超时；发现成功即上抛 endpoint（WS 抖动时进工作台 + 离线横条，而非卡登录页）。
- **会话**：`list/create/attach/detach/close/rename`；单连接单会话（换会话串行 detach→attach）；`create` 必带 title；close 后自动切下一条；再 attach 走 resume。
- **渲染**：协议 v1.2 vendor（types/guards/fixtures/reducer/commands.json）+ 客户端补丁；`assistant.end.text`/`reasoning.end.text` 权威覆盖；v1.2 新块；**助手正文完整 markdown（GFM 表格/标题/列表/代码块/引用/链接，零依赖全量转义）**。
- **交互**：审批（无 diff 显示 detail、deadline 倒计时）、AskUser（单选/多选/自由输入）、命令面板由 `commands.json` 生成（`/tier fast` 带参、未知命令回执、`.cmdresult`）、图片附件（选择/粘贴/预览，≤5 张 / 单张 ≤5MB）。
- **可靠性**：刷新/断线以完整快照重建、乐观消息按 clientId 去重；worker 崩溃自动 re-attach；`transcript.fetch` 分页；离线兜底页 + 重试。

## 验证结果

| 项 | 结果 |
|---|---|
| GUI `tsc --noEmit` | 0 error |
| GUI vitest | 47 pass / 5 files（含 vendor 一致性 13 条、markdown 14 条） |
| GUI Playwright（真实 Hub + 真实 LLM） | **12 pass / 0 fail**（约 40–47s，连续 5 次） |
| GUI `vite build` / biome | 绿 / 0 error |
| Hub 协议探测（`neo-agent-app/scripts/probe-hub.ts`） | **14 PASS / 0 FAIL**（`--no-llm` 11 PASS / 3 SKIP） |
| 覆盖 §8 | 发现即登录/capabilities、list/create/attach、流式+stats+end.text、两会话并行、close/resume、刷新快照不重影、transcript.fetch、附件+too_large、Hub 不可达（503 与坏 url） |
| 人工冒烟补覆盖 | 审批 allow、AskUser 单选/多选/自由输入、worker 崩溃恢复、命令面板、markdown 表格 |
| 未覆盖（客观/受控条件） | 4408 慢消费者、>8MB 单帧、非 owner close→forbidden、带 diff 审批、Windows/Linux |

## 联调暴露的后端问题 / 文档纠偏（输入 v0.0.3）

| # | 问题 | 影响 |
|---|---|---|
| H1 | `session.create` 不带 `title` 时不落盘 → 紧接着 `attach` 必然 `not_found`（协议里 title 仍是可选） | 按协议可选字段调用必踩；GUI 只能强制带 title 规避 |
| H2 | `--cwd` 指向不存在目录时 Hub 无启动校验；worker `Bun.spawn` 报 `ENOENT` 且指向 bun 可执行文件 | 排查成本极高（本次实际踩到并误判） |
| H3 | `detach` 不回收 worker、无空闲回收（E4 未交付） | 联调期间累积 76 worker / 峰值 ~5.6GB RSS；长时间切会话会堆进程 |
| H4 | 握手鉴权失败实测 **HTTP 401 + close 1002（浏览器 1006）**，联调指南写「直接关闭 4401」 | 客户端若只判 4401 会漏掉 token 轮换/被拒 |
| H5 | `session.list` 的 title 恒为 `会话 <id后6位>`、provider/tier/mode 占位 | GUI 列表显示假标题；真源只能是 `snapshot.meta` |
| H6 | `turn.aborted`/`compact.start`/`command.result` 不进快照块；`compact.end` 硬编码中文 banner | 各客户端自行合成提示（GUI 已做） |
| H7 | 附件历史不回传元数据（已知限制） | 刷新/重连后图片消失（v0.0.3 计划） |

> 另：验收清单 J2–J5 已具备真实证据，可在 `docs/v0.0.2-acceptance.md` 回填 ✅（待做）。

## 环境与副作用（已清理）

- 新建 `~/.neo/settings.json`（0600，provider 取自用户 `neo/settings.json`）作为用户级 LLM 配置；`neo-core-serve/current_prj` 缺失已补建（Hub 的 `--cwd`）。
- 联调产生的测试会话（`新会话*` / `probe-*` / `e2e-*`，约 150 个）与泄漏 worker 已清理；Hub 已 `matrix-core stop` 优雅退出，`~/.neo/run/core.json` 已清；Vite dev server 已停。
- Hub 全程未重启，未修改 core 仓源码。

## 关联

- GUI 仓：`neo-agent-app`（tag `v0.1.0`，commit `de68bcc`）
- 联调报告：[`neo-agent-app/docs/integration-v0.0.2-report.md`](https://github.com/AndersHsueh/neo-agent-app/blob/de68bcc/docs/integration-v0.0.2-report.md)
- Hub 实测清单：[`neo-agent-app/docs/hub-probe-findings.md`](https://github.com/AndersHsueh/neo-agent-app/blob/de68bcc/docs/hub-probe-findings.md)
- 协议 vendor 补丁：[`neo-agent-app/docs/vendor-patches.md`](https://github.com/AndersHsueh/neo-agent-app/blob/de68bcc/docs/vendor-patches.md)
- 界面证据：`neo-agent-app/docs/shots/integration-v0.0.2/`
- 本仓：[[发布-v0.0.2]] · [[协议-Matrix-Core-v1]] · [[边界与迁移]] · 联调指南 `docs/gui-integration-v0.0.2.md`

## 后续

1. v0.0.3：H1（create 即落盘 / title 语义）、H3（worker 空闲回收）、H4/H5 文档与摘要字段修正、附件元数据回传。
2. 回填 `docs/v0.0.2-acceptance.md` J2–J5 证据状态。
3. GUI 侧：Tauri 壳实现 `/__neo/endpoint` 契约；长会话虚拟化；会话列表分页。
4. C5：CLI 切纯客户端（依赖本仓协议稳定）。
