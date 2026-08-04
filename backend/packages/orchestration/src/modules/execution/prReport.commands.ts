import type {
  ExecutionInstance,
  PipelineStep,
  PrReportReproduction,
  PrReportReproductionPhase,
  PrReportValidation,
  PrReportValidationCommand,
  ReproductionPhaseOutcome,
} from '@cat-factory/kernel'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { PR_REPORT_MAX_OUTPUT_CHARS } from '@cat-factory/contracts'
import { REPRO_DECLARATION_KIND } from './reproductionProof.logic.js'
import { findStep } from './prReport.steps.js'

// ---------------------------------------------------------------------------
// The verification report's two CAPTURED-OUTPUT sections: the platform's own pre-PR validation
// run, and the bugfix reproduction proof.
//
// Every other section of the report is a structured VERDICT somebody produced — a gate's
// aggregation, a judge's score, an agent's assessment. These two are the raw thing itself: a
// command ran in the checkout, here is its exit code, and here is what it printed. That is why
// they are worth the pull-request body budget they cost, and why they live together rather than
// beside the verdict sections in the report's spine.
//
// Both read state the executor-harness already wrote onto the step (`step.validation`,
// `step.reproduction`), so nothing here re-runs a command or re-reads a repo. The engine's job is
// to render what was captured, honestly:
//
//  - **Output is EVIDENCE, so it is bounded from the END.** A failure is reported at the tail of a
//    log (the assertion diff, the stack, the compiler summary), so a prefix cut throws away the
//    half the reader opened the report for. Every cut is recorded in the report's `truncations`.
//
//  - **A log is fenced with `outputBlock`, never a bare ``` fence.** Test runners and linters print
//    backticks; a fixed fence closes on the first such run and spills the rest of the log — plus
//    every section below it, including the machine-readable JSON block — into the body as prose.
//
//  - **A passing validation command's log is NOT retained, and the section SAYS so.** Ten green
//    logs would cost the budget that makes the failing one readable, and a `null` tail that could
//    be read as "the command printed nothing" is exactly the collapse this report exists to
//    remove. The reproduction proof keeps BOTH trees' logs whatever they did, because there the
//    log is the whole point: only a human can see whether the pre-fix tree was red for the right
//    reason.
// ---------------------------------------------------------------------------

/** Scrub credentials out of an optional free-text value, preserving `null`/`undefined`. */
function scrub(value: string | null | undefined): string | null {
  return value == null ? null : (redactSecrets(value) ?? null)
}

/**
 * The caps the report's spine owns, passed in so this module stays pure and every truncation
 * lands in the ONE `truncations` log a reader learns to read.
 */
export interface PrReportCommandCaps {
  /** Cap a list at the report's row budget, recording what was dropped. */
  cap: <T>(items: readonly T[], label: string) => T[]
  /**
   * Scrub and bound one captured output tail, recording what was dropped. Returns `null` for an
   * absent or empty log, so a caller can tell "nothing was captured" from "a log was cut".
   */
  output: (text: string | null | undefined, label: string) => string | null
}

/**
 * Build the output capper over the report's own truncation log. Lives here (not in the spine)
 * because the char budget and the tail-not-prefix rule are properties of captured output, and the
 * spine's list capper knows nothing about either.
 */
export function makeOutputCapper(truncations: string[]): PrReportCommandCaps['output'] {
  return (text, label) => {
    const scrubbed = scrub(text)
    if (!scrubbed) return null
    const bounded = hostMarkdown.boundOutput(scrubbed, PR_REPORT_MAX_OUTPUT_CHARS)
    if (bounded.dropped > 0) {
      // Says "the LAST n", because a reader who assumed a prefix would conclude the tail — where
      // the failure is actually reported — was never captured.
      truncations.push(
        `${label}: showing the last ${bounded.text.length} of ${bounded.total} characters`,
      )
    }
    return bounded.text
  }
}

// ---------------------------------------------------------------------------
// Pre-PR validation.
// ---------------------------------------------------------------------------

