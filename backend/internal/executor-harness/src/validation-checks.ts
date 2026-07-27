import { spawn } from 'node:child_process'
import { killChildProcess, spawnDetached } from './process.js'
import { MAX_CAPTURED_OUTPUT_CHARS, redactSecrets } from './redact.js'
import type { RunOptions } from './runner.js'
import type { Logger } from './logger.js'

// PRE-PR VALIDATION — the generic check runner (see docs/initiatives/pre-pr-validation.md).
//
// A service can declare shell commands (install / lint / test / build) that run against the
// CHECKOUT after the coding agent settles and BEFORE a PR is opened. This module owns running
// them and shaping the report; the loop that feeds a failure back to the agent lives in
// `coding-agent.ts`, and the decision to run at all is made purely by the JOB BODY carrying
// `validationChecks` — there is deliberately no agent-kind switch anywhere in the harness.
//
// Everything here is PER-JOB by construction: the commands, the cwd, and the environment all
// arrive as arguments. Nothing is read from or written to `process.env` or `HOME`, because the
// local NATIVE transport serves every concurrent job from ONE host process — a global would leak
// one job's config into a sibling's checks, and the container path would never catch it.

/** One configured check, as it arrives on the job body. */
export interface ValidationCheckSpec {
  label: string
  command: string
}

/** The whole validation config a job carries. */
export interface ValidationChecksSpec {
  checks: ValidationCheckSpec[]
  /** How many agent+check rounds the loop may run (1 = check once, no repair round). */
  maxAttempts: number
}

/** One command's outcome within an attempt. */
export interface ValidationCheckOutcome {
  label: string
  command: string
  exitCode: number
  passed: boolean
  outputTail?: string
  durationMs?: number
  timedOut?: boolean
}

/**
 * One attempt's result: the REPORT that crosses the wire, plus the FULL (scrubbed, 16k) output
 * tails kept in memory for the repair prompt. The two are deliberately separate — see
 * {@link VALIDATION_REPORT_TAIL_CHARS}.
 */
export interface ValidationAttempt {
  report: ValidationReport
  /** Full scrubbed output per check label — never leaves the container. */
  fullTails: Map<string, string>
}

/** One attempt's report — what the backend records on the step. */
export interface ValidationReport {
  passed: boolean
  attempts: number
  maxAttempts: number
  outcomes: ValidationCheckOutcome[]
  at: number
}

/**
 * Per-command output kept on the REPORT (what crosses the wire and lands in the run's persisted
 * `detail` blob). Deliberately smaller than {@link MAX_CAPTURED_OUTPUT_CHARS}, which is what the
 * AGENT sees in its repair prompt: the agent needs the full failure to fix it, the operator needs
 * enough to recognise it, and a chatty build must not inflate every run's stored state.
 */
export const VALIDATION_REPORT_TAIL_CHARS = 4_000

/**
 * The per-command watchdog: the longest a single check may run before it is killed and treated
 * as a failure, so one hung `pnpm test` cannot wedge a run. Overridable via env for tests;
 * defaults to 15 minutes (matching the ralph completion command's watchdog).
 */
