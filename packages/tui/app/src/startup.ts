/**
 * The TUI app's command-line provider: it parses `--resume`, `--continue`,
 * and `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the startup values can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The persisted session id to resume; an empty string means a fresh session. */
  resume: string
  /** Continue the most recent session created in the launch directory (`-c`). */
  continue: boolean
}

/**
 * This app's command: the resume options, the description, and the help text.
 * Excess positionals are rejected so removed launcher shapes like `dsh tui`
 * fail here instead of being silently swallowed.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh')
    .description('Open the interactive terminal UI: a persistent multi-turn agent session with streaming, approvals, and slash commands.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session>', 'resume a persisted session by id')
    .option('-c, --continue', 'continue the most recent session in this directory')
    .allowExcessArguments(false)
    .addHelpText('after', `
Examples:
  dsh                              start a fresh interactive session
  dsh -c                           continue the most recent session here
  dsh --resume <id>                reopen a previous session and continue

Inside the UI: Enter submits, Shift+Enter or Ctrl+J inserts a newline, Esc
cancels the running turn, Ctrl+C quits. Type / for the slash-command menu.
`)
}

/**
 * Parse and provide the startup values as an ordinary Cordis service. The
 * command's action publishes them; on `--help` nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((options: { resume?: string; continue?: boolean }) => {
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: options.resume ?? '',
      continue: options.continue === true,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
