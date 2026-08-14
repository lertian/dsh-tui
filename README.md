# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Terminal UI (this fork)

This fork adds an interactive **terminal UI** for DeepSeek Harness, built with [Ink](https://github.com/vadimdemedes/ink) in the spirit of Claude Code. It is the default surface: a bare `dsh` boots it.

### Positioning

The TUI is a thin surface over the stock harness: the agent loop, tools, approvals, session persistence, settings, and credentials all come from the unmodified `dsh-base` plugin stack. It shares `~/.dsh` with the Web UI and every other profile — one configuration, one credential store, one session history, usable from both surfaces. Nothing in the core packages is forked; the TUI lives in [`packages/tui/app`](packages/tui/app/README.md) plus a bundle patch and a registered `tui` profile.

### Features

- **Streaming transcript** — `assistant/chunk` deltas render live; a resume replays the durable log so history is always complete.
- **Generic tool cards** — every `tool/call` / `tool/result` pair renders as a card (name, argument summary, result preview); tools from any third-party plugin appear with zero TUI-side adaptation.
- **Approval overlay** — answer tool-approval questions with `y` (allow once) / `n` (reject) / `a` (always allow for this session). The prompt stays editable while the question is open.
- **Slash-command menu** — typing `/` opens a fuzzy-matched menu of every registered command (built-in and plugin-contributed), with `↑↓` selection, `Tab` completion, and `Enter` execution.
- **Interactive pickers** — `/resume` opens a fuzzy-filterable session picker; `/model` opens the model catalog picker; both support argument completion (e.g. `/permission ` lists the presets).
- **Quick continue** — `dsh -c` resumes the newest session in the current directory, skipping any session whose log is unreadable.

### Requirements

- **Node.js 24+** (the repository requires `^22.19.0 || >=24`; brew's keg-only `node@24` works: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).
- **pnpm** — resolved via corepack (`export COREPACK_ENABLE_DOWNLOAD_PROMPT=0` to skip the prompt).

### Quick start

```sh
git clone https://github.com/lertian/dsh-tui.git
cd dsh-tui
pnpm install
pnpm run build
node apps/cli/lib/bin.js
```

For daily use, an alias helps (point it at the built binary so it stays in sync with `pnpm run build`):

```sh
alias dsh='/opt/homebrew/opt/node@24/bin/node /path/to/dsh-tui/apps/cli/lib/bin.js'
```

### Commands

| Command | What it does |
|---|---|
| `dsh` | Start a fresh interactive session (tui is the default profile) |
| `dsh -c` | Continue the newest readable session created in this directory |
| `dsh --resume <id>` | Reopen a specific persisted session |
| `dsh --profile headless "task"` | One-shot, non-interactive task; prints the result and exits |
| `dsh web` | The Web UI — same `~/.dsh`, same sessions |
| `dsh plugin --profile tui add <pkg>` | Install a third-party Cordis plugin into the TUI profile |

### Keys inside the UI

| Key | Action |
|---|---|
| `Enter` | Submit the input line |
| `Shift+Enter` / `Ctrl+J` | Insert a newline |
| `/` | Open the fuzzy slash-command menu (↑↓ select, Tab complete, Enter run, Esc close) |
| `/resume`, `/model`, `/permission ` | Open interactive pickers / argument completion |
| `Esc` | Close menus and pickers (never cancels a turn) |
| `Ctrl+C` | Flush the session and quit |
| `y` / `n` / `a` | Answer the approval overlay |

### Configuration and plugins

- Everything lives under `~/.dsh` (override with `$DSH_HOME`): `settings.yaml` (model/provider, base URL), `.credentials.yaml` (API keys, e.g. `DEEPSEEK_API_KEY`), `sessions/` (history), `profiles/` (per-profile plugin layers).
- The Web UI and the TUI read the same files — switching surfaces never splits your configuration or history.
- Third-party plugins are ordinary Cordis plugins: `dsh plugin --profile tui add <package>` mounts their tools and slash commands automatically.

### Troubleshooting

- **`dsh tui: an interactive terminal (TTY) is required`** — the TUI needs a real terminal; run it from a terminal, not a pipe or CI job.
- **No API key / `MISSING_CREDENTIAL`** — put the key in `~/.dsh/.credentials.yaml` or the environment (`DEEPSEEK_API_KEY=... dsh`).
- **`dsh -c` starts a fresh session** — no readable session exists for this directory (or the newest few logs are corrupt; the TUI skips them automatically).
- **Model shows `deepseek-official/deepseek-official/...`** — was caused by an old completer bug; update to the latest build.

See the [TUI package README](packages/tui/app/README.md) for the full feature list and architecture notes.

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