export function validationCommandTimeoutMs(): number {
  const n = Number(process.env.VALIDATION_COMMAND_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60_000
}

/**
 * How often the check loop feeds the run's inactivity watchdog. Well under the harness's own
 * `JOB_INACTIVITY_MS` (default 10 min) so a single slow command can never look wedged; matches
 * the frontend stand-up's heartbeat, which exists for exactly the same reason. Overridable via
 * env for tests, like {@link validationCommandTimeoutMs}.
 */
export function validationHeartbeatMs(): number {
  const n = Number(process.env.VALIDATION_HEARTBEAT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
}

/**
 * Run every configured check IN ORDER against `cwd` and build the attempt's report.
 *
 * Runs all of them even after one fails, rather than short-circuiting: the agent repairing the
 * checkout should see every problem at once instead of rediscovering the next one on the next
 * round, which is the difference between one repair round and four. (A check whose failure makes
 * the rest meaningless — e.g. a failed install — still costs only the cheap downstream failures.)
 *
 * Keeps the run's inactivity watchdog fed for the whole attempt. These commands are exactly the
 * activity-SILENT kind — a cold `install`, a full `test` run, a `build` — and the harness spawns
 * them itself rather than through the agent, so they emit no activity events of their own. The
 * job-level watchdog (`JOB_INACTIVITY_MS`, default 10 min) is TIGHTER than one command's own
 * watchdog ({@link validationCommandTimeoutMs}, default 15 min), so without this a legitimately
 * slow check would abort the entire run as "inactivity" — mislabelling a healthy build as a
 * wedge, and making the per-command timeout unreachable at stock settings.
 */
export async function runValidationChecks(
  cwd: string,
  spec: ValidationChecksSpec,
  attempt: number,
  logger: Logger,
  opts: RunOptions,
): Promise<ValidationAttempt> {
  const outcomes: ValidationCheckOutcome[] = []
  const fullTails = new Map<string, string>()
  const heartbeat = setInterval(() => opts.onActivity?.(), validationHeartbeatMs())
  heartbeat.unref?.()
  try {
    for (const check of spec.checks) {
      const { outcome, fullTail } = await runOneCheck(cwd, check, logger, opts)
      outcomes.push(outcome)
      if (fullTail) fullTails.set(check.label, fullTail)
    }
  } finally {
    clearInterval(heartbeat)
  }
  const report: ValidationReport = {
    passed: outcomes.every((o) => o.passed),
    attempts: attempt,
    maxAttempts: spec.maxAttempts,
    outcomes,
    at: Date.now(),
  }
  logger.info('validation: attempt finished', {
    attempt,
    maxAttempts: spec.maxAttempts,
    passed: report.passed,
    failed: outcomes.filter((o) => !o.passed).map((o) => o.label),
  })
  return { report, fullTails }
}

/**
 * Run ONE check as `sh -c <command>` in `cwd`, capturing a bounded, secret-scrubbed tail of its
 * combined stdout+stderr. The exit code is the verdict — computed here by the harness, never
 * self-reported by the model, which is the whole point of a programmatic gate. A watchdog kills
 * the process tree on timeout and an aborted run resolves non-zero, so the loop is never blocked.
 *
 * The child inherits the JOB's environment (`RunOptions.agentEnv` layered over the process env),
 * not a mutated global: the harness spawns this itself rather than through the agent, so without
 * the explicit merge a native-mode job would run its checks without the private-registry npmrc
 * pointer (and against a sibling job's state, had this been staged in `process.env`).
 */
async function runOneCheck(
  cwd: string,
  check: ValidationCheckSpec,
  logger: Logger,
  opts: RunOptions,
): Promise<{ outcome: ValidationCheckOutcome; fullTail?: string }> {
  const timeoutMs = validationCommandTimeoutMs()
  const startedAt = Date.now()
  logger.info('validation: running check', { label: check.label })
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let timedOut = false
    const child = spawn('sh', ['-c', check.command], {
      cwd,
      detached: spawnDetached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.agentEnv },
    })
    // Keep only the tail; guard against unbounded buffering on a chatty command.
    const capture = (chunk: Buffer): void => {
      out = (out + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT_CHARS)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const trimmed = out.trim()
      // Scrub BEFORE truncating: a token straddling the cut would otherwise survive as a
      // partial, and the pattern rules need the whole assignment to match.
      const scrubbed = trimmed ? redactSecrets(trimmed) : ''
      logger.info('validation: check finished', { label: check.label, exitCode })
      resolve({
        outcome: {
          label: check.label,
          command: check.command,
          exitCode,
          passed: exitCode === 0,
          ...(scrubbed ? { outputTail: tailFor(scrubbed) } : {}),
          durationMs: Date.now() - startedAt,
          ...(timedOut ? { timedOut: true } : {}),
        },
        ...(scrubbed ? { fullTail: scrubbed } : {}),
      })
    }
    const timer = setTimeout(() => {
      logger.warn('validation: check timed out', { label: check.label, timeoutMs })
      timedOut = true
      killChildProcess(child, undefined, logger)
      finish(124) // conventional timeout exit code (a non-zero fail)
    }, timeoutMs)
    timer.unref?.()
    const onAbort = (): void => {
      killChildProcess(child, undefined, logger)
      finish(130) // aborted (a non-zero fail)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      logger.warn('validation: check failed to spawn', {
        label: check.label,
        error: err instanceof Error ? err.message : String(err),
      })
      finish(127) // spawn error / command not found (a non-zero fail)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

/** Bound an already-scrubbed output tail to what the REPORT carries. */
function tailFor(scrubbed: string): string {
  if (scrubbed.length <= VALIDATION_REPORT_TAIL_CHARS) return scrubbed
  const trimmed = scrubbed.length - VALIDATION_REPORT_TAIL_CHARS
  return `…(${trimmed} earlier chars trimmed)\n${scrubbed.slice(-VALIDATION_REPORT_TAIL_CHARS)}`
}

/**
 * The repair instruction handed to the agent after a failed attempt: the failing commands and
 * their captured output, plus an explicit statement of the exit condition and the remaining
 * budget. The FULL captured tail is used here (not the report's smaller bound) — the agent needs
 * the whole failure to fix it, and this text never leaves the container.
 *
 * Deliberately prescriptive about scope: a validation loop that lets the agent "fix" the failure
 * by weakening the check is worse than no loop at all, so the prompt forbids editing the
 * commands' configuration to make them pass.
 */
export function buildRepairPrompt(
  report: ValidationReport,
  fullTails: Map<string, string>,
  /**
   * New files the agent created but never `git add`ed, if the caller can tell. The harness only
   * auto-stages TRACKED edits (`git add -u`), so an uncommitted new file is invisible to the push
   * — yet fully visible to the checks, which run against the working tree. Naming them here is
   * what stops the loop going green on work the pull request would not contain.
   */
  untrackedFiles: string[] = [],
): string {
  const failed = report.outcomes.filter((o) => !o.passed)
  const blocks = failed
    .map((o) => {
      const body = fullTails.get(o.label) ?? o.outputTail ?? '(no output captured)'
      const reason = o.timedOut
        ? `timed out after ${Math.round((o.durationMs ?? 0) / 1000)}s`
        : `exited ${o.exitCode}`
      return `### ${o.label} — ${reason}\n\n\`\`\`\n$ ${o.command}\n${body}\n\`\`\``
    })
    .join('\n\n')
  const remaining = report.maxAttempts - report.attempts
  const untracked = untrackedFiles.length
    ? [
        '',
        '## Uncommitted new files',
        '',
        'These files exist in your checkout but were never added to git, so they are NOT part of',
        'the branch even though the checks above ran against them. `git add` each one you meant to',
        'keep (or delete it), or the checks will pass on work the pull request will not contain:',
        '',
        ...untrackedFiles.map((f) => `- ${f}`),
      ]
    : []
  return [
    'The work you just finished does NOT pass this service’s required validation checks, so',
    'no pull request has been opened. Fix the failures below, then stop.',
    '',
    blocks,
    ...untracked,
    '',
    '## How this is judged',
    '',
    `The checks above are re-run automatically against your checkout when you stop. They are the`,
    `exit condition: a pull request opens only once every one of them exits 0. You have`,
    `${remaining} attempt(s) left before this task fails.`,
    '',
    '## Rules',
    '',
    '- Fix the underlying problem in the code. Do NOT edit, disable, skip, or relax the checks',
    '  themselves (their scripts, configs, thresholds, ignore files, or test assertions) to make',
    '  them pass — a green check obtained that way is a failed task.',
    '- Do not revert your earlier work; build on it.',
    '- Commit your fixes, as you did before. `git add` any NEW file you create — only changes to',
    '  files already tracked by git are staged for you, so an unadded file is silently dropped',
    '  from the branch even though the checks can see it.',
  ].join('\n')
}

/**
 * The pre-PR validation LOOP: run the checks, and while they fail and budget remains, hand the
 * captured output back to the agent as its next instruction and check again. Returns the LAST
 * attempt's report — `passed: true` means the caller may open the PR; `passed: false` means the
 * budget is spent and the caller must FAIL the job with this report as the evidence, opening
 * nothing.
 *
 * Generic by construction: it knows nothing about agent kinds, repos or PRs — only how to run
 * commands in a directory and how to ask for another pass. Every input (`workDir`, `spec`,
 * `opts.agentEnv`) is per-job, so two concurrent jobs on the ONE local-native host process cannot
 * see each other's configuration (`validation-checks.concurrency.test.ts` pins this).
 *
 * `onAttempt` publishes each completed attempt on the job view so the loop is observable while it
 * runs; `onAgentPass` lets the caller fold each repair pass's stats/usage/telemetry into the run's
 * totals, so a 3-round loop reports what all 3 rounds actually spent.
 */
export async function runValidationLoop<TRun>(args: {
  workDir: string
  spec: ValidationChecksSpec
  logger: Logger
  opts: RunOptions
  runAgentPass: (userPrompt: string) => Promise<TRun>
  onAgentPass?: (run: TRun) => void
  /**
   * Optional: the new files left uncommitted in the checkout, folded into each repair prompt.
   * Injected rather than read here so this module stays git-agnostic (it knows only how to run
   * commands in a directory and how to ask for another pass); the coding agent, which owns the
   * checkout, supplies it. A throw is swallowed — a missing warning must never fail the loop.
   */
  listUncommittedNewFiles?: () => Promise<string[]>
}): Promise<ValidationReport> {
  const { workDir, spec, logger, opts, runAgentPass, onAgentPass, listUncommittedNewFiles } = args
  let attempt = 1
  for (;;) {
    const { report, fullTails } = await runValidationChecks(workDir, spec, attempt, logger, opts)
    opts.onValidationReport?.(report)
    if (report.passed) {
      logger.info('validation: checkout is green', { attempt })
      return report
    }
    if (attempt >= spec.maxAttempts) {
      logger.warn('validation: attempt budget spent — no PR will be opened', {
        attempt,
        maxAttempts: spec.maxAttempts,
      })
      return report
    }
    attempt += 1
    logger.info('validation: repairing', { nextAttempt: attempt })
    opts.onPhase?.('validation-repair')
    const untracked = await safeListUncommitted(listUncommittedNewFiles, logger)
    const run = await runAgentPass(buildRepairPrompt(report, fullTails, untracked))
    onAgentPass?.(run)
    opts.onPhase?.('agent')
  }
}

/**
 * The uncommitted-new-file list for a repair prompt, never throwing: this is an ADVISORY
 * addition to the instruction, so a `git` hiccup must degrade to "no warning" rather than
 * failing a loop that is otherwise working.
 */
async function safeListUncommitted(
  list: (() => Promise<string[]>) | undefined,
  logger: Logger,
): Promise<string[]> {
  if (!list) return []
  try {
    return await list()
  } catch (error) {
    logger.warn('validation: could not list uncommitted new files', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * The failure message for a run whose pre-PR validation never went green: which checks failed
 * (with exit codes) and the last one's captured output. Read by the operator on the step's
 * failure card, so it must say what broke without needing the full report opened.
 */
export function validationFailureMessage(report: ValidationReport): string {
  const failed = report.outcomes.filter((o) => !o.passed)
  const names = failed.map((o) => `${o.label} (exit ${o.exitCode})`).join(', ')
  const last = failed[failed.length - 1]
  const tail = last?.outputTail?.trim()
  const head =
    `pre-PR validation failed after ${report.attempts} of ${report.maxAttempts} attempt(s)` +
    (names ? `: ${names}` : '') +
    '. No pull request was opened.'
  return tail ? `${head}\n\n$ ${last?.command}\n${tail}` : head
}
