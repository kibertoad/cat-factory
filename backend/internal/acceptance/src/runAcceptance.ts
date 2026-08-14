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
// **Which is also why every line this command writes goes to STDOUT, refusals included.** `tee`
// captures one stream, and half of what this command exists to say arrives on the way out: the
// configuration refusal, the `latest`-names-nothing refusal, the declined prompt, and the suite-failure
// report carrying the run id and both paths. Written to stderr, each of those is on the terminal and
// absent from the log an operator keeps, so the captured pass reads as one that stopped saying anything.
// The refusals are this command's PRODUCT rather than diagnostics about it, which is the same reason
// `resetCli.ts` prints its plan to stdout.
//
// Two exit codes, and the distinction is what an operator does next. **2 = nothing ran**: the
// configuration, the run id or the ledger was refused, or a person declined the password prompt, so no
// scenario was reached and no model money was spent. **1 = a scenario failed**, and the pass therefore
// got as far as running. Whether it CREATED anything is a separate fact, read off the ledger and stated
// by `closingWords`: the commonest failure of all is a prerequisite refusing a fresh attempt, which
// exits 1 having created nothing, so an exit code is not the thing to conclude "there is state to
// resume" from.
//
// **Both exits are reached by RETURNING, and everything that could reach one another way is inside a
// boundary.** An escaped throw is the third outcome the contract above does not have: Node prints a
// stack and exits 1, which an operator reads as "a scenario failed, your state is still there,
// resume it", and none of the summary, the ledger path or the resume command is printed at the
// moment they are worth the most. So the pass has a boundary of its own (below), and the whole
// command has one under it for anything before a pass exists.
//
// **A boundary renders a throw by WHAT IT IS, not by which boundary it is.** Each of the three catches
// below can meet a refusal this suite authored (printed whole: it is a list or a fix, and a stack over
// it is noise) and a bug in the suite (unreadable without the file and line). `OperatorRefusal`
// separates them, because a boundary that guessed from its own position printed
// `Cannot read properties of undefined` as one contentless sentence.

import { requireConfig, stateDirFrom } from './config.ts'
import { envFile } from './envFile.ts'
import { buildHarness, type Harness } from './harness.ts'
import {
  describeFailure,
  failureWithLocation,
  OperatorRefusal,
  resumeInvocation,
  scrubbed,
} from './operatorText.ts'
import { packageRoot } from './passFiles.ts'
import { askForPersonalPassword } from './personalPasswordAsk.ts'
import { createPersonalUnlock } from './personalUnlock.ts'
import { readPinnedPreset } from './publicApi.ts'
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

process.exitCode = await run().catch((error: unknown) => {
  // The outermost boundary, and it answers 2 because everything inside it that can create anything
  // has its own (see `runPass`): reaching here means the `.env`, the configuration or the run id
  // threw on the way in, so nothing was created and nothing was spent.
  console.log(
    startupFailure(
      error,
      `The acceptance suite could not start, and this is a failure of the SUITE rather than a ` +
        `refusal it meant to print. Nothing was created.`,
    ),
  )
  return 2
})

async function run(): Promise<number> {
  // The `.env` beside `package.json`, with the shell winning over the file (`envFile.ts` owns that
  // rule). Read here rather than left to `process.env`, because that file IS where an operator's
  // configuration lives: eight variables, one of them an API key and one a ServiceAccount token, are
  // more than anyone wants to re-export per shell. Passed around as a record rather than merged into
  // `process.env`, so nothing downstream can read a value this file did not resolve.
  const env = { ...envFile(packageRoot), ...process.env }

  const opened = openPass(env)
  if (!opened.ok) {
    // Printed rather than thrown: each of these refusals is a list or an instruction, and a stack
    // above it is noise. Nothing has been created and nothing has been spent.
    console.log(opened.problem)
    return 2
  }
  const { harness } = opened

  // Before the banner, as `globalSetup` was before the first test line: the prompt is the one thing
  // here a person has to read and answer, and anything drawn over it is what made this hard to follow
  // under a reporter that owned the same console.
  const declined = await askUpFront(harness)
  if (declined) {
    console.log(declined)
    return 2
  }

  return runPass(harness)
}

