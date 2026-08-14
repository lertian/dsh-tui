# Agent Note：TUI 即时取消 UX（对标 gemini-cli）

Status: implemented

[English](2026-08-14-tui-immediate-cancel-ux.md) | 中文

## Problem

取消正在运行的 turn（Esc，或 busy 时的第一次 Ctrl+C）之前只发出合作式 `agent.cancel({ kind: 'user' })` 中止请求。投影里的 `busy` 标志派生自会话日志，只有 loop 的 `turn/end` 事件折叠进来才会清除，因此在整个收敛窗口期间状态栏一直显示 `running`、活跃区一直转 `working…`——当某个工具无视 SIGTERM 或 CPU fold 进行到一半时，这段时间可能长达数秒。输入框里提前输入的内容也原样保留。gemini-cli 的 `cancelOngoingRequest` 恰恰相反：它先中止，随即把流状态翻到 Idle 并立即清空输入缓冲，让 agent 在后台收敛。dsh TUI 刻意对标 gemini-cli/Claude Code，因此 UI 迟迟不落定是朝该方向的一处割裂。

## Decision

`TuiController.cancelTurn()` 现在立即把 UI 从运行状态翻下来，同时合作式中止保持不变：

- 控制器在 `TuiSnapshot` 上武装一个 UI 侧 `cancelPending` 标志，当 `turn/end` 或下一个 `turn/start` 落地时清除（会话切换时也清除）。帧在状态栏和活跃区显示 `cancelling…` 取代 `running`/`working…`，并清空实时流状态。
- 一条 `cancelling…` `notice` 行立即落地——与 `previous run interrupted; resumed from the durable log` 相同的 `pushNotice` 投影行机制——按键生效的瞬间即被确认。持久化的 `turn aborted` 通知仍会在 `turn/end`（aborted）收敛时落地；两行连读即「cancelling…，然后 turn aborted」。
- 帧在两个 busy 取消路径（busy 时的 Esc、busy 时的第一次 Ctrl+C）通过既有 `promptState.current.requestClear()` 清空输入框，对应 gemini 的 `clearBuffer`。Ctrl+C 阶梯里「空闲带文本时清空输入」的分支不变；空闲时的 Esc 仍是 no-op。
- agent 空闲时 `cancelTurn()` 仍是纯 no-op：不设标志、不落通知、展示不变。

键位绑定一律不动：Esc 仍先关选择器/菜单，Ctrl+C 在 `CTRL_C_EXIT_WINDOW_MS` 内第二次按下仍退出，Esc/首次 Ctrl+C 拒绝审批也保持不变。

## Alternatives considered

**取消时强制杀死 agent 进程。** 不予采纳：gemini 也不强制杀死——`agent.abort()` 是合作式的（ACP 中止请求；工具观察 AbortSignal 并杀死自己的子进程）。强杀会搁浅持久化状态并和日志冲刷赛跑，违背「模型可见即已落盘」。

**把进行中的工具行改成 `cancelled` 状态。** 不予采纳：折叠保持诚实，行在真实 `tool/result` 落地前不被改动（真实结果或 loop 合成的 `tool call aborted before dispatch` 错误）。`cancelling…` 展示不需要新的行状态或 `isFinalized` 语义，也不会与取消之后才到达的结果相矛盾。

**把标志放进投影而非快照。** 不予采纳：`cancelPending` 是瞬态 UI 状态。重放会话日志绝不应复现它——它描述的是活的表层而非会话——因此它与其它仅帧可见的状态一起放在 `TuiSnapshot` 上。

## Consequences

- UI 立即停止把 turn 呈现为运行中：状态栏与活跃区显示 `cancelling…`，输入框清空，提前输入的内容在取消时被丢弃。
- 底层 agent 仍在后台收敛；取消是合作式的，不是强杀。当 `turn/end`（aborted）落地时，投影推入持久化 `turn aborted` 通知，`busy` 清除，标志落定。工具行在窗口期内保持 running 标记，随后以其真实结果落定。
- 会话日志与 agent-loop 语义不变：不新增任何会话事件，不增改任何模型可见内容。
- `cancelPending` 仅属于 UI，且在 `turn/start` 时也会清除，因此中止后的新一轮 turn 无需等旧中止的 `turn/end` 即可恢复正常的 `working…` 展示。
- 相关但不构成取代：Ctrl+C 双击退出阶梯（[2026-08-14-tui-ctrl-c-double-exit](2026-08-14-tui-ctrl-c-double-exit.md)）与最初的 Esc 取消决策（[2026-08-14-tui-input-history-thinking-mode-esc-cancel](2026-08-14-tui-input-history-thinking-mode-esc-cancel.md)）的事实保持不变；本笔记只改变 `cancelTurn()` 在中止收敛期间呈现的内容。

## Testing

`packages/tui/app/tests/controller.spec.ts` 覆盖标志生命周期：busy 取消会武装 `cancelPending`、清空流并落地 `cancelling…` 通知；`turn/end`（aborted）与下一个 `turn/start` 会落定它；空闲取消保持 no-op；重复取消不会重复通知。`packages/tui/app/tests/app.spec.tsx` 覆盖帧：busy 时的 Esc 与 busy 时的第一次 Ctrl+C 会清空提前输入并让 `working…` 让位于 `cancelling…`；`cancelPending` 快照渲染 `cancelling…` 取代 `running`；空闲 Esc 阶梯对输入保持 no-op。
