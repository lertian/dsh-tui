# @deepseek-ai/dsh-tui-app-bundle

English | [中文](README.zh.md)

The dsh interactive terminal bundle: a profile patch layer that mounts the Ink-driven TUI runner ([`@deepseek-ai/dsh-tui-app`](../../tui/app/README.md)) over `@deepseek-ai/dsh-base`, without the Host, HTTP, or browser plugins.

Usage:

```sh
dsh --profile tui                    # fresh interactive session
dsh --profile tui --resume <id>      # continue a persisted session
dsh plugin --profile tui add <pkg>   # install third-party plugins into this profile
```

## Patch contents

`cordis.patch.yml`:

- overrides the `system-prompt` persona for an interactive coding agent (working-directory aware),
- disables the shared module-reload `hmr` row (the TUI is a long-lived surface; the launcher still hot-reloads the user patch layers),
- inserts `tui-startup` (the app's `--resume` command-line provider) and `tui-runner` (the surface itself, configured from `ctx.tuiStartup`).

## Model Experience

The bundle only composes shipped plugins; the persona text above is the single model-visible value it states. Tools, approval policy, and the loop all come from `dsh-base` unchanged.

## Known Limitations and Deferred Work

- No `--model` startup flag yet; switch inside the UI with `/model` (persisted to settings), or pin the default through the profile patch layer.