/**
 * The pass itself, from the banner to the closing words, with the boundary that owns exit code 1.
 *
 * Everything from here on can have created something, which is what the boundary is for: a scenario
 * FACTORY that refuses at build time, or a throw out of the summary or the closing words after an
 * afternoon of real spend, is a bug in the suite rather than a scenario failure, and it must still
 * leave the operator holding the run id, the ledger and the resume. Reported as what it is, so
 * nobody goes hunting a scenario that did not fail.
 */
async function runPass(harness: Harness): Promise<number> {
  const runId = harness.world.value.runId
  // Printed before the first scenario because an operator whose pass dies in the bugfix scenario
  // needs this value to resume and has no other way to recover it. Which makes it the most important
  // command this suite prints, and therefore the one that may least be spelled for a shell the
  // operator is not holding: `resumeInvocation` renders it for the one that will receive it.
  //
  // The address is SCRUBBED: it may legitimately carry userinfo, no URL policy rejects it, and this
  // banner heads the file an afternoon-long pass is piped into.
  harness.log(
    `\nacceptance run ${runId} against ${scrubbed(harness.config.baseUrl)}\n` +
      `  ledger:  ${harness.world.path}\n` +
      `  journal: ${harness.journal.path}\n` +
      `  watch:   pnpm --filter @cat-factory/acceptance run status ${runId}\n` +
      `  resume:  ${resumeInvocation(runId)}\n`,
  )

  try {
    const outcomes = await runScenarios(
      {
        open: (scenario) => {
          // The journal phase is entered HERE, in the one place that knows a scenario is starting,
          // so every line the scenario writes is filed under it. A scenario that entered its own
          // phase would be a fifth copy of the same call and the first one forgotten would file an
          // afternoon's observations under its predecessor.
          harness.journal.enterPhase(scenario.id)
          harness.log(`\n${scenario.id}  ${scenario.title}`)
        },
        gate: () => harness.prerequisites.assert(),
        // The harness's own sink, not a second closure over the same console: what makes the seam
        // worth having is that there is exactly ONE of it per pass.
        log: harness.log,
        onFailure: (failure) => {
          harness.journal.record('failure', journalFailure(failure))
        },
        now: () => Date.now(),
      },
      SCENARIOS.map((build) => build(harness)),
    )

    harness.log(formatScenarioSummary(outcomes))
    // The ledger AS IT NOW STANDS, not as it opened: what a failed pass may be told to do next turns
    // on whether anything was created, and the scenarios have been writing to it all afternoon.
    harness.log(closingWords(outcomes, runId, recordsFacts(harness.world.value)))
    return scenariosExitCode(outcomes)
  } catch (error) {
    // `console.log` rather than `harness.log`, here and at the other two boundaries: a boundary reports
    // a failure of the pass's own machinery, so it may not route its report through a seam that pass
    // wired. The narration above goes through the seam; the reports out go straight to the stream.
    console.log(
      startupFailure(
        error,
        `\nThe pass stopped on a failure of the SUITE ITSELF, not of a scenario: nothing below is a ` +
          `verdict about the deployment.`,
      ) +
        `\n\n` +
        // The ids and the paths are named unconditionally, unlike `closingWords`: this is the one exit
        // whose own report may be the thing that broke, so what it owes the operator is the facts
        // rather than advice derived from a report it may not be able to make.
        `The pass is '${runId}'. Its ledger is ${harness.world.path} and its journal is ` +
        `${harness.journal.path}; both are as the last scenario left them.\n` +
        `  report: pnpm --filter @cat-factory/acceptance run status ${runId}\n` +
        // The RESUME is the one line that is not a fact, and it follows the same ledger read
        // `closingWords` makes rather than being offered on the strength of having got this far. This
        // boundary is reachable strictly earlier than that one: a scenario FACTORY that throws at build
        // time lands here with an empty ledger, and a resume offered there continues a pass that
        // created nothing, which is the afternoon of spend the ledger exists to avoid. Safe to ask
        // even here, because it reads the store's own in-memory value and touches no file.
        resumeAdvice(runId, recordsFacts(harness.world.value)),
    )
    return 1
  }
}

/** The resume line, or what to do instead when there is nothing behind this pass to continue. */
function resumeAdvice(runId: string, created: boolean): string {
  return created
    ? `  resume: ${resumeInvocation(runId)}`
    : `This pass created nothing, so there is nothing to resume: fix what is named above and run it ` +
        `again.`
}

