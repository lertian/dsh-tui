# tui/ — terminal UI surfaces

English | [中文](README.zh.md)

Interactive terminal surfaces: Ink-driven (React-for-CLI) plugins that drive `ctx.agents` and render from the durable session log (`session/event`), composed into profiles through bundle patch layers.

| Package | Role | ctx key |
|---|---|---|
| [`app/`](app/README.md) | The interactive terminal UI plugin: streaming transcript, tool cards, approval overlay, slash commands, session resume | mounts `tui-runner`, `tui-startup` |

Boot it with `dsh --profile tui` (see [`packages/bundle/tui-app`](../bundle/tui-app/README.md) for the bundle layer).
