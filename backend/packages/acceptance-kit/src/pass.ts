// A PASS: the banner, the scenarios, the summary, the closing words, and the exit code.
//
// The half of an entry point that is the same for every suite built on this kit. What a suite keeps
// for itself is what it takes to OPEN a pass (its configuration, its client, whatever credential its
// models need), because none of that is knowable here; what it hands over is the run id, the ledger,
// the journal and the scenarios.
//
// Three properties are the whole contract, and each was debugged into existence:
//
//   - **Every line goes to STDOUT, refusals included, and nothing calls `process.exit`.** Both halves
//     of one rule: an afternoon-long pass is piped to a file (`… | tee pass.log`), `tee` captures one
//     stream, and `process.exit` tears the process down without draining a piped stdout, so what it
//     loses is the tail: the failure and the summary. The exit code carries the verdict; the stream
//     carries the answer.
//   - **The exit code says whether a scenario RAN, never whether anything was created.** That second
//     fact is read off the ledger, because the commonest failure of all is a prerequisite refusing a
//     fresh attempt, which fails having created nothing.
//   - **A boundary renders a throw by WHAT IT IS, not by which boundary it is.** An `OperatorRefusal`
//     is printed whole (it is a list or a fix, and a stack over it buries the last item); anything
//     else is a bug in the suite, said outright and carrying its location, without which `Cannot read
//     properties of undefined` is an afternoon of guessing.

import { Journal } from './journal.js'
import type { LedgerFacts, LedgerStore } from './ledger.js'
import {
  describeFailure,
  describeThrown,
  failureWithLocation,
  OperatorRefusal,
} from './operatorText.js'
import {
  formatScenarioSummary,
  type Scenario,
  type ScenarioFailure,
  type ScenarioOutcome,
  runScenarios,
  scenariosExitCode,
} from './scenarioRunner.js'
import { resumeCommand, type SuiteIdentity, suiteCommand } from './suiteIdentity.js'

/** How much of a failure the JOURNAL carries, the console holding the rest. See `journalFailure`. */
const JOURNAL_FAILURE_CHARS = 300

export type PassOptions<Facts extends LedgerFacts> = {
  identity: SuiteIdentity
  /** The deployment this pass drives, for the banner. Scrub it if it may carry userinfo. */
  target: string
  ledger: LedgerStore<Facts>
  journal: Journal
  scenarios: readonly Scenario[]
  /** The prerequisite gate, run before every scenario that declares itself gated. */
  gate: () => Promise<void>
  /** Operator output. ONE sink per pass, so a second destination is one change rather than a hunt. */
  log: (message: string) => void
  /**
   * Whether the ledger AS IT NOW STANDS records anything the pass created.
   *
   * A function rather than a boolean, because it is asked AFTER the scenarios have been writing to
   * the ledger all afternoon: what a failed pass may be told to do next turns on the answer, and a
   * value read at the start is the answer to a different question.
   */
  recordsFacts: () => boolean
}

/**
 * Run the pass. Answers the exit code; throws nothing.
 *
 * Everything from the banner on can have created something, which is what the boundary is for: a
 * scenario FACTORY that refuses at build time, or a throw out of the summary or the closing words
 * after an afternoon of real spend, is a bug in the suite rather than a scenario failure, and it must
 * still leave the operator holding the run id, the ledger and the resume.
 */
export async function runPass<Facts extends LedgerFacts>(
  options: PassOptions<Facts>,
): Promise<number> {
  const { identity, ledger, journal, log } = options
  const runId = ledger.value.runId
  // Printed before the first scenario because an operator whose pass dies late needs this value to
  // resume and has no other way to recover it. Which makes it the most important command a suite
  // prints, and therefore the one that may least be spelled for a shell the operator is not
  // holding: `resumeCommand` renders it for the one that will receive it.
  log(
    `\n${identity.name} run ${runId} against ${options.target}\n` +
      `  ledger:  ${ledger.path}\n` +
      `  journal: ${journal.path}\n` +
      (identity.statusCommand
        ? `  watch:   ${suiteCommand(identity.statusCommand, runId)}\n`
        : '') +
      `  resume:  ${resumeCommand(identity, runId)}\n`,
  )

  try {
    const outcomes = await runScenarios(
      {
        open: (scenario) => {
          // The journal phase is entered HERE, in the one place that knows a scenario is starting,
          // so every line the scenario writes is filed under it. A scenario that entered its own
          // phase would be one copy of the same call per scenario, and the first one forgotten
          // would file an afternoon's observations under its predecessor.
          journal.enterPhase(scenario.id)
          log(`\n${scenario.id}  ${scenario.title}`)
        },
        gate: options.gate,
        log,
        onFailure: (failure) => {
          journal.record('failure', journalFailure(failure))
        },
        now: () => Date.now(),
      },
      options.scenarios,
    )

    log(formatScenarioSummary(outcomes))
    // Straight, not guarded: on this path the read is ordinary work, and a ledger that cannot be
    // read is a failure of the pass rather than a line to soften. The boundary below owns that.
    log(closingWords(outcomes, runId, options.recordsFacts(), identity))
    return scenariosExitCode(outcomes)
  } catch (error) {
    // `console.log` rather than the injected sink, here and at a suite's own startup boundaries: a
    // boundary reports a failure of the pass's own machinery, so it may not route its report
    // through a seam that pass wired. The narration above goes through the seam; the reports out go
    // straight to the stream.
    console.log(
      describeStartupFailure(
        error,
        `\nThe pass stopped on a failure of the SUITE ITSELF, not of a scenario: nothing below is ` +
          `a verdict about the deployment.`,
      ) +
        `\n\n` +
        // The ids and the paths are named unconditionally, unlike `closingWords`: this is the one
        // exit whose own report may be the thing that broke, so what it owes the operator is the
        // facts rather than advice derived from a report it may not be able to make.
        `The pass is '${runId}'. Its ledger is ${ledger.path} and its journal is ` +
        `${journal.path}; both are as the last scenario left them.\n` +
        // The RESUME is the one line that is not a fact, and it follows the same ledger read
        // `closingWords` makes rather than being offered on the strength of having got this far.
        // This boundary is reachable strictly earlier than that one: a scenario FACTORY that throws
        // at build time lands here with an empty ledger, and a resume offered there continues a
        // pass that created nothing, which is the afternoon of spend the ledger exists to avoid.
        //
        // Read through a guard, because that reading is one of the things that can have BROKEN: it
        // is what this boundary just caught in at least one shape, and a second throw here would
        // replace the report with its own and leave the operator holding neither.
        resumeAdvice(runId, readLedgerFacts(options.recordsFacts), identity),
    )
    return 1
  }
}