/**
 * A throw at one of the three startup/pass boundaries, rendered by what it IS.
 *
 * An `OperatorRefusal` is the whole message and gets no preamble and no frames: it was authored for
 * this reader, and a stack over a fourteen-item remedy list buries the last of them. Anything else is a
 * bug in the suite, which is said outright (so nobody hunts a deployment problem that is not there) and
 * carries its location, without which `Cannot read properties of undefined` is an afternoon of guessing.
 */
function startupFailure(error: unknown, preamble: string): string {
  return error instanceof OperatorRefusal
    ? describeFailure(error)
    : `${preamble}\n\n${failureWithLocation(error)}`
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
): { ok: true; harness: Harness } | { ok: false; problem: string } {
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
    //
    // The harness is the WHOLE result: the run id is not returned beside it, because the harness
    // carries it (`world.value.runId`) and `WorldStore` refuses to open a ledger that disagrees with
    // its own name. Two copies threaded separately is two things that can drift.
    return {
      ok: true,
      harness: buildHarness({
        config,
        runId,
        unlock: createPersonalUnlock(),
        // The SAME sink the driver logs through, so the fourteen prerequisite verdict lines are not
        // the one thing in a pass that goes somewhere else.
        log: (message) => console.log(message),
      }),
    }
  } catch (error) {
    // Refusals go through `describeFailure` rather than the interpolating describer: the configuration
    // refusal names every missing variable with what each is for, and kernel's human budget would cut
    // it after the first two, where a truncated list reads as a complete one. Anything that is NOT a
    // refusal is a bug in this resolution, and `startupFailure` says so and keeps its frames.
    return {
      ok: false,
      problem: startupFailure(
        error,
        `The pass could not be opened, and this is a failure of the SUITE rather than a refusal it ` +
          `meant to print. Nothing was created.`,
      ),
    }
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
 *
 * And it FILLS that holder, so from here the credential is something the pass simply has. Collecting
 * it and withholding it until the first `428` was considered and rejected: it narrows the exposure to
 * a handful of reads against the ONE deployment this pass is pinned to (which consults this header
 * only on the gated run calls), and in exchange it makes having the credential a rule each call site
 * remembers through `withPersonalUnlock` rather than a property of the client seam. The reader here
 * is somebody who started a headless pass and left, so the failure that costs the most is the one
 * discovered at 4pm by a terminal nobody is at.
 *
 * The catalog read goes through the PASS's own client, not a second one built to omit the unlock.
 * That distinction was real under vitest, where `globalSetup` ran before any harness existed; here
 * the holder is empty at this instant by construction (this is the ask that fills it), so its
 * `headers()` answers `{}` and the two clients send byte-identical requests.
 */
async function askUpFront(harness: Harness): Promise<string | null> {
  try {
    await askForPersonalPassword({
      log: harness.log,
      hold: (reason) => harness.unlock.obtain(reason),
      readPinned: () => readPinnedPreset(harness.client, harness.config.modelPresetId),
    })
    return null
  } catch (error) {
    // `PersonalPasswordDeclined` is the one thing this is designed to reject with, and it is a
    // sentence. A throw from anywhere else in the ask is a bug in a hook whose whole contract is that
    // it cannot end a pass, so it is reported as one, with its location.
    return startupFailure(
      error,
      `The up-front password ask failed, and this is a failure of the SUITE rather than a refusal it ` +
        `meant to print. Nothing was created.`,
    )
  }
}

/**
 * What the JOURNAL records about a failure, which is not all of it.
 *
 * The console holds the full text (a preflight refusal with numbered remedies runs to dozens of
 * lines). The journal is the record `status` reduces from another window, and it renders a phase's
 * last message on ONE line, so the whole failure pasted in makes the answer to "where is this pass"
 * unreadable. Capped, and the cap says what it dropped and where the rest is.
 *
 * The MESSAGE half only, never the location: `ScenarioFailure` carries the two separately for this
 * reason. Folded together and newline-collapsed, a suite bug's six frames rode into the phase line as
 * `TypeError… at C:\…\resume.ts:88:12 at …`, which is the line the README presents as the shareable
 * answer to where a pass got to. The frames belong on the console, which already has them.
 */
function journalFailure(failure: ScenarioFailure): string {
  const where = failure.step ? `step '${failure.step}' failed` : 'failed'
  const text = failure.message.trim().replaceAll(/\s*\n\s*/g, ' ')
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
