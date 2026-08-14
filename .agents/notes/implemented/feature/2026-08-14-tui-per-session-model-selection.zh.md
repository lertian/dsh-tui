# Agent Note：dsh TUI 从会话日志恢复 per-session 模型选择

Status: implemented

[English](2026-08-14-tui-per-session-model-selection.md) | 中文

## Problem

TUI 的 `TuiController` 对它所绑定过的所有会话只持有一个可变的 `selectionRef`。`swapAgent` 在每次 create/resume 时都用全局默认（`agentDefaultModel.currentSelection()`）为它播种，`setModel`/`cycleReasoningEffort` 又通过同一个 ref 以及 `agentDefaultModel.saveSelection` 回写。存在两个会话时这意味着：resume 一个会话会把它的模型重置为全局默认（而不是它实际用过的模型），而在一个会话里切模型会覆盖全局默认，进而改变所有仍打开或稍后 resume 的会话的模型。Web 客户端（`packages/host/apiproxy/src/api-proxy.ts` 的 `selectionFor`）则按 agent 维护独立选择，三级优先级——本进程内改过的选择，否则该会话自己落盘的 `request/header` config，否则全局默认——并在每次读取时重新解析。

## Decision

`swapAgent` 在 agent 绑定完成后用会话自身的持久化日志播种该会话的选择（`packages/tui/app/src/controller.ts`）：`handle.agent.session.requestHeader()?.config` 给出该会话最后一次请求的 provider/model/effort，写入 `selectionRef.current`。空白会话（尚无 `request/header`）保留全局默认 ref，因此新建的 `/new` 会话仍从 settings 起步。`setModel` 与 `cycleReasoningEffort` 保持不变：仍然写 `selectionRef.current` 并 best-effort 调用 `saveSelection`，全局默认现在只影响之后新建的会话——已打开或已 resume 的会话保留自己播种的选择。

播种是对 ref 的就地修改而非替换对象，因为 `installModelSelection` 的两个 waterfall 监听器闭包捕获的是 setup 时传入的精确 ref 对象；替换会让监听器失联，静默丢弃该会话之后所有的 `/model` 与 Shift+Tab 切换。

## Alternatives considered

**每次读取都重读日志（Web 端 `selectionFor` 的精确形态）。** TUI 不采纳：controller 在每次绑定时重新播种、读取都走 `selectionRef`，Web 端按读取求值的 getter 机制在这里会重复维护状态而没有任何第二个消费者。

**播种时把 `this.selectionRef` 换成新对象。** 不采纳：`installModelSelection(agentCtx, this.selectionRef)` 在 setup 时捕获对象身份，绑定后替换会让请求 waterfall 读到旧 ref 而 UI 写新 ref。

## Consequences

- 同一进程内绑定的两个会话各自保持独立选择：切换一个会话的模型不再改变另一个，resume 恢复该会话自己最后一次请求的模型与 effort。
- 会话里切换了模型但之后没有再发请求，该模型不会落进会话日志，因此之后 resume 读到的是最后一次请求的旧模型——与 Web 端一致，picked 只存在于进程内存。
- 全局默认现在只是 create-time 兜底；`saveSelection` 仍会更新它，供之后新建的会话使用。
- 关联：[思考模式 note](2026-08-14-tui-input-history-thinking-mode-esc-cancel.md)——Shift+Tab 循环 UI 与它的 `saveSelection` 均未改变；本 note 新增了日志恢复对 settings 默认的优先级。
