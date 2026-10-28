# neo-core-serve

neo 的核心运行时服务 —— 代号 **Matrix-Core**。

- 定位：从 neo CLI 中分离出来的**独立可运行**核心进程（agent 循环 / 工具 / 会话 / 记忆 / 信箱 / 命令），不依赖终端。
- 客户端：CLI（`neo`）、桌面工作台（`neo-agent-app`）都通过同一套 WS 协议连接。
- 边界：本仓只做 core + serve，不含 TUI、不含 GUI、不含云端多租户。

## 状态

仓库刚建，代码未开始。当前流程：先把「核心与 CLI 分离」的边界和协议定下来，再动代码。

## 计划中的形态

```
neo-core-serve
  src/core/        # 从 neo CLI 抽出的运行时（无 ui/tui 依赖）
  src/protocol/    # 客户端 ⇄ core 的 WS 协议，唯一事实源
  src/serve/       # WS/HTTP 外壳 + 会话生命周期
  tests/           # 协议契约 + core 边界守卫
```

- v0：单会话核心服务（一个进程 = 一个会话，本质是目标架构里的 worker）。
- v0.5：本地多会话 Hub（会话注册表 + 每会话一个 worker 子进程）。

## 相关仓库

| 仓库 | 说明 |
| --- | --- |
| `neo` | 现行 CLI（v0.4.3），runtime 仍内嵌其中，是本次抽取的来源 |
| `neo-agent-app` | 桌面工作台（Preact 前端 + dummy-serv + WS v1 协议原型） |
