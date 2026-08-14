/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal surface. The bundle
 * patch rides over dsh-base; this runner creates or resumes one Agent through
 * the core registry, renders its session log with Ink, and stays resident
 * for multi-turn conversation until the user quits.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { render } from 'ink'
import type { Instance } from 'ink'
import { createElement } from 'react'
// Empty type import carries the loader Context merge for the settlement await.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiController } from './controller.ts'
import { App } from './ui/App.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the surface can boot. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tuiStartup']

/** Plugin config: the startup values resolved from this app's provider service. */
export interface Config {
  /** The persisted session id (or unique short-id prefix) to resume; an empty string starts a fresh session. */
  resume: string
  /** Continue the most recent session created in the launch directory. */
  continue: boolean
}

export const Config: z<Config> = z.object({
  resume: z.string().default(''),
  continue: z.boolean().default(false),
})

/** The process-facing effects the runner binds; tests substitute captures. */
export const internals: {
  render: (controller: TuiController) => Instance
  isTTY: () => boolean
  stderr: { write(chunk: string): unknown }
} = {
  render: controller => render(createElement(App, { controller }), { exitOnCtrlC: false }),
  isTTY: () => process.stdout.isTTY && process.stdin.isTTY,
  stderr: process.stderr,
}

/**
 * Mount the interactive terminal surface.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  if (!internals.isTTY()) {
    internals.stderr.write('dsh tui: an interactive terminal (TTY) is required\n')
    exit(1)
    return
  }
  const controller = new TuiController({ ctx, exit })
  const ink = internals.render(controller)
  ctx.effect(() => () => {
    ink.unmount()
    controller.dispose()
  })
  void controller.start({ resume: config.resume === '' ? null : config.resume, continue: config.continue })
}
