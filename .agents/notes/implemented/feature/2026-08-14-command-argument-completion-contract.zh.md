# Agent Note：斜杠命令参数补全注册在命令自身

Status: implemented

[English](2026-08-14-command-argument-completion-contract.md) | 中文

## Problem

dsh TUI 此前用一段硬编码特判链解析斜杠命令的参数候选：`TuiController.argumentItems()` 里有 `resume`/`model`/`permission` 三个分支，`/permission` 分支还直接伸手读取 `ctx.permissionPresets`。第三方插件注册命令时完全无法提供参数补全——「如何补全这条命令的参数」这一知识放在界面里，而不是放在命令旁边。这正是 TUI 交接文档待办 #4（`/permission` 补全）背后的机制问题，Gemini 的 `SlashCommand.completion(context, partialArg)`——补全注册在命令本身——就是先例。

## Decision

- **`CommandDefinition.complete`。** `@deepseek-ai/dsh-commands` 增加可选的 `complete?: (invocation: CommandCompleteInvocation) => readonly CommandCompletionItem[] | Promise<...>`，调用上下文携带 `{ agent, partialArg, signal }`，条目为 `{ value, label, description? }`。该字段注册在命令（其生产方的注册）上，因此每条命令——包括第三方命令——都自持其候选。
- **注册表分发。** `CommandRuntime.complete(agent, name, partialArg, signal)` 解析经作用域遮蔽后的定义，在 UI 的中止信号下调用其提供方（`withAbort`），并在边界规范化结果（行数组；非空字符串 `value`；字符串 `label`；可选字符串 `description`；冻结且脱离引用）。未知名称与无提供方的命令返回 `undefined`。无处理器的线上描述符（`list()`）保持不含函数：`complete` 绝不进入其中。补全不落任何日志、无模型影响——纯 UI 平面。
- **界面消费契约，而非特判命令。** TUI 的 `argumentItems(command, partialArg)` 现在调用 `commands.complete(...)`，提供方失败时退化为 `[]`（并记 warn）；`/resume` 与 `/model` 在各自注册上携带自己的 `complete` 提供方，`dsh-permission-presets` 携带 `/permission` 的（预设名 + `(current)` 标记——标记逻辑从 TUI 移入该包）。TUI 输入框传入实时部分参数并随其变化重问，提供方可在服务端收窄；菜单仍对行做 fuzzy 排序。

## Alternatives considered

**先做过渡性的 controller 侧补全提供方 Map（推迟契约变更）。** 否决：注册表契约才是正确的地基，发布前立场偏向正确地基而非垫片；Map 会引入第二套机制，随后被契约取代。

**`complete(context)` 不带 `partialArg`（提供方永远返回全量列表）。** 否决：参考形态与服务端收窄都需要 partial，TUI 也已按击键传递；忽略它的提供方与全量列表设计行为一致。

**为 Web 客户端提供 `@Remote` 补全方法。** 延后：Web 客户端尚无参数补全 UI，仓库要求线上表面必须有当前消费方；宿主侧 `complete` 就是未来 Remote 可镜像的 seam。

## Consequences

- `@deepseek-ai/dsh-tui-app` 移除对 `@deepseek-ai/dsh-permission-presets` 的依赖（及 tsconfig 引用）：界面不再读取预设服务，命令自携补全。
- 提供方失败或畸形行以 `commands.complete` 抛错的形式暴露，由适配器收敛（TUI 记 warn 并显示空列表）；补全不记录任何生命周期事件。
- TUI 的参数菜单现在随 partial 变化按击键重问提供方，而非按命令名只加载一次；本地提供方返回廉价列表，既有的 cancelled 标志守卫丢弃过期响应。
- 补全保持在模型之外：无 token、缓存或会话记录影响；commands README 已在 Model Experience 下写明。