/**
 * Compose the PRE-PR VALIDATION section: the service's own check commands as the harness ran them
 * against the final checkout, with the captured output of whatever failed.
 *
 * This is the report's strongest single claim, because it is the one the platform ENFORCED: only a
 * green checkout opens a pull request. It is deliberately distinct from the `ci` section — CI is
 * the host's verdict on the pushed branch, on another machine and later; this is the platform's own
 * run of the service's commands on the exact tree that was pushed.
 *
 * Reported off the LAST step carrying a report: a run re-enters the coding loop on a repair round
 * and a later in-place fixer (`ci-fixer`) opens no PR and so runs no validation, which is why the
 * section follows the evidence rather than a fixed step position.
 */
export function composeValidation(
  instance: ExecutionInstance,
  caps: PrReportCommandCaps,
): PrReportValidation {
  const step = findStep(
    instance,
    (s) => s.validation != null,
    (s) => s.validation != null,
  )
  const report = step?.validation
  if (!step || !report) {
    return {
      status: 'absent',
      // The report is only ever published onto an EXISTING pull request, so a PR-opening dispatch
      // has by construction already settled: the absence is about what was configured, not about
      // how far the run got. Both remaining causes are named, because asserting only the first
      // would be a fabricated fact about somebody's setup (a runner image older than the feature
      // reports nothing either).
      note:
        'The platform ran no pre-PR validation on this tree — this service configures no check ' +
        'commands (a runner image predating the feature also reports none).',
      attempts: 0,
      commands: [],
    }
  }
  const commands: PrReportValidationCommand[] = caps
    .cap(report.outcomes, 'validation.commands')
    .map((outcome) => ({
      label: scrub(outcome.label) ?? 'check',
      command: scrub(outcome.command) ?? '',
      exitCode: outcome.exitCode,
      passed: outcome.passed,
      timedOut: outcome.timedOut ?? null,
      durationMs: outcome.durationMs ?? null,
      // A green check's log is the one thing here nobody acts on, and retaining ten of them would
      // cost the budget that makes the red one readable. The section states the rule, so a null
      // tail is never read as "it printed nothing".
      outputTail: outcome.passed
        ? null
        : caps.output(outcome.outputTail, `validation.output[${outcome.label}]`),
    }))
  return {
    status: 'reported',
    passed: report.passed,
    stepKind: step.agentKind,
    attempts: report.attempts,
    maxAttempts: report.maxAttempts,
    at: report.at ?? null,
    commands,
  }
}

/** One command's cell: the verdict marker plus what it exited with and how long it took. */
function commandResult(command: PrReportValidationCommand): string {
  if (command.passed) return `✅ passed${duration(command.durationMs)}`
  const how = command.timedOut ? 'timed out' : `exit ${command.exitCode}`
  return `❌ ${how}${duration(command.durationMs)}`
}

/** A wall-clock duration as a ` · 1.2s` suffix, or nothing when the producer recorded none. */
function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  return ` · ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

export function renderValidation(validation: PrReportValidation): string[] {
  const out = ['### Pre-PR validation', '']
  if (validation.status === 'absent') return [...out, `_${validation.note}_`, '']
  out.push(
    `**Verdict:** ${validation.passed ? '✅ every check passed' : '❌ checks failed'}` +
      ` · attempt ${validation.attempts}` +
      (validation.maxAttempts != null ? ` of ${validation.maxAttempts}` : ''),
    '',
    '_The platform ran these commands itself, in the checkout that opened this pull request._',
    '',
    '| Check | Command | Result |',
    '| --- | --- | --- |',
  )
  for (const command of validation.commands) {
    out.push(
      `| ${hostMarkdown.cell(command.label)} | \`${hostMarkdown.cell(command.command)}\` |` +
        ` ${commandResult(command)} |`,
    )
  }
  const failing = validation.commands.filter((c) => !c.passed)
  for (const command of failing) {
    if (!command.outputTail) continue
    out.push('', `**\`${hostMarkdown.inline(command.label)}\` output**`, '')
    out.push(hostMarkdown.outputBlock(command.outputTail))
  }
  if (validation.commands.length) {
    out.push(
      '',
      '_Captured output is retained for FAILING commands only; a passing check shows its exit',
      'code alone rather than its log._',
    )
  }
  return [...out, '']
}

