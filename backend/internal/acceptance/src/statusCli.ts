// `pnpm --filter @cat-factory/acceptance run status`: read a pass without disturbing it.
//
// Deliberately NOT a vitest spec and deliberately not part of the suite: it opens no connection
// to the deployment, creates nothing, and reads only the two files a pass writes. That is what
// makes it safe to run against a pass that is currently going, which is the only time anyone
// wants it.
//
// It also does not need the suite's configuration. `ACCEPTANCE_STATE_DIR` is the only variable it
// honours, so an operator can ask where a pass got to without holding an API key.

import { readJournal } from './journal.ts'
import { stateDirFrom } from './config.ts'
import { formatDuration } from './deadline.ts'
import { formatPassStatus, summarisePass } from './status.ts'
import { emptyWorld, readLatestRunId, readWorld, resolveStateDir } from './world.ts'
import { join } from 'node:path'

const stateDir = resolveStateDir(stateDirFrom(process.env))
const requested = process.argv[2]?.trim() || process.env.ACCEPTANCE_RUN_ID?.trim()
const runId = requested && requested !== 'latest' ? requested : readLatestRunId(stateDir)

if (!runId) {
  // An explicit refusal rather than an empty report: "no pass found" and "a pass that has done
  // nothing" look identical once rendered, and only the first one means the state directory is
  // not where the reader thinks it is.
  console.error(
    `No acceptance pass found in ${stateDir}.\n` +
      `Name one (pnpm run status <runId>), or set ACCEPTANCE_STATE_DIR if the passes live elsewhere.`,
  )
  process.exit(1)
}

const ledgerPath = join(stateDir, `${runId}.json`)
const journalPath = join(stateDir, `${runId}.journal.jsonl`)
console.log(
  formatPassStatus(
    summarisePass({
      // A missing ledger is rendered as an empty pass rather than refused: a run interrupted
      // between minting its id and its first write is exactly the state worth reporting.
      world: readWorld(ledgerPath) ?? emptyWorld(runId),
      events: readJournal(journalPath),
      ledgerPath,
      journalPath,
      now: Date.now(),
    }),
    formatDuration,
  ),
)
