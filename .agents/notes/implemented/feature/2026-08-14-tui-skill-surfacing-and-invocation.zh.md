# Agent Note：dsh TUI 在 `/` 菜单中暴露用户可调用技能并转发 `/name`

Status: implemented

[English](2026-08-14-tui-skill-surfacing-and-invocation.md) | 中文

## Problem

Web 客户端已经把技能目录与斜杠命令并列暴露（`ui-skill` + `ui-input-trigger` 展示技能；选中技能后把字面 `/name` 发给模型，由 `dsh-tool-skill` 的 pre-step 注入渲染后的正文；命令名优先于技能名）。TUI 两者都没做：

1. **技能没有被暴露。** `TuiController.commandItems()` 只读 `ctx.commands.list()`，因此 `/` fuzzy 菜单只列命令，与 Claude Code / Pi 的体验不一致。
2. **`/name` 从未到达模型。** `TuiController.submit()` 把所有以 `/` 开头的行交给 `commands.execute()`，返回 `undefined` 时只推送 `unknown command /name — try /help`，从不调用 `agent.followup`。因此 `dsh-tool-skill` 的用户调用手势（`/name` → 注入技能正文）在 TUI 中根本无法触发。

## Decision

- **技能目录进入 snapshot。** `TuiSnapshot` 增加 `skills`（一个 `SlashMenuItem[]` 切片）。`TuiController.refreshSkills()` 通过 `ctx.get('skills')` 读取可选的技能注册表，用 `skills.list({ cwd: agent.session.header.cwd, signal, scope: agent })` 查询，只保留 `isUserInvocable` 条目，并剔除与已注册命令同名的技能（命令优先，与 Web 客户端在客户端侧的裁决一致）。`disable-model-invocation` 技能仍列出，并带 `user-only ·` 描述前缀（Web 的 `menu.userOnly` 标记）。刷新在启动时 `registerCommands()` 之后执行（保证遮蔽正确）、每次 `swapAgent`（经 `/new` 与 `/resume`）后执行，并在 `skills/change` 时执行。注册表缺失或列举失败退化为空/最后可用目录，绝不让界面启动失败。
- **`/name` 转发。** 在 `submit()` 中，当 `commands.execute()` 返回 `undefined` 时，若前导 `/name` 命中已暴露技能，则把该行作为普通 `user/message`（`createUserMessage`）转发，把权威注入留给 `dsh-tool-skill` 既有的 pre-step。`isSkillGesture(line, name)` 复刻技能手势的词边界文法（名称紧跟斜杠、以行尾或空白结尾），因此数字开头的 kebab 名（`/3d-model`）也能匹配。未知名称仍保留 `unknown command` 警告。
- **菜单组合。** `Prompt` 在 `commands` 之外接收 `skills`，在一个合并的 `menuEntries` 列表上做 fuzzy 过滤（命令在前、技能在后）。完整输入技能名按原样提交；高亮技能补全为 `/name `（尾随空格，与 Web 选择器一致）。`/help` 也在 `skills:` 标题下列出技能。

## Alternatives considered

**把每个非命令 `/` 行都转发给模型，让 `dsh-tool-skill` 自行裁决。** 否决：这会抹掉 TUI 对真正未知命令的 `unknown command` 反馈（以及该界面已建立的 Claude/Pi 对齐），却只是修技能调用。带注册表检查的转发既保留警告又修好技能调用，且与 Web 客户端「裁决在客户端侧完成」的立场一致。

**内联 `invocation.userInvocable` 读取而非导入 `isUserInvocable`。** 否决：`isUserInvocable` 是 `api-proxy` 与 `dsh-tool-skill` 已在用的导出谓词；复用保持单一权威过滤器（其值导入也顺带合并了 `ctx.skills`/`skills/change`）。

**为技能做分组/带标题的 `/` 菜单。** 延后：现有 `SelectList` 是扁平窗口，描述标记足以区分技能；分组标题已记入包 README 的 Known Limitations。

## Consequences

- TUI 现在依赖 `@deepseek-ai/dsh-skill`（peer + dev）——这是 `dsh-base` 已挂载包上的类型与值边，因此任何可运行 TUI 的组合都能解析它。
- 转发的 `/name` 是普通 `user/message`（surface op `append`）；`dsh-tool-skill` 仍是注入的单一权威及其 `skill-invocation` source，因此没有新增会话事件类型。
- 目录是技能注册表的派生缓存，随 `skills/change` 刷新；`/new`/`/resume` 后有过期 agent 守卫丢弃在途结果。
- 命令名在菜单与 `submit()` 中都遮蔽同名技能，因此与命令同名的技能只能以命令形态触达。
