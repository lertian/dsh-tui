# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

dsh 的交互式终端 UI：基于 [Ink](https://github.com/vadimdemedes/ink) 构建的 Agent 表层，运行在核心 Agent/Session 服务之上，交互风格对标 Claude Code。它通过 `ctx.agents` 创建或恢复一个 Agent，把持久化会话日志折叠成流式会话记录，并驻留以支持多轮对话。

通过 [`@deepseek-ai/dsh-tui-app-bundle`](../../bundle/tui-app/README.md) profile 层启动：

```sh
dsh                                 # fresh session (tui is the default profile)
dsh -c                              # continue the newest session in this directory
dsh --resume <id>                   # reopen a persisted session (full id or unique short prefix)
dsh --profile tui                   # the explicit form
```

## 功能

- **欢迎横幅** —— 新会话启动时显示 Claude Code 风格的横幅：终端块字符绘制的 DeepSeek 鲸鱼、几条上手提示，以及模型 · 会话 · 目录信息行。第一条会话行落定后横幅自动退场。
- **流式会话记录** —— `assistant/chunk` 增量实时渲染，`assistant/message` 完成每个 step 的定稿。恢复会话时走同一个投影（`src/projection.ts`）重放持久化日志，历史始终完整（"模型可见即已落盘"）。
- **通用工具卡片** —— 每对 `tool/call`/`tool/result` 渲染为截断预览卡片（名称、参数摘要、结果预览）。任何第三方插件贡献的工具都无需 TUI 侧适配即可显示。
- **审批浮层** —— 插件以终端提示回答 `approval/request` waterfall：`y` 允许一次，`n` 拒绝，`a` 本会话内总是允许该工具（UI 侧记忆）。决定以 `approval/asked`/`approval/decided` 审计对写入会话日志。
- **斜杠命令** —— 注册进共享的 `ctx.commands` 运行时：`/new`、`/resume`（打开可 fuzzy 过滤的会话选择器，或按 id／唯一短前缀恢复）、`/model`（打开模型选择器，或按 `<provider> <model>` 切换当前会话的模型，并保存为新会话的默认）、`/tools`、`/settings`、`/help`、`/clear`（清空视图，会话日志不动）、`/quit`。插件贡献的命令自动出现在 `/help` 与 `/` 菜单。
- **技能** —— 来自 `dsh-skill` 注册表的用户可调用技能出现在同一个 `/` 菜单（`user-only ·` 标记标识 `disable-model-invocation` 技能）。提交某个用户可调用技能的 `/name` 会将其作为普通用户消息转发给模型，由 `dsh-tool-skill` 注入渲染后的技能正文；命令名始终优先于同名技能。技能名也会列在 `/help` 中。
- **压缩状态** —— `compaction/start`/`summary`/`end` 生命周期渲染实时 `compacting…` spinner（含手动 `/compact`：它在 agent 空闲时运行，因此 spinner 不依赖开着的 turn）、落盘后一条 `compacted N history items (~M tokens)` 通知，失败尝试则渲染错误通知。`compaction/prune` 保持静默，与 Web 客户端对齐。
- **输入历史** —— ↑/↓ 以 readline 风格回看已提交的行：连续重复行折叠，↓ 回到正在编辑的草稿。历史落盘到 `$DSH_HOME/profiles/tui/history`（最近 200 条），跨重启保留。
- **思考模式** —— Shift+Tab 在当前模型公布的档位间循环切换推理强度（DeepSeek 为 off/high/max）。所选档位显示在状态栏。模型选择按会话独立：resume 时从该会话的日志恢复它自己上次使用的模型与档位，切换同时也会更新供新会话使用的 settings 默认。
- **状态栏** —— 模型、思考档位、会话 id、累计 token 用量、运行状态（running / cancelling / compacting / idle）。
- **按键** —— Enter 提交；Shift+Enter 或 Ctrl+J 换行；↑/↓ 回看历史；Shift+Tab 循环思考档位；输入 `/` 打开 fuzzy 斜杠命令与技能菜单（↑↓ 选择，Tab 补全，Enter 执行，Esc 关闭）；菜单与选择器关闭后，Esc 中断当前 turn；Ctrl+O 展开/收起最后一轮的工具结果与思考；Ctrl+C 清空输入或中断当前 turn——再次按下退出（先冲刷会话）。中断 turn 会立即停止 working 指示并清空输入框，显示 `cancelling…` 直到 agent 的合作式中止落定。审批问题打开期间输入框只读——`y`/`n`/`a`/`Esc` 归浮层所有。

## 语义色板

第三方插件贡献的命令/工具沿用同一套状态色约定：**选中 = 反色**、**进行中 = 黄**、**成功 = 绿**、**失败 = 红**、**信息 = 灰**、**审批/危险 = 黄**。工具卡、命令行、通知与选择列表都遵循它。

## 架构

- `src/startup.ts`（`tui-startup`）—— 应用的命令行提供方：解析 `--resume` 与 `-c/--continue` 并发布 `ctx.tuiStartup`。
- `src/index.ts`（`tui-runner`）—— 挂载表层：loader 就绪后创建/恢复 Agent，安装可变模型选择，渲染 Ink 帧，并在 dispose 时一并回卷。
- `src/controller.ts` —— 持有活跃 Agent、事件订阅、斜杠命令处理器、审批应答器与会话切换；向帧暴露 `subscribe`/`getSnapshot` store。
- `src/projection.ts` —— 从 `SessionEvent` 到视图行的纯函数折叠，实时事件与恢复重放共用。
- `src/ui/App.tsx` —— Ink 帧：新会话的欢迎横幅、退入终端滚动区的已定稿行（`Static`）、承载流式文本与运行中工具的活跃区，另有 todo 条、审批浮层、输入框与状态栏。

## 设置、凭据与插件

TUI 复用原生机制，没有 TUI 专属部分：

- 模型与密钥按请求从 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:`/`llm-pi-ai:` 段解析，凭据来自凭据库（`$DSH_HOME/.credentials.yaml`，可被环境变量覆盖，如 `DEEPSEEK_API_KEY`）。`/settings` 打印具体路径。
- 行为级定制走 profile 的 `cordis.patch.yml` patch 层（热重载）：组合中的任何插件行都可以在那里改配或替换。
- 第三方插件用 `dsh plugin --profile tui add <package>` 安装，并在 profile patch 里加 `insert` 行挂载。它们注册到 `ctx.tools`/`ctx.commands` 的能力会自动出现在 TUI。

## 模型体验

本包是呈现层：除把用户自己的输入作为普通消息提交外，从不改变模型可见的会话记录、工具 schema 或提示词装配。`/name` 技能手势作为普通用户消息转发，由 `dsh-tool-skill` 完成注入；TUI 自身不新增任何提示词机制。模型所交互的核心服务与其他 profile 完全一致；面向人类的能力（审批、斜杠命令、技能）经由文档化的交互 seam 解决。

## 已知限制与延后工作

- 输入框仅支持末尾编辑：尚无光标移动、选区或 kill-ring（已支持 ↑/↓ 历史回看）。
- 助手文本渲染一个终端化的 Markdown 子集：``` 代码块（正则高亮：注释/字符串/关键字/数字）、标题、列表、引用、粗体/斜体/行内代码；不支持表格与链接。
- 命令与技能共用同一个扁平 `/` 菜单（技能靠描述文本区分，暂无分组标题）。
- 审批的 `always` 选择是 UI 侧的按工具记忆，不跨重启持久化。
- Esc 不会中断手动 `/compact`（该命令的信号与 UI 同生命周期）；压缩 spinner 会一直显示到事务结算。
- 取消是合作式的：UI 会立即停止显示 turn 正在运行并清空输入框，但底层 agent 可能还要片刻才能落定（工具的 SIGTERM 宽限、CPU fold），直到 `turn/end` 落地。
- 需要交互式 TTY；非 TTY 调用会快速失败并给出诊断（此时请用 `--profile headless`）。
