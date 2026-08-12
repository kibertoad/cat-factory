// `pnpm --filter @cat-factory/acceptance run acceptance`: the pass itself.
//
// A sibling of `statusCli.ts`, `configureCli.ts` and `resetCli.ts`, and thin for the same reason:
// the driver is `scenarioRunner.ts`, the scenarios are `src/scenarios/`, and every judgement they
// make lives in a module with unit tests. This file supplies the real config, the real client and the
// real terminal, and owns the three things a test has no opinion about: what is settled before
// anything runs, what an operator reads, and the exit code.
//
// **The two facts settled here are settled ONCE, as ordinary values.** The pass's RUN ID is the key
// to the ledger every scenario passes facts through, and the operator's personal password opens the
// model their runs are pinned to. Under vitest both had to travel through a `globalSetup` hook and
// vitest's `provide`/`inject` RPC channel, because every spec file got its own module graph in its
// own worker process: an id minted per file is a ledger per file, and a password asked per file is four
// prompts a pass, each drawn over a reporter redrawing the same lines. In one process they are a
// `const` and a closure. Design record:
// `backend/docs/adr/0057-acceptance-standalone-runner.md`.
//
// **The whole command is ONE function returning an exit code**, rather than a script punctuated by
// `process.exit`. That call tears the process down without draining a PIPED stdout, and this command's
// output is routinely piped to a file for an afternoon (`… run acceptance | tee pass.log`), where what
// it would lose is the tail: the failure and the summary. Setting `process.exitCode` and letting the
// process end on its own flushes what was written.
//
// Two exit codes, and the distinction is what an operator does next. **2 = nothing ran**: the
// configuration, the run id or the ledger was refused, or a person declined the password prompt, and
// no model money was spent. **1 = a scenario failed**, which is a pass with real state behind it,
// left in place to inspect and to resume.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireConfig, stateDirFrom } from './config.ts'
import { envFile } from './envFile.ts'
import { assertPrerequisites, buildHarness, type Harness } from './harness.ts'
import { describeFailure, resumeInvocation } from './operatorText.ts'
import { askForPersonalPassword } from './personalPasswordAsk.ts'
import { createPersonalUnlock } from './personalUnlock.ts'
import { createClient, readPinnedPreset } from './publicApi.ts'
import {
  formatScenarioSummary,
  runScenarios,
  type ScenarioFailure,
  type ScenarioOutcome,
  scenariosExitCode,
} from './scenarioRunner.ts'
import { SCENARIOS } from './scenarios/index.ts'
import { recordsFacts, resolveRunId } from './world.ts'

/** How much of a failure the JOURNAL carries, the console holding the rest. See `journalFailure`. */
const JOURNAL_FAILURE_CHARS = 300

process.exitCode = await run()

async function run(): Promise<number> {
  // The `.env` beside `package.json`, with the shell winning over the file (`envFile.ts` owns that
  // rule). Read here rather than left to `process.env`, because that file IS where an operator's
  // configuration lives: eight variables, one of them an API key and one a ServiceAccount token, are
  // more than anyone wants to re-export per shell. Passed around as a record rather than merged into
  // `process.env`, so nothing downstream can read a value this file did not resolve.
  const env = { ...envFile(resolve(dirname(fileURLToPath(import.meta.url)), '..')), ...process.env }

  const opened = openPass(env)
  if (!opened.ok) {
    // Printed rather than thrown: each of these refusals is a list or an instruction, and a stack
    // above it is noise. Nothing has been created and nothing has been spent.
    console.error(opened.problem)
    return 2
  }
  const { harness, runId } = opened

  // Before the banner, as `globalSetup` was before the first test line: the prompt is the one thing
  // here a person has to read and answer, and anything drawn over it is what made this hard to follow
  // under a reporter that owned the same console.
  const declined = await askUpFront(harness)
  if (declined) {
    console.error(declined)
    return 2
  }

  // Printed before the first scenario because an operator whose pass dies in the bugfix scenario
  // needs this value to resume and has no other way to recover it. Which makes it the most important
  // command this suite prints, and therefore the one that may least be spelled for a shell the
  // operator is not holding: `resumeInvocation` renders it for the one that will receive it.
  console.log(
    `\nacceptance run ${runId} against ${harness.config.baseUrl}\n` +
      `  ledger:  ${harness.world.path}\n` +
      `  journal: ${harness.journal.path}\n` +
      `  watch:   pnpm --filter @cat-factory/acceptance run status ${runId}\n` +
      `  resume:  ${resumeInvocation(runId)}\n`,
  )

  const outcomes = await runScenarios(
    {
      open: (scenario) => {
        // The journal phase is entered HERE, in the one place that knows a scenario is starting, so
        // every line the scenario writes is filed under it. A scenario that entered its own phase
        // would be a fifth copy of the same call and the first one forgotten would file an
        // afternoon's observations under its predecessor.
        harness.journal.enterPhase(scenario.id)
        console.log(`\n${scenario.id}  ${scenario.title}`)
      },
      gate: () => assertPrerequisites(harness),
      log: (message) => console.log(message),
      onFailure: (_scenario, failure) => {
        harness.journal.record('failure', journalFailure(failure))
      },
      now: () => Date.now(),
    },
    SCENARIOS.map((build) => build(harness)),
  )

  console.log(formatScenarioSummary(outcomes))
  // The ledger AS IT NOW STANDS, not as it opened: what a failed pass may be told to do next turns
  // on whether anything was created, and the scenarios have been writing to it all afternoon.
  console.log(closingWords(outcomes, runId, recordsFacts(harness.world.value)))
  return scenariosExitCode(outcomes)
}

