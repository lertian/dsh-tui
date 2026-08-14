# tui/ — 终端 UI 表层

[English](README.md) | 中文

交互式终端表层：由 Ink（CLI 版 React）驱动的插件，通过 `ctx.agents` 驱动 Agent，并从持久化会话日志（`session/event`）渲染，经组合包 patch 层组合进 profile。

| 包 | 职责 | ctx key |
|---|---|---|
| [`app/`](app/README.md) | 交互式终端 UI 插件：流式会话记录、工具卡片、审批浮层、斜杠命令、会话恢复 | 挂载 `tui-runner`、`tui-startup` |

使用 `dsh --profile tui` 启动（组合包层见 [`packages/bundle/tui-app`](../bundle/tui-app/README.md)）。
