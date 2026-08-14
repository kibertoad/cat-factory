// `pnpm --filter @cat-factory/acceptance run status`: read a pass without disturbing it.
//
// Deliberately not part of the pass: it opens no connection
// to the deployment, creates nothing, and reads only the two files a pass writes. That is what
// makes it safe to run against a pass that is currently going, which is the only time anyone
// wants it.
//
// It also does not need the suite's configuration. `ACCEPTANCE_STATE_DIR` and `ACCEPTANCE_RUN_ID`
// are the only variables it honours, so an operator can ask where a pass got to without holding an
// API key.
//
// **It reads them the same way the pass does**, which is the whole of `envFile.ts`'s reason to be a
// shared module: the `.env` beside `package.json` first, with the shell winning over it. Read off
// `process.env` alone, this command disagreed with the pass about WHERE the passes are the moment
// `ACCEPTANCE_STATE_DIR` lived in the file (which is the form the README recommends, since it needs
// no shell dialect at all), and the disagreement is silent in the worst direction: the pass prints
// `watch: … run status <runId>` as the command to paste, and pasting it answered "No acceptance
// pass found" about a pass that was running right then.
//
// **What that file may NOT do is change which question this command answers.** `resolveStatusTarget`
// owns that rule and states it; the short of it is that the argument asks and the environment pins.
//
// A sibling of `resetCli.ts` in shape too: **the whole command is ONE function returning an exit
// code**, never `process.exit`. That call tears the process down without draining a stream that is a
// PIPE, which is what `pnpm --filter … run` is free to hand this process, and the refusals below are
// the command's entire output when they fire: a half-written line or none, under exit 1. Every line
// also goes to stdout, for the reason the pass's do: a report and a refusal are both the answer, and
// splitting them across two streams loses whichever half the reader is capturing.

import {
  findMostRecentPass,
  formatDuration,
  passPaths,
  readJournal,
  readLatestRunId,
} from '@cat-factory/acceptance-kit'
import { stateDirFrom } from './config.ts'
import { envFile } from './envFile.ts'
import { packageRoot } from './packageRoot.ts'
import { formatPassStatus, resolveStatusTarget, summarisePass } from './status.ts'
import { emptyWorld, readWorld } from './world.ts'

process.exitCode = run()

function run(): number {
  const env = { ...envFile(packageRoot), ...process.env }
  const stateDir = stateDirFrom(env)
  const latestRunId = readLatestRunId(stateDir)
  const target = resolveStatusTarget({
    // Collapsed to `undefined` rather than left as an empty string: a blank argument or a blank
    // `ACCEPTANCE_RUN_ID` is someone naming no pass, and reading it as a run id looks for `.json`.
    argument: process.argv[2]?.trim() || undefined,
    pinned: env.ACCEPTANCE_RUN_ID?.trim() || undefined,
    latestRunId,
    mostRecentRunId: findMostRecentPass(stateDir),
  })

  if (target.kind === 'none') {
    // An explicit refusal rather than an empty report: "no pass found" and "a pass that has done
    // nothing" look identical once rendered, and only the first one means the state directory is
    // not where the reader thinks it is. The two causes are separated for the same reason: a
    // directory full of refused attempts is not an empty one, and says something different.
    console.log(
      target.reason === 'latest-names-none'
        ? `No pass in ${stateDir} has recorded a fact, so 'latest' names none.\n` +
            `Name a pass (pnpm run status <runId>); one that got no further than its preflight is ` +
            `named in its own banner.`
        : `No acceptance pass found in ${stateDir}.\n` +
            `Name one (pnpm run status <runId>), or set ACCEPTANCE_STATE_DIR if the passes live elsewhere.`,
    )
    return 1
  }

  const runId = target.runId
  const { ledgerPath, journalPath } = passPaths(stateDir, runId)
  const stored = readWorld(ledgerPath)
  if (stored && stored.runId !== runId) {
    // The same disagreement `WorldStore` refuses to write through, refused on the read side rather
    // than rendered: reported under either id, the report would attribute one pass's work to the
    // other, and this command is where someone goes to find out which pass holds what.
    console.log(
      `${ledgerPath} says it belongs to pass '${stored.runId}', not '${runId}'. A pass is ` +
        `identified by its FILE NAME, so this one was copied or renamed. Rename it back to ` +
        `'${stored.runId}.json', or move it aside.`,
    )
    return 1
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
        latestRunId,
      }),
      formatDuration,
    ),
  )
  return 0
}
