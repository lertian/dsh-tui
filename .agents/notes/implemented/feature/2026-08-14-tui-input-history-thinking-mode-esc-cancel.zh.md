# Agent Note：dsh TUI 增加输入历史、思考模式按键与真正的 Esc 中断

Status: implemented

[English](2026-08-14-tui-input-history-thinking-mode-esc-cancel.md) | 中文

## Problem

输入层有三个相对 Claude Code（以及旧 `pi` 产品）确立的交互式 Agent 预期的缺口：

1. **没有输入历史。** 输入框（`packages/tui/app/src/ui/App.tsx` 的 `Prompt`）每次提交后清空 `value`，不保留任何历史行，↑/↓ 无从回看；这两个键甚至在 `useInput` 里被提前 return 掉。
2. **没有思考模式调节。** controller 持有一个可变的 `ModelSelection`（provider/model 加上可选的 `reasoningEffort`），但 UI 从未暴露该 effort。`installModelSelection` 早已支持在缺省时回落到 provider 默认，Web 客户端的 `ModelSelect` 也按精确模型渲染完整 effort 列表——TUI 没有对应能力。
3. **Esc 没有中断 turn。** `startup.ts` 帮助文本承诺 "Esc cancels the running turn"，但 `App.tsx` 明确做了相反的事（"Esc closes the slash menu only; it never cancels a turn"），且 `TuiController` 根本没有 cancel 方法，尽管 `Agent.cancel({ kind: 'user' })` 就是文档化的 seam。

## Decision

- **输入历史（readline 风格）。** `Prompt` 维护 `historyRef`（已提交行，连续重复折叠）、`historyPosRef`（回看游标；`history.length` 表示当前行）与 `draftRef`（正在编辑的草稿，供 ↓ 返回）。↑/↓ 在历史中移动；所有提交路径统一走一个 `submit()` 辅助函数记录该行。历史按界面保存在内存中，不持久化。
- **Shift+Tab 调节思考模式。** `TuiController.cycleReasoningEffort()` 读取当前选择，调用 `llm.resolveModelInfo(provider, model)` 取精确模型公布的 `reasoning.efforts`，前进到下一档（循环）。它通过 `agentDefaultModel.saveSelection` 持久化，发一条 `thinking: <name>` 通知，snapshot 增加 `thinkingLabel`，使状态栏显示当前档位（`model · High`）。无 reasoning 元数据的模型得到一条 info 通知。DeepSeek 适配器公布 `off`/`high`/`max`，因此 Shift+Tab 把「思考开关」和「思考强度」合进一次循环，与 Web 客户端按模型的 effort 列表对齐。
- **Esc 中断 turn。** `TuiController.cancelTurn()` 委托给 `agent.cancel({ kind: 'user' })`，空闲时是 no-op。`App` 的帧级处理器现在按优先级解析 Esc：审批待决时 Esc 表示拒绝；开着选择器时选择器自行关闭；开着斜杠菜单时关闭菜单；否则中断 turn。被中断的 turn 经既有 `turn/end` 投影折叠出一条 `turn aborted` 通知，因此反馈无需新增渲染路径。

## Alternatives considered

**把输入历史持久化到 `$DSH_HOME`（对齐 shell history）。** 暂不采纳：目前没有可复用的 settings/history seam，按界面的回看已覆盖即时需求；持久化列为延后工作而非正确性缺口。

**做成二元思考开关（on/off）而非循环 effort 列表。** 不采纳：适配器公布三档且 Web 客户端全量列出；循环公布列表能力更强且共用一条代码路径，`off` 即「关闭思考」位置。

**把 Shift+Tab 做成 `App` 级全局绑定。** 不采纳：`Prompt` 本就是输入表面且已拥有方向键/Tab 处理；提示框局部绑定避免了在选择器/菜单关闭时帧与提示框之间的重复处理。

## Consequences

- `Agent.cancel` 同时清空 inbox，因此 Esc「停止」会丢弃排队的 follow-up——这正是帮助文本所描述的预期中断语义。
- `thinkingLabel` 由选择的 effort id 派生（首字母大写），而非适配器的展示名；解析出的 name 只出现在每次切换的通知里。若某适配器的 effort id 大写后易误导，状态栏标签与通知会略有差异。
- 选择经 `agentDefaultModel.saveSelection` 持久化，思考模式的变更跨重启生效，同一份 settings 文档也会被 Web 客户端尊重。
- Esc 在干净表面上不再无动作；行为变更更新了原先断言 no-op 的「bare Escape」与「second Escape」测试。