/**
 * Everything that must be settled before a scenario exists, or the refusal that stops the pass.
 *
 * Three things can refuse here and every one of them means nothing ran and nothing was spent: the
 * configuration (reported all at once, `config.ts`), a `latest` that names no pass, and a ledger
 * belonging to a different pass. They share ONE catch so `run` above has a single branch, and so
 * that a refusal is a printed instruction rather than a stack: each of these is a list or a fix, and
 * the ORDER is the point too, since nothing reaches the deployment until all three have answered.
 */
function openPass(
  env: Record<string, string | undefined>,
): { ok: true; harness: Harness; runId: string } | { ok: false; problem: string } {
  try {
    const config = requireConfig(env)
    // `latest` with nothing on disk is a REFUSAL rather than a fresh pass: the two are opposite
    // intents, and silently starting a new one spends an afternoon of real model money for an
    // operator who asked to continue.
    const runId = resolveRunId(env, stateDirFrom(env))
    // The harness is built INSIDE this try because opening the ledger is the third refusal: a file
    // whose own `runId` disagrees with its name was copied or renamed, and `WorldStore` will not
    // guess which half is right. Built before the password is asked for, so nobody is prompted by a
    // pass that cannot open its ledger.
    return {
      ok: true,
      harness: buildHarness({ config, runId, unlock: createPersonalUnlock() }),
      runId,
    }
  } catch (error) {
    // `describeFailure`, not the interpolating describer: the configuration refusal names every
    // missing variable with what each is for, and kernel's human budget would cut it after the first
    // two. A truncated list reads as a complete one.
    return { ok: false, problem: describeFailure(error) }
  }
}

/**
 * The ONE up-front personal-password ask, or the reason there was none.
 *
 * Up front rather than lazily, even though one process could now hold the answer from whenever it was
 * first needed: the operator is AT the terminal when a pass starts and is by design not there twenty
 * minutes later, when the first dispatch would discover the model needs a password. What it can never
 * do is END the pass (see `personalPasswordAsk.ts`): it runs before the first prerequisite has been
 * evaluated, so anything it threw would be the operator's whole output instead of the preflight's
 * diagnosis. The one exception is a person pressing Ctrl-C, which is a decision rather than a limit.
 *
 * It asks THROUGH the unlock holder, so the password lands in the same closure a lazy ask would have
 * filled and never in a value this file holds. The suite has no function that hands a password back
 * any more, which is what makes "written nowhere" structural rather than a rule to remember.
 */
async function askUpFront(harness: Harness): Promise<string | null> {
  try {
    await askForPersonalPassword({
      log: (message) => console.log(message),
      hold: (reason) => harness.unlock.obtain(reason),
      readPinned: () =>
        readPinnedPreset(createClient(harness.config), harness.config.modelPresetId),
    })
    return null
  } catch (error) {
    return describeFailure(error)
  }
}

/**
 * What the JOURNAL records about a failure, which is not all of it.
 *
 * The console holds the full text (a preflight refusal with numbered remedies runs to dozens of
 * lines). The journal is the record `status` reduces from another window, and it renders a phase's
 * last message on ONE line, so the whole failure pasted in makes the answer to "where is this pass"
 * unreadable. Capped, and the cap says what it dropped and where the rest is.
 */
function journalFailure(failure: ScenarioFailure): string {
  const where = failure.step ? `step '${failure.step}' failed` : 'failed'
  const text = failure.text.trim().replaceAll(/\s*\n\s*/g, ' ')
  return text.length > JOURNAL_FAILURE_CHARS
    ? `${where}: ${text.slice(0, JOURNAL_FAILURE_CHARS)}… (full failure on the console)`
    : `${where}: ${text}`
}

/**
 * The last thing an operator reads, and it says what to do next rather than restating the verdict.
 *
 * A failed pass leaves everything it created in place ON PURPOSE (the run, its pull request, any
 * provisioned namespace), so the commands that matter are the resume, the report and the clear, and
 * the resume is spelled for the shell holding this process.
 *
 * **Which of those it may offer depends on whether the pass created anything**, read off the ledger
 * rather than assumed from the failure. The commonest failure by far is a prerequisite refusing a
 * FRESH attempt, which by construction created nothing: offered a resume, an operator continues a
 * pass with an empty ledger, and told that "everything it created is still there to inspect" they go
 * looking for a run that does not exist. Same rule as the `latest` pointer and as `status`'s own
 * advice (`recordsFacts`), so the three cannot come to disagree.
 */
function closingWords(
  outcomes: readonly ScenarioOutcome[],
  runId: string,
  created: boolean,
): string {
  const failed = outcomes.find((outcome) => outcome.status === 'failed')
  if (!failed) {
    return `\nThe pass is complete: ${outcomes.length} scenario(s), nothing left to run.`
  }
  if (!created) {
    return (
      `\nThe pass stopped at '${failed.id}' having created nothing, so there is nothing to inspect ` +
      `and nothing to resume: fix what is named above and run it again.\n` +
      `  what it observed: pnpm --filter @cat-factory/acceptance run status ${runId}`
    )
  }
  return (
    `\nThe pass stopped at '${failed.id}', and everything it created is still there to inspect: ` +
    `the run, its pull request and any provisioned namespace.\n` +
    `  report: pnpm --filter @cat-factory/acceptance run status ${runId}\n` +
    `  resume: ${resumeInvocation(runId)}\n` +
    `  or start over: pnpm --filter @cat-factory/acceptance run reset ${runId}`
  )
}
