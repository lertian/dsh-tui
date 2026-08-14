# Agent Note：TUI 双击 Ctrl+C 退出

Status: implemented

[English](2026-08-14-tui-ctrl-c-double-exit.md) | 中文

## Problem

一次 Ctrl+C 会立刻退出整个 TUI 表层——包括用户正在输入提示词或处于 turn 中途的时候。一次误按（任何 shell 环境里 Ctrl+C 的肌肉记忆）就会丢弃正在编辑的输入并拆掉会话表层，即便会话日志在退出前已被冲刷。Claude Code 不会一次按键就退出：第一次 Ctrl+C 执行当前表层能提供的最软动作（中断正在进行的生成，否则清空输入），只有短时间窗口内的第二次按下才退出。TUI 刻意对标 Claude Code，因此单击退出是朝该方向的一处割裂。

## Decision

`src/ui/App.tsx` 中帧级 `useInput` 处理器把 Ctrl+C 变成逐级升级的阶梯，而不是立即退出：

- **第二次按下必胜。** 与前一次按下间隔在 `CTRL_C_EXIT_WINDOW_MS`（1000 ms）之内的按键一律退出，无论第一次做了什么。
- **第一次按下执行当前表层能提供的最软动作**，按序为：拒绝打开的审批（`decide('rejected')`，与 `n`/Esc 一致）；关闭打开的选择器；在 busy 或 compacting 时中断当前 turn（`controller.cancelTurn()`，与 Esc 一致）；清空输入框；最后，在空闲且输入为空时，用一条 UI 侧通知 `press Ctrl+C again to exit` 宣告窗口已武装。
- 输入框的输入归 `Prompt` 组件的本地状态所有，因此共享的 `PromptState` ref（既有 `requestClose` 模式）新增 `hasInput`/`requestClear`，由 Prompt 每帧注册。帧通过它读取与清空输入，无需把值提升进 controller。

`TuiController.quit()` 保留其 `exiting` 守卫；窗口宣告复用 `pushNotice` 不改动。Ink 自带的 Ctrl+C 处理保持禁用（`exitOnCtrlC: false`），因此 `apps/cli` 里的进程级 SIGINT 升级完全不受影响。

## Alternatives considered

**单击退出加确认浮层。** 不予采纳：在最常用的退出路径上增加一个模态步骤，并背离该表层已在镜像的 Claude Code 键位。

**Ctrl+C 只清空输入，绝不中断 turn。** 不予采纳：第一次按下中断正在运行的 turn，与 Claude Code 的中断语义及 dsh 自身的 Esc 一致，使 Ctrl+C 与 Esc 在 turn 期间保持自洽。

**更长或可配置的窗口。** 不予采纳：1000 ms 与双击的肌肉记忆吻合且无需新增配置面；可调参数会是无人消费的部署旋钮。

**不显示退出窗口通知。** 不予采纳：裸按一次时用户得不到任何反馈，「我按的那下到底有没有生效」的不确定感比一条瞬态 UI 侧通知行（不写入会话日志）更糟。

## Consequences

- 退出始终需要一秒内的两次 Ctrl+C；第一次按下绝不退出。
- 改变了一条既有钉住行为：选择器打开时 Ctrl+C 不再第一次就退出——它先关闭选择器（与 Esc 相同），第二次才退出。
- 该通知是一行 `notice` 投影行，在会话记录中可见但不属于会话日志（「模型可见即已落盘」不受影响）。
- Esc 语义不变；`--help` 文本、README 按键条目与本笔记记录新的阶梯。
- 同一改动还用 `useCallback` 稳定了 `loadArgumentItems` 回调身份：此前的内联箭头在每次帧重渲染时重建，Prompt 的参数候选 effect 把它视为依赖变化，于是每次重渲染都会重跑 effect 并写入新的状态对象——只要存在 `/resume <前缀>` 这类带参数命令，就会形成渲染死循环（"Maximum update depth exceeded"）。

## Testing

`packages/tui/app/tests/app.spec.tsx` 替换原来的单击退出用例并新增：首次 Ctrl+C 清空已输入内容且不退出；裸按一次的退出窗口通知；各表层下第二次按下退出；首次按下中断运行中的 turn；首次按下关闭选择器；首次按下拒绝打开的审批。还新增一个回归用例：在带参数命令激活时强制一次无关的帧重渲染，断言候选 effect 不重新加载——这正是回调身份渲染死循环的失败信号。