// ---------------------------------------------------------------------------
// Bugfix reproduction proof.
// ---------------------------------------------------------------------------

/** Copy one tree's run onto the report, scrubbing and bounding its captured log. */
function composePhase(
  outcome: ReproductionPhaseOutcome | null | undefined,
  caps: PrReportCommandCaps,
  label: string,
): PrReportReproductionPhase | null {
  if (!outcome) return null
  return {
    exitCode: outcome.exitCode,
    passed: outcome.passed,
    durationMs: outcome.durationMs ?? null,
    timedOut: outcome.timedOut ?? null,
    setupFailed: outcome.setupFailed ?? null,
    // Both trees' logs are kept whatever they did: the verdict says red-then-green, and only a
    // human reading the two logs can see whether the pre-fix tree was red for the RIGHT reason —
    // the one thing the symmetric-worktree design deliberately does not claim to detect.
    outputTail: caps.output(outcome.outputTail, `reproduction.output[${label}]`),
  }
}

/**
 * Compose the BUGFIX REPRODUCTION PROOF section: was the declared reproducing check RED on the
 * pre-fix tree and GREEN on the final one?
 *
 * The verdict is the harness's, computed from two exit codes — the `repro-test` kind's own
 * `outcome` field has always been the model's CLAIM, and this section is what checks it. A run
 * whose reproduction step conceded carries the engine-minted `declared_infeasible` declaration
 * instead, so "could not be reproduced" reaches a reviewer as a real statement with its reason and
 * the alternative verification performed, never as an empty section indistinguishable from a run
 * that never tried.
 *
 * The two ways the section is `absent` are kept apart because they call for different things: a
 * pipeline with no reproduction step never declared a check to run (nothing to fix, unless the
 * pipeline is wrong for the task), while one that HAS the step and recorded no proof was either not
 * opted in or gave no runnable command.
 */
export function composeReproduction(
  instance: ExecutionInstance,
  caps: PrReportCommandCaps,
): PrReportReproduction {
  const step = findStep(
    instance,
    (s) => s.reproduction != null,
    (s) => s.reproduction != null,
  )
  const report = step?.reproduction
  if (!step || !report) {
    const declares = instance.steps.some(
      (s: PipelineStep) => s.agentKind === REPRO_DECLARATION_KIND,
    )
    return {
      status: 'absent',
      note: declares
        ? 'This run recorded no reproduction proof: the proof phase was not enabled for this ' +
          'task, or the reproduction step named no runnable command to verify.'
        : 'No reproduction step in this pipeline — nothing declared a reproducing check, so this ' +
          'change is not demonstrated against the pre-fix tree.',
      testPaths: [],
      attempts: 0,
    }
  }
  return {
    status: 'reported',
    verdict: report.status,
    command: scrub(report.command),
    testPaths: caps.cap(report.testPaths, 'reproduction.testPaths').map((p) => scrub(p) ?? ''),
    omittedTestPaths: report.omittedTestPaths ?? null,
    base: composePhase(report.base, caps, 'base'),
    final: composePhase(report.final, caps, 'final'),
    attempts: report.attempts,
    maxAttempts: report.maxAttempts,
    reason: scrub(report.reason),
    alternativeVerification: scrub(report.alternativeVerification),
    observation: scrub(report.note),
    at: report.at || null,
  }
}

/** The verdict headline: what was proven, in the terms a reviewer decides on. */
function reproductionHeadline(verdict: PrReportReproduction['verdict']): string {
  if (verdict === 'reproduced') {
    return '✅ **reproduced** — the declared check FAILED on the pre-fix tree and PASSES on this one'
  }
  if (verdict === 'declared_infeasible') {
    return '📋 **declared infeasible** — the agent stated the bug cannot be reproduced in a test'
  }
  return '⚠️ **inconclusive** — the check did not demonstrate the defect across the fix'
}

