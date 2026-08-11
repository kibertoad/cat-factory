// The `.env` beside `vitest.acceptance.config.ts`, read the same way by everything that needs it.
//
// Two readers, which is why this is not inline in the config any more: the vitest config passes it to
// the workers as `test.env`, and `globalSetup` needs it in the MAIN process, where `test.env` has not
// been applied and never will be. A second copy of this rule would be a second answer to "does the
// shell win over the file", and that one has already cost a silently-ignored `.env`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * The file's variables, with anything already EXPORTED in the shell left alone.
 *
 * `test.env` writes straight into the worker's `process.env`, so a file value would otherwise clobber
 * the shell rather than default it, and a one-off `ACCEPTANCE_RUN_ID=latest pnpm … acceptance` would
 * silently resume nothing. The shell winning is also what keeps a committed default honest: the file
 * states the setup, the invocation states the exception. Absent means absent, so a blank line in the
 * file stays blank and `resolveConfig` reports it as unset rather than as a malformed value.
 */
export function envFile(dir: string): Record<string, string> {
  const path = join(dir, '.env')
  if (!existsSync(path)) return {}
  const parsed = parseEnv(readFileSync(path, 'utf8'))
  const entries = Object.entries(parsed).filter(
    ([key, value]) => typeof value === 'string' && process.env[key] === undefined,
  )
  return Object.fromEntries(entries) as Record<string, string>
}
