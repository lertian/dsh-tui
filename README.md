# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Terminal UI (this fork)

This fork adds an interactive **terminal UI** for DeepSeek Harness, built with [Ink](https://github.com/vadimdemedes/ink) in the spirit of Claude Code.

**Positioning.** The TUI is a thin surface over the stock harness: the agent loop, tools, approvals, session persistence, settings, and credentials all come from the unmodified `dsh-base` plugin stack. It shares `~/.dsh` with the Web UI and every other profile — one configuration, one credential store, one session history, usable from both surfaces. Nothing in the core packages is forked; the TUI lives in [`packages/tui/app`](packages/tui/app/README.md) plus a bundle patch and a registered `tui` profile.

**What you get.** Streaming transcripts, generic tool-call cards, an approval overlay (`y` / `n` / `a`), a fuzzy `/` command menu, interactive pickers for `/resume` and `/model`, argument completion (including `/permission`), and `dsh -c` to continue the newest session in the current directory. Third-party Cordis plugins installed with `dsh plugin --profile tui add <package>` contribute their tools and slash commands automatically.

### Use it

```sh
git clone https://github.com/lertian/dsh-tui.git
cd dsh-tui
pnpm install
pnpm run build        # Node 24, pnpm via corepack
node apps/cli/lib/bin.js
```

```sh
dsh                    # fresh session (tui is the default profile)
dsh -c                 # continue the newest session in this directory
dsh --resume <id>      # reopen a specific persisted session
dsh --profile headless "run the tests"   # one-shot, non-interactive
dsh web                # the Web UI, same ~/.dsh
```

Inside the UI: Enter submits; typing `/` opens the command menu (↑↓ select, Tab completes, Enter runs); `/resume` and `/model` open fuzzy pickers; Esc closes menus and pickers; Ctrl+C quits. See the [TUI package README](packages/tui/app/README.md) for the full feature list and architecture notes.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
