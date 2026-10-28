# 计划-Matrix-Core-v0

> 最后更新:2026-10-28

## 摘要

v0 分五段：C0 协议冻结 + 骨架（3d）→ C0b 纯核心移植（4d，只搬无 ui 依赖模块）→ C1 端口/事件化（15d）→ C2 协议与服务（16d，含 session shims、持久化/锁/恢复、e2e、GUI conformance）→ C3 硬化（9d，混沌/打包/安全/v0.1.0）。v0 合计 **47 人日（≈9–10 周）**；v0.5 Hub 15d；CLI 切换（C5，10d+）另立。基线：neo 1052 pass/0 fail/67 + PTY 21/21（2026-10-28 实跑/evidence）。详见 `docs/work-plan.md`。

## 里程碑

| 阶段 | 出口 | 估算 |
|---|---|---|
| C0 | 协议冻结（判别名不动）+ reducer/fixtures + 命令 schema + 骨架 | 3d |
| C0b | 只搬纯模块与测试；tsc/测试绿；守卫第一层 | 4d |
| C1 | 端口（PathPolicy/Clock/Timer/Random/脱敏/审批提问）、agent 事件化、组合根、命令层、golden | 15d |
| C2 | serve/WS/stdio、session shims、持久化/锁/恢复、e2e、GUI 联调 | 16d |
| C3 | 混沌、打包/stop/status、安全、文档、v0.1.0 tag | 9d |
| C4 | Hub + worker 池 + GUI 多会话 | 15d |

## 关键约束

- C0 不能直接搬 agent/tools：它们 import `ui/*`；先 C0b 纯模块，C1 建端口后再搬。
- 路径/脱敏先于持久化（C1.2/C1.3 早于 C2 落盘）。
- 锁与 neo CLI 的 mailbox `.alive` 互认；路径从 id 重算。
- 协议/文档/命令目录同一 commit；`docs:check` 闸门。

## 风险

最高：移植隐性 UI 依赖、协议/GUI 对不齐、双仓漂移、路径逃逸、脱敏滞后、锁/共存、编译后配置根。完整登记见 `docs/work-plan.md` §6。

## 关联

- 范围：`docs/matrix-core-v0-prd.md` · 设计：[[架构-Matrix-Core]] · 协议：[[协议-Matrix-Core-v1]] · 决策：[[决策记录-Matrix-Core]] · 迁移：[[边界与迁移]] · 待定：[[待澄清-Matrix-Core]]

## 修订记录

- 2026-10-28 初版：C0–C4（29d）。
- 2026-10-28 评审修订：拆 C0/C0b；补 shims/持久化/锁/打包/迁移/确定性任务；工期改为 47d；基线 1052/0。