/** One tree's row: what it exited with, and whether it even got as far as running. */
function phaseResult(phase: PrReportReproductionPhase): string {
  if (phase.setupFailed) return '⚠️ setup failed (the check never ran)'
  if (phase.timedOut) return `⏱️ timed out${duration(phase.durationMs)}`
  const marker = phase.passed ? '✅ passed' : '❌ failed'
  return `${marker} · exit ${phase.exitCode}${duration(phase.durationMs)}`
}

/** The captured log of one tree, fenced so its own backticks cannot break out of the block. */
function renderPhaseOutput(
  phase: PrReportReproductionPhase | null | undefined,
  heading: string,
): string[] {
  if (!phase?.outputTail) return []
  return ['', `**${heading} output**`, '', hostMarkdown.outputBlock(phase.outputTail)]
}

export function renderReproduction(repro: PrReportReproduction): string[] {
  const out = ['### Reproduction proof', '']
  if (repro.status === 'absent') return [...out, `_${repro.note}_`, '']
  out.push(`**Verdict:** ${reproductionHeadline(repro.verdict)}`)

  if (repro.verdict === 'declared_infeasible') {
    if (repro.reason) out.push('', '**Why not:**', '', hostMarkdown.prose(repro.reason))
    if (repro.alternativeVerification) {
      out.push('', '**Verified instead:**', '', hostMarkdown.prose(repro.alternativeVerification))
    }
    // A concede that named neither is a declaration in form only, and the producer says so; a
    // blank body here is indistinguishable from a rendering bug.
    if (!repro.reason && !repro.alternativeVerification && repro.observation) {
      out.push('', `_${hostMarkdown.inline(repro.observation)}_`)
    }
    return [...out, '']
  }

  if (repro.command) out.push(`**Command:** \`${hostMarkdown.cell(repro.command)}\``)
  if (repro.testPaths.length) {
    out.push(
      `**Reproduction files:** ${repro.testPaths.map((p) => `\`${hostMarkdown.cell(p)}\``).join(', ')}`,
    )
  }
  if (repro.omittedTestPaths) {
    // A dropped path can leave the pre-fix tree without the reproduction, which greens it and reads
    // as "the test does not capture the defect". Stated, never implied.
    out.push(
      `**⚠️ ${repro.omittedTestPaths} declared test path${repro.omittedTestPaths === 1 ? ' was' : 's were'} dropped** ` +
        'before the proof ran, so the pre-fix tree was rebuilt from an incomplete reproduction.',
    )
  }
  out.push(
    `**Attempts:** ${repro.attempts}` +
      (repro.maxAttempts != null ? ` of ${repro.maxAttempts}` : ''),
    '',
    '| Tree | Result |',
    '| --- | --- |',
  )
  out.push(`| Pre-fix | ${repro.base ? phaseResult(repro.base) : 'not run'} |`)
  // An absent `final` is NORMAL for an inconclusive verdict: a green pre-fix tree already settles
  // it, and running the second tree could only confirm what is already not proof. So it says why
  // rather than reading as missing data.
  out.push(
    `| Final | ${repro.final ? phaseResult(repro.final) : 'not run (the pre-fix tree already settled the verdict)'} |`,
  )
  if (repro.observation) {
    // Rendered VERBATIM. The producer is the only side that can tell a test which does not capture
    // the defect from a resumed run whose pre-fix tree already carried this step's own work, and
    // re-deriving a cause from the exit codes here is exactly the inference that gets it wrong.
    out.push('', `_${hostMarkdown.inline(repro.observation, hostMarkdown.MAX_PROSE_CHARS)}_`)
  }
  out.push(...renderPhaseOutput(repro.base, 'Pre-fix tree'))
  out.push(...renderPhaseOutput(repro.final, 'Final tree'))
  return [...out, '']
}
