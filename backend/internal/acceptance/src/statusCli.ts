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
import { findMostRecentPass, passPaths, readLatestRunId, resolveStateDir } from './passFiles.ts'
import { formatPassStatus, summarisePass } from './status.ts'
import { emptyWorld, readWorld } from './world.ts'

const stateDir = resolveStateDir(stateDirFrom(process.env))
// Collapsed to `undefined` rather than left as an empty string: a blank argument or a blank
// `ACCEPTANCE_RUN_ID` is someone naming no pass, and reading it as a run id looks for `.json`.
const requested = process.argv[2]?.trim() || process.env.ACCEPTANCE_RUN_ID?.trim() || undefined
// Three questions, and only the middle one is the `latest` pointer. Named, it is that pass; asked
// for `latest`, it is the pass worth RESUMING (the most recent to record a fact); asked for nothing,
// it is the pass that ran LAST, which is usually the attempt the reader just watched fail and which
// by construction never claimed the pointer. Answered through the pointer, that reader was told
// "no acceptance pass found" while the journal they were asking about sat in the directory named.
const runId =
  requested === undefined
    ? findMostRecentPass(stateDir)
    : requested === 'latest'
      ? readLatestRunId(stateDir)
      : requested

if (!runId) {
  // An explicit refusal rather than an empty report: "no pass found" and "a pass that has done
  // nothing" look identical once rendered, and only the first one means the state directory is
  // not where the reader thinks it is. The two causes are separated for the same reason: a
  // directory full of refused attempts is not an empty one, and says something different.
  console.error(
    requested === 'latest'
      ? `No pass in ${stateDir} has recorded a fact, so 'latest' names none.\n` +
          `Name a pass (pnpm run status <runId>); one that got no further than its preflight is ` +
          `named in its own banner.`
      : `No acceptance pass found in ${stateDir}.\n` +
          `Name one (pnpm run status <runId>), or set ACCEPTANCE_STATE_DIR if the passes live elsewhere.`,
  )
  process.exit(1)
}

const { ledgerPath, journalPath } = passPaths(stateDir, runId)
const stored = readWorld(ledgerPath)
if (stored && stored.runId !== runId) {
  // The same disagreement `WorldStore` refuses to write through, refused on the read side rather
  // than rendered: reported under either id, the report would attribute one pass's work to the
  // other, and this command is where someone goes to find out which pass holds what.
  console.error(
    `${ledgerPath} says it belongs to pass '${stored.runId}', not '${runId}'. A pass is ` +
      `identified by its FILE NAME, so this one was copied or renamed. Rename it back to ` +
      `'${stored.runId}.json', or move it aside.`,
  )
  process.exit(1)
}

console.log(
  formatPassStatus(
    summarisePass({
      // A missing ledger is rendered as an empty pass rather than refused: a run interrupted
      // between minting its id and its first write is exactly the state worth reporting, and so is
      // the commoner one it reaches this command as, a fresh attempt a prerequisite refused.
      world: stored ?? emptyWorld(runId),
      events: readJournal(journalPath),
      ledgerPath,
      journalPath,
      now: Date.now(),
      // What `ACCEPTANCE_RUN_ID=latest` would resolve to, so a pass that created nothing points at
      // the pass that did rather than inviting a resume that starts over.
      latestRunId: readLatestRunId(stateDir),
    }),
    formatDuration,
  ),
)
