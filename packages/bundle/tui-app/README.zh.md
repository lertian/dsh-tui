# @deepseek-ai/dsh-tui-app-bundle

[English](README.md) | 中文

dsh 交互式终端组合包：一个 profile patch 层，把 Ink 驱动的 TUI 运行器（[`@deepseek-ai/dsh-tui-app`](../../tui/app/README.md)）挂载在 `@deepseek-ai/dsh-base` 之上，不含 Host、HTTP 或浏览器插件。

用法：

```sh
dsh --profile tui                    # fresh interactive session
dsh --profile tui --resume <id>      # continue a persisted session
dsh plugin --profile tui add <pkg>   # install third-party plugins into this profile
```

## patch 内容

`cordis.patch.yml`：

- 覆盖 `system-prompt` 的 persona，面向交互式编码 Agent（感知工作目录）；
- 禁用共享的模块重载 `hmr` 行（TUI 是长生命周期表层；启动器仍会热重载用户 patch 层）；
- 插入 `tui-startup`（应用的 `--resume` 命令行提供方）与 `tui-runner`（表层本体，从 `ctx.tuiStartup` 读取配置）。

## 模型体验

本组合包只做 shipped 插件的组合；上面的 persona 文本是它声明的唯一模型可见值。工具、审批策略与循环均原样来自 `dsh-base`。

## 已知限制与延后工作

- 尚无 `--model` 启动参数；可在 UI 内用 `/model` 切换（持久化到 settings），或通过 profile patch 层固定默认值。