/**
 * A throw at a startup or pass boundary, rendered by what it IS.
 *
 * An `OperatorRefusal` is the whole message and gets no preamble and no frames: it was authored for
 * this reader, and a stack over a fourteen-item remedy list buries the last of them. Anything else is
 * a bug in the suite, which is said outright (so nobody hunts a deployment problem that is not there)
 * and carries its location.
 *
 * Exported because a suite's own entry point has the same job before a pass exists: resolving a
 * configuration, a run id and a ledger can each refuse, and each of those refusals is an instruction
 * rather than a stack.
 */
export function describeStartupFailure(error: unknown, preamble: string): string {
  return error instanceof OperatorRefusal
    ? describeFailure(error)
    : `${preamble}\n\n${failureWithLocation(error)}`
}

/**
 * What the JOURNAL records about a failure, which is not all of it.
 *
 * The console holds the full text (a preflight refusal with numbered remedies runs to dozens of
 * lines). The journal is the record a status report reduces from another window, and it renders a
 * phase's last message on ONE line, so the whole failure pasted in makes the answer to "where is this
 * pass" unreadable. Capped, and the cap says what it dropped and where the rest is.
 *
 * The MESSAGE half only, never the location: `ScenarioFailure` carries the two separately for this
 * reason. Folded together and newline-collapsed, a suite bug's six frames rode into the phase line as
 * `TypeError… at C:\…\resume.ts:88:12 at …`, which is the line a status report presents as the
 * shareable answer to where a pass got to. The frames belong on the console, which already has them.
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
 * looking for a run that does not exist. Same rule as the `latest` pointer and as a status report's
 * own advice (`recordsFacts`), so the three cannot come to disagree.
 */
export function closingWords(
  outcomes: readonly ScenarioOutcome[],
  runId: string,
  created: boolean,
  identity: SuiteIdentity,
): string {
  const failed = outcomes.find((outcome) => outcome.status === 'failed')
  const status = identity.statusCommand
    ? `\n  report: ${suiteCommand(identity.statusCommand, runId)}`
    : ''
  if (!failed) {
    return `\nThe pass is complete: ${outcomes.length} scenario(s), nothing left to run.`
  }
  if (!created) {
    return (
      `\nThe pass stopped at '${failed.id}' having created nothing, so there is nothing to inspect ` +
      `and nothing to resume: fix what is named above and run it again.${status}`
    )
  }
  const reset = identity.resetCommand
    ? `\n  or start over: ${suiteCommand(identity.resetCommand, runId)}`
    : ''
  return (
    `\nThe pass stopped at '${failed.id}', and everything it created is still there to inspect: ` +
    `the run, its pull request and anything it provisioned.${status}\n` +
    `  resume: ${resumeCommand(identity, runId)}${reset}`
  )
}

/**
 * The resume line, what to do instead when there is nothing behind this pass, or the fact that the
 * question could not be answered.
 *
 * Three outcomes rather than two, because the third is real at exactly this boundary: the ledger
 * read is one of the things that can have failed, and "there is nothing to resume" said on the
 * strength of a read that threw is the one wrong answer that costs an afternoon of work.
 */
function resumeAdvice(runId: string, reading: LedgerReading, identity: SuiteIdentity): string {
  if (reading.unreadable) {
    return (
      `Whether this pass created anything could not be read (${reading.unreadable}), so neither ` +
      `answer is offered here: read the ledger named above before starting over, and resume with ` +
      `${resumeCommand(identity, runId)} if it holds anything.`
    )
  }
  return reading.created
    ? `  resume: ${resumeCommand(identity, runId)}`
    : `This pass created nothing, so there is nothing to resume: fix what is named above and run it ` +
        `again.`
}

/** What the ledger said, or why it could not say. */
type LedgerReading = { created: boolean; unreadable: null } | { created: false; unreadable: string }

/**
 * The ledger's own reading, guarded.
 *
 * NOT a swallow: what it catches is reported by {@link resumeAdvice} as its own outcome, cause and
 * all. The guard exists because this runs inside the boundary that is already reporting a failure,
 * and a throw from it would replace that report with this one.
 */
function readLedgerFacts(recordsFacts: () => boolean): LedgerReading {
  try {
    return { created: recordsFacts(), unreadable: null }
  } catch (error) {
    return { created: false, unreadable: describeThrown(error) }
  }
}
