# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

dsh 的交互式终端 UI：基于 [Ink](https://github.com/vadimdemedes/ink) 构建的 Agent 表层，运行在核心 Agent/Session 服务之上，交互风格对标 Claude Code。它通过 `ctx.agents` 创建或恢复一个 Agent，把持久化会话日志折叠成流式会话记录，并驻留以支持多轮对话。

通过 [`@deepseek-ai/dsh-tui-app-bundle`](../../bundle/tui-app/README.md) profile 层启动：

```sh
dsh                                 # fresh session (tui is the default profile)
dsh -c                              # continue the newest session in this directory
dsh --resume <id>                   # reopen a persisted session
dsh --profile tui                   # the explicit form
```

## 功能

- **流式会话记录** —— `assistant/chunk` 增量实时渲染，`assistant/message` 完成每个 step 的定稿。恢复会话时走同一个投影（`src/projection.ts`）重放持久化日志，历史始终完整（"模型可见即已落盘"）。
- **通用工具卡片** —— 每对 `tool/call`/`tool/result` 渲染为可折叠卡片（名称、参数摘要、结果预览）。任何第三方插件贡献的工具都无需 TUI 侧适配即可显示。
- **审批浮层** —— 插件以终端提示回答 `approval/request` waterfall：`y` 允许一次，`n` 拒绝，`a` 本会话内总是允许该工具（UI 侧记忆）。决定以 `approval/asked`/`approval/decided` 审计对写入会话日志。
- **斜杠命令** —— 注册进共享的 `ctx.commands` 运行时：`/new`、`/resume`（打开可 fuzzy 过滤的会话选择器，或按 id 恢复）、`/model`（打开模型选择器，或按 `<provider> <model>` 切换，经 settings 持久化）、`/tools`、`/settings`、`/help`、`/quit`。插件贡献的命令自动出现在 `/help` 与 `/` 菜单。
- **压缩状态** —— `compaction/start`/`summary`/`end` 生命周期渲染实时 `compacting…` spinner（含手动 `/compact`：它在 agent 空闲时运行，因此 spinner 不依赖开着的 turn）、落盘后一条 `compacted N history items (~M tokens)` 通知，失败尝试则渲染错误通知。`compaction/prune` 保持静默，与 Web 客户端对齐。
- **状态栏** —— 模型、会话 id、累计 token 用量、运行状态（running / compacting / idle）。
- **按键** —— Enter 提交；Shift+Enter 或 Ctrl+J 换行；输入 `/` 打开 fuzzy 斜杠命令菜单（↑↓ 选择，Tab 补全，Enter 执行，Esc 关闭）；Esc 只关闭 UI 浮层（菜单/选择器），不会中断 turn；Ctrl+C 退出（先冲刷会话）。审批问题打开期间输入框仍可编辑——只有 `y`/`n`/`a`/`Esc` 归浮层所有。

## 架构

- `src/startup.ts`（`tui-startup`）—— 应用的命令行提供方：解析 `--resume` 与 `-c/--continue` 并发布 `ctx.tuiStartup`。
- `src/index.ts`（`tui-runner`）—— 挂载表层：loader 就绪后创建/恢复 Agent，安装可变模型选择，渲染 Ink 帧，并在 dispose 时一并回卷。
- `src/controller.ts` —— 持有活跃 Agent、事件订阅、斜杠命令处理器、审批应答器与会话切换；向帧暴露 `subscribe`/`getSnapshot` store。
- `src/projection.ts` —— 从 `SessionEvent` 到视图行的纯函数折叠，实时事件与恢复重放共用。
- `src/ui/App.tsx` —— Ink 帧：已定稿行退入终端滚动区（`Static`），活跃区承载流式文本与运行中的工具，另有 todo 条、审批浮层、输入框与状态栏。

## 设置、凭据与插件

TUI 复用原生机制，没有 TUI 专属部分：

- 模型与密钥按请求从 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:`/`llm-pi-ai:` 段解析，凭据来自凭据库（`$DSH_HOME/.credentials.yaml`，可被环境变量覆盖，如 `DEEPSEEK_API_KEY`）。`/settings` 打印具体路径。
- 行为级定制走 profile 的 `cordis.patch.yml` patch 层（热重载）：组合中的任何插件行都可以在那里改配或替换。
- 第三方插件用 `dsh plugin --profile tui add <package>` 安装，并在 profile patch 里加 `insert` 行挂载。它们注册到 `ctx.tools`/`ctx.commands` 的能力会自动出现在 TUI。

## 模型体验

本包是呈现层：从不改变模型可见的会话记录、工具 schema 或提示词装配。模型所交互的核心服务与其他 profile 完全一致；面向人类的能力（审批、斜杠命令）经由文档化的交互 seam 解决。

## 已知限制与延后工作

- 输入框仅支持末尾编辑：尚无光标移动、选区或 kill-ring。
- 助手文本以纯文本渲染（无 Markdown 语法高亮）。
- 审批的 `always` 选择是 UI 侧的按工具记忆，不跨重启持久化。
- Esc 不会中断手动 `/compact`（该命令的信号与 UI 同生命周期）；压缩 spinner 会一直显示到事务结算。
- 需要交互式 TTY；非 TTY 调用会快速失败并给出诊断（此时请用 `--profile headless`）。
