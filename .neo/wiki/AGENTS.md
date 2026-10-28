# AGENTS.md（wiki schema）

> 本文件是 `.neo/wiki` 知识库的 schema。wiki 由 LLM 维护、随仓库提交；`raw/` 只读。
> 最后更新：2026-10-28

## 知识库概述

这是 **neo-core-serve（Matrix-Core）** 的开发知识库：沉淀架构决策、协议契约、迁移事实、踩坑与排期。目标不是审计，而是**下一次会话能快速召回「为什么这样设计、现在做到哪」**。

核心约束：

- **可溯源**：结论必须能落到 `docs/`、git commit/tag 或代码路径。
- **以文档与 git 为准**：版本、协议、行为以仓库文档和 tag 为准，不凭记忆。
- **不臆造**：查不到就写进 `待澄清-*.md`。
- **语言**：中文；代码/命令/路径保留原文。
- **raw 只读**：`raw/` 里已有文件禁止修改。

## 目录

| 目录 | 归属 | 规则 |
|---|---|---|
| `raw/` | 用户 | 原始素材，LLM 只读 |
| `wiki/` | LLM | 主题页 + `INDEX.md` + `log.md`；随仓提交 |
| `outputs/` | LLM | 对外产出；**不提交**（`.gitignore`） |

## 规则

- **每主题一页**：文件名用无空格中文短语。
- **每页必须有**：`## 摘要`（3–5 句）+ `> 最后更新:YYYY-MM-DD`。
- **互链**：用 `[[主题名]]`；每页建议 ≥3 条有效出链；小库（<8 页）不强制。
- **索引**：新增/改名/删除页面后同步 `wiki/INDEX.md`。
- **时间戳**：任何内容变更都更新日期戳。
- **主题页可重写**：以「当前最优综述」为准；被推翻的说法压缩进 `## 修订记录`。
- **log 只追加**：`wiki/log.md` 条目格式 `## [YYYY-MM-DD] type | 一句话`，type ∈ ingest/query/wiki/lint/deliverable/milestone/todo。
- **待澄清**：不确定的事项写到 `待澄清-<主题>.md`，不要写进事实页。
- **文档即契约**：本 wiki 的结论与 `docs/` 冲突时，以 `docs/` 为准，并立即修正 wiki。

## 当前状态

- 阶段：设计完成，C0（代码移植）未开始。
- 事实源：`docs/matrix-core-v0-prd.md`、`docs/architecture.md`、`docs/protocol-v1.md`、`docs/work-plan.md`、`docs/decisions.md`。
- 待决策：CLI 切换后的仓形态、远程项目边界、transcript 保留期、多客户端权限。
