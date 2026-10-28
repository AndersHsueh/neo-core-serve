# 日志（append-only）

> 规则：只追加，不改写。格式 `## [YYYY-MM-DD] type | 一句话`；type ∈ ingest / query / wiki / lint / deliverable / milestone / todo。

## [2026-10-28] milestone | 新建 neo-core-serve 仓库（Matrix-Core）：Gitee 私有仓 `andershsueh/neo-core-serve`，默认分支 main
## [2026-10-28] deliverable | Matrix-Core v0 设计文档：PRD v0.2、架构、协议 v1.1、工作计划 C0–C5、决策 D1–D12、provenance
## [2026-10-28] wiki | 建立 `.neo/wiki` 骨架：6 个主题页 + INDEX + 本日志
## [2026-10-28] todo | C0 待开工：工程骨架 + 从 neo `1da7c6f` 移植核心代码与 core-only 测试 + 守卫
## [2026-10-28] milestone | 设计评审完成（3 个评审 agent）：发现协议重命名/seq 双主/崩溃一致性/审批超时/路径逃逸/脱敏滞后/C0 编译不过等 10+ 问题
## [2026-10-28] deliverable | 评审修订：协议判别名冻结、seq/epoch 归 core、恢复对账、deadline 安全网、PathPolicy/脱敏、C0/C0b 拆分；PRD/架构/计划/决策/ops/GUI 接入同步为 v0.3
## [2026-10-28] query | 基线核实：neo `bun test` 实跑 1052 pass / 0 fail / 67 文件（tests/README 的 1051/1 为旧口径）；PTY 21/21 见 evidence
## [2026-10-28] wiki | 刷新全部主题页 + INDEX：补 v0.3 设计、D13–D15、47d 排期、共存规则、基线
## [2026-10-28] todo | C0 开工前：协议冻结评审 + reducer 抽取 + docs:check 最小版；随后 C0b 只搬纯模块
## [2026-10-28] milestone | 第二轮复核：修 ephemeral seq/锁互认/终态写序/live 恢复/ping 续期/system-prompt 传递依赖/reducer 确定性/A9 机械化；文档再次对齐
## [2026-10-28] deliverable | 最终设计 v0.3.1：协议 v1.1（seq=durable、auth 面保留、error at/blockId、ping liveness）、计划 C0 3d/C0b 4d/C1 15d/C2 16d/C3 9d、D1–D15
## [2026-10-28] milestone | C0 完成：协议 v1.1 冻结（6 文件 lock）、reducer 从 GUI 抽取并去非确定性、工程骨架 + docs:check + deps:scan、13 个契约测试、verify ALL GREEN；基线证据落 docs/evidence/
## [2026-10-28] todo | C0b 开工：按 deps-scan 清单只搬纯模块与测试；agent/tools/system-prompt 留到 C1（传递依赖 ui）
## [2026-10-28] milestone | v0.0.1 发布：单会话 Matrix-Core（WS/stdio + 协议 v1.1 + 48 tests + verify ALL GREEN），commit 2e7257e / tag v0.0.1
## [2026-10-28] deliverable | simplify（reuse/quality/efficiency 三路 reviewer）修复 M1–M5 与 minors；PathPolicy/WS 背压/Hub 等列 v0.0.2
## [2026-10-28] wiki | 新建 [[发布-v0.0.1]]，INDEX/计划页同步发布状态
## [2026-10-28] milestone | v0.0.2 发布：PathPolicy/统一/WS 合批+transcript.fetch/Hub+worker/图片附件；92 pass/0 fail/ALL GREEN；commit 0eca093 / tag v0.0.2
## [2026-10-28] deliverable | simplify 三 reviewer（reuse/quality/efficiency），HIGH 全修（悬空 symlink/overflow owner/并发 attach/batcher 记账/too_large id 等）；剩余列 v0.0.3
## [2026-10-28] wiki | 新建 [[发布-v0.0.2]]，INDEX/计划同步；GUI 联调指南 docs/gui-integration-v0.0.2.md
## [2026-10-28] deliverable | 今日会话汇总 [[汇总-Matrix-Core-v0.0.2]]：设计评审→C0→v0.0.1→v0.0.2；两次发布（48→92 tests）、团队分工、关键决策、simplify、风险与下一步
## [2026-10-29] wiki | v0.0.2 最终指针校正为 `47bd5ef`（tag 含发布后文档校正）；INDEX 新增「会话汇总」、更新来源链接与计划页进度
