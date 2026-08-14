# Agent Note: dsh TUI 渲染压缩生命周期（spinner、落盘通知、错误）

Status: implemented

[English](2026-08-14-tui-compaction-status-rendering.md) | 中文

## Problem

TUI 的投影（`packages/tui/app/src/projection.ts`）跳过所有 `compaction/*` 会话事件，其 spinner 仅由 `turn/start`/`turn/end`（`Projection.busy`）驱动。自动压缩发生在开着 turn 的内部，因此只是碰巧继承了通用的 `working…` spinner；手动 `/compact` 在 agent 空闲时运行（有开着的 turn 会以 `busy` 拒绝），于是整段摘要调用——常常数十秒——完全没有任何加载指示：没有 spinner，状态栏显示 `idle`，`/compact` 命令行是裸的一行、没有运行图标。Web 客户端早已渲染完整生命周期：`ui-trajectory` 把 `compaction/start→summary→end` 折叠成一个 request，其状态在 `compaction/end` 前保持 `running`；`ui-conversation` 渲染带影子计数的落盘标记（"compacted N items / ~M tokens"）以及 `/compact` 命令的运行卡片。这个 TUI 缺口是用户可见行为，不是缺失的内部 seam。

## Decision

TUI 现在把持久化的压缩生命周期消费为视图状态，在线性记录上镜像 Web 客户端的语义：

- `Projection.compaction: CompactionState | undefined` 记录打开的事务（`id`、`running`）以及来自 `compaction/summary` 的影子计数（`shadowedItems`/`shadowedTokens`）。`compaction/start` 打开它，`compaction/end` 关闭它。`compaction/prune` 保持静默——Web 客户端同样不渲染 prune。
- spinner 条件变为 `busy || compacting`（`App.tsx`），因此空闲 agent 上的手动压缩显示 `⠋ compacting…`；turn 内的自动压缩把同一行标注为 `compacting…` 而不是 `working…`。状态栏在 `running — esc interrupts` 与 `idle` 之间新增 `compacting…` 状态。
- `compaction/end` 结算一条通知行：成功渲染 `compacted N history items (~M tokens)`（与 `dsh-command-compact` 的结算文案同族）；`error` 渲染 `compaction failed: <error>`。没有落盘摘要的成功 end 保持静默。行在创建时即定稿，与其他通知一样退入滚动区。
- 命令行（包括 `/compact` 行）获得与工具行一致的状态图标——`⏵` 运行中、`✓` 成功、`✗` 错误——取代原来的裸品红行。
- 对 `@deepseek-ai/dsh-compaction` 的依赖仅限类型（`import type {} from '@deepseek-ai/dsh-compaction/types'`，把事件词汇表合并进 `SessionEventMap`）：投影只读取事件载荷字段，运行时不导入任何压缩代码。

## Alternatives considered

**只用 `busy` 驱动 spinner（复用 turn spinner）。** 否决：手动压缩要求 agent 空闲，于是 `busy` 在最慢、最显眼的压缩路径上恰好为 false；事件派生的事务状态也正是 Web 客户端所依据的键。

**把检查点摘要正文渲染为可展开标记（对齐 Web 的 `CompactionItem`）。** 否决：检查点内容写给模型、动辄数百行；终端记录保留一行落盘通知，持久化日志仍是全文的唯一权威来源。

**特判 `/compact` 命令名来给运行中副标题。** 否决：事务状态统一覆盖手动与自动压缩，按名称特判会在第三方以其他命令名触发压缩时渲染错误。

## Consequences

- Esc 不会中断手动 `/compact`：该命令运行在控制器 UI 生命周期信号上，agent 空闲时 `cancelTurn` 是空操作。spinner 会显示进度直到事务结算；README 将这一点记录为限制。
- 呈现层改动纯属视图：模型可见记录、工具 schema、提示词装配均无变化，新行派生自投影此前跳过的 log-only 事件。重放（`replayEvents`）重建相同状态，因此恢复的会话会渲染它未实时经历过的压缩通知。
- Web 客户端与 TUI 现在在生命周期语义上（进行中状态、落盘计数、错误呈现）保持一致，尽管渲染形态不同；两个表层都不渲染 `compaction/prune`。
