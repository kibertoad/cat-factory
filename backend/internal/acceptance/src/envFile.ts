// The `.env` at this package's root, read the same way by everything that needs it.
//
// Three readers, none of which gets one for free: the pass (`runAcceptance.ts`), `reset` and
// `configure`. It was written when a vitest config loaded the file into `test.env` for the workers
// while `globalSetup` needed it in the main process, where `test.env` had not been applied and never
// would be; with the framework gone the rule is simply that nothing applies a `.env` for you. A
// second copy of it would be a second answer to "does the shell win over the file", and that one has
// already cost a silently-ignored `.env`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * The file's variables, with anything already EXPORTED in the shell left alone.
 *
 * The filter is what makes that true whichever way a caller merges the two records, so a one-off
 * `ACCEPTANCE_RUN_ID=latest pnpm … acceptance` cannot be clobbered by a stale line in the file and
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
