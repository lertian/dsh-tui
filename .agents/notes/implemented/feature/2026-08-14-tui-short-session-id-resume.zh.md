# Agent Note：TUI 短会话 id 恢复

Status: implemented

[English](2026-08-14-tui-short-session-id-resume.md) | 中文

## Problem

`dsh --resume <id>` 与 TUI 的 `/resume <id>` 斜杠命令要求完整的 `session-<uuid>` 字符串。而其余所有界面都把 id 缩写为 uuid 的前八个字符——会话选择器的标签与状态栏都渲染 `id.replace(/^session-/u, '').slice(0, 8)`——因此用户看到的 id（`0b59b044`）并不是恢复入口所接受的 id。Claude Code 的 `--resume`／`/resume` 能从短 id 解析会话，所以在 TUI 刻意对标该界面的前提下，要求完整字符串是一处明显的割裂。

JSONL 持久化后端必须保持精确匹配：它用 `encodeSegment(id)` 命名每个会话目录，协调器依赖「id 单独构成身份」来保证恢复的确定性，因此若在那里做前缀匹配，就会让「哪个会话」取决于磁盘上恰好还存有什么。解析因此应放在 UI/controller 层，基于 `sessionQuery` 的列表。

## Decision

`TuiController.resolveSessionId(input)` 在任何切换发生之前，把恢复参数解析为唯一的完整 `SessionId`。它先 trim 输入，剥掉一个前导 `session-` 得到 `bare`，再构造完整候选 `session-${bare}`。随后通过 `ctx.get('sessionQuery')?.listSessions(...)` 一次性读取 live 优先的语料：

- **先精确命中。** 若某条记录的 `header.id` 等于原始输入或完整候选，立即返回，因此完整 id 绝不走前缀路径。
- **唯一前缀。** 否则，`header.id` 以原始输入或完整候选开头的记录都算候选；恰有一个候选时返回它。这让裸的 `0b59b044` 与带前缀的 `session-0b59b044` 指向同一个 `session-0b59b044-…`。
- **零匹配**抛出 `no such session "<id>"`；**多于一个**抛出 `ambiguous session id "<id>" — candidates: <full ids>`。
- 匹配对字面小写 id 区分大小写。

当 `sessionQuery` 缺失（不寻常的组合）时，解析回退到完整候选，保留此前的精确 id 行为。该方法接入 `start()` 的恢复分支与 `resumeSession(id: string)`——后者现在接受原始字符串并在内部解析；`/resume` 处理器与 `applyPickerSelection` 直接传字符串，而不再预先用 `SessionId(...)` 包裹。持久化层未改动；新增的只有 controller 的「短→全」这一步。

## Alternatives considered

**在 `session-persistence-jsonl` 的 `findLog` 里做前缀匹配。** 不采纳：后端仅凭 id 推导存储路径，并把 id 当作精确身份；在那里做前缀扫描会让恢复相对于磁盘语料变得不确定，并破坏协调器的精确 id 契约。

**在 `dsh` 启动器（`apps/cli/src/args.ts`）里解析。** 不采纳：启动器原样转发内部参数，从不解析 `--resume`；它也无法覆盖 `/resume` 斜杠命令，而且只有 controller 拥有实时的 `sessionQuery` 语料。

**用模糊／包含匹配取代前缀匹配。** 不采纳：唯一前缀契约可由所显示的短 id 确定且可预测；模糊排序会引入交互式选择器已经处理的歧义。

## Consequences

- `dsh --resume 0b59b044` 与 `/resume 0b59b044` 现在解析到唯一的完整 id；`-c/--continue`、短 id 显示与选择器标签均保持不变。
- 没有唯一匹配的恢复参数会快速失败并给出零匹配／歧义消息，以启动失败（`--resume`）或错误通知（`/resume`）的形式呈现，绝不会静默恢复错会话。
- 匹配区分大小写；id 是小写 `session-<uuid>`，因此大写输入不匹配。

## Testing

`packages/tui/app/tests/controller.spec.ts` 为 `sessionQuery.listSessions` 桩增加可配置的 `sessionIds` 列表，覆盖精确完整 id 匹配（带与不带 `session-` 前缀）、裸与 `session-` 前缀的短 id 前缀解析、`--resume` 启动解析、零匹配错误与歧义错误。
