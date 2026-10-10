import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCapturedCommand } from './captured-command.js'
import { addWorktree, checkoutPathsFrom, pathsPresentAtCommit, removeWorktree } from './git.js'
import type { RunOptions } from './runner.js'
import type { Logger } from './logger.js'

// BUGFIX REPRODUCTION PROOF — the container half (see
// docs/initiatives/bugfix-reproduction-proof.md).
//
// A bugfix pull request claims a change fixes a defect. The verification report already captures
// the state of the work at the END (CI, pre-PR validation, the tester report); none of it shows
// the defect ever manifested. This module supplies the missing half: it runs the run's DECLARED
// reproduction command against TWO trees of the same clone — the pre-fix tree and the tree the PR
// will open from — and reports both exit codes with their captured output. Only RED-then-GREEN is
// proof. The verdict is computed here from exit codes, never self-reported by the model (the
// `repro-test` kind's `outcome` field has always been the model's own claim, which is exactly what
// this replaces with a captured fact).
//
// SYMMETRY IS THE SAFETY PROPERTY (the initiative's D4). A non-zero exit at the base proves
// nothing on its own: a missing toolchain, an uninstalled dependency, or an unrelated pre-existing
// breakage all produce one. Because both phases run in freshly-created worktrees with the SAME
// setup command and the SAME declared test files, an environmental defect fails BOTH — and
// red-then-red is reported as `inconclusive`, never as proof. What symmetry does NOT catch is
// red-for-the-wrong-REASON (a load error at base the fix incidentally resolves); both captured
// outputs ride the report precisely so a human can see why it was red. Do not let a later
// iteration quietly claim more than that.
//
// Generic machinery keyed purely off the JOB BODY carrying `reproduction` — there is deliberately
// no agent-kind switch anywhere in the harness. Everything is PER-JOB by construction: the
// worktree root is a fresh `mkdtemp`, and the commands, cwd and environment all arrive as
// arguments. Nothing is read from or written to `process.env` or `HOME`, because the local NATIVE
// transport serves every concurrent job from ONE host process — a shared worktree root would let
// two bugfix runs clobber each other's base trees, and the container path would never catch it
// (`reproduction-proof.concurrency.test.ts` pins this).

/** The reproduction spec as it arrives on the job body. */
export interface ReproductionSpec {
  /** The command that runs EXACTLY the declared reproduction test(s), as `sh -c` in the checkout. */
  command: string
  /** The test file(s) that constitute the reproduction (repo-relative, already sanitized). */
  testPaths: string[]
  /**
   * How many declared paths the ENGINE dropped while resolving this spec (over the cap, absolute,
   * traversing, over-long). Echoed onto the report unchanged: a dropped path can leave the base
   * tree without the reproduction, which greens it and reads as "the test does not capture the
   * defect", so the omission has to travel with the verdict rather than being implied by it.
   */
  omittedTestPaths?: number
  /** Optional command that makes a FRESH worktree runnable (a dependency install). */
  setupCommand?: string
  /** How many agent+verify rounds the loop may run before it settles for `inconclusive`. */
  maxAttempts: number
}

/** One tree's run of the reproduction command. */
export interface ReproductionPhaseOutcome {
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure, 130 on abort. */
  exitCode: number
  passed: boolean
  /** Bounded, secret-scrubbed tail of the command's combined stdout+stderr. */
  outputTail?: string
  durationMs?: number
  timedOut?: boolean
  /** Set when THIS phase's setup command failed, so the tree never ran the check meaningfully. */
  setupFailed?: boolean
}

/** The harness-computed reproduction report — what crosses the wire onto the step. */
export interface ReproductionReport {
  /**
   * `reproduced` — RED on the pre-fix tree, GREEN on the final tree (the only shape that is
   * proof); `inconclusive` — every other shape, recorded honestly rather than dressed up. The
   * harness never emits `declared_infeasible`: a conceded run dispatches no proof at all, so the
   * ENGINE mints that one from the declaration itself.
   */
  status: 'reproduced' | 'inconclusive'
  command: string
  testPaths: string[]
  omittedTestPaths?: number
  base?: ReproductionPhaseOutcome
  /** Absent when the base run settled the verdict (a green or un-runnable base). */
  final?: ReproductionPhaseOutcome
  attempts: number
  maxAttempts: number
  /** For `inconclusive`: which shape was observed, in one line, for the report and the step card. */
  note?: string
  at: number
}

/**
 * Per-phase output kept on the REPORT (what crosses the wire and lands in the run's persisted
 * `detail` blob). Deliberately smaller than `MAX_CAPTURED_OUTPUT_CHARS` (`redact.ts`), which is
 * what the AGENT sees in its repair prompt — the same split, for the same reasons, as the pre-PR
 * validation report's tail (`validation-checks.ts`).
 */
export const REPRODUCTION_REPORT_TAIL_CHARS = 4_000

/**
 * The ceiling the harness clamps a body-supplied `reproduction.maxAttempts` to, and the default it
 * applies when the body omits one.
 *
 * DELIBERATE DUPLICATES of `REPRODUCTION_DEFAULT_MAX_ATTEMPTS` in `@cat-factory/contracts` (and of
 * the validation loop's own ceiling) — the published image takes no schema dependency, so the
 * harness cannot import them. Keep them in step: a harness clamping to a DIFFERENT ceiling would
 * silently cap a budget the engine was allowed to send, with nothing to flag the mismatch.
 */
export const REPRODUCTION_DEFAULT_MAX_ATTEMPTS = 3
export const REPRODUCTION_MAX_ATTEMPTS_CEILING = 10

/**
 * The per-command watchdog: the longest a single setup or check command may run before it is
 * killed and treated as a failure, so one hung test command cannot wedge a run. Overridable via
 * env for tests; defaults to 15 minutes, matching the validation loop's.
 */
export function reproductionCommandTimeoutMs(): number {
  const n = Number(process.env.REPRODUCTION_COMMAND_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60_000
}

/**
 * How often the proof feeds the run's inactivity watchdog. Well under the harness's own
 * `JOB_INACTIVITY_MS` (default 10 min) so a slow install-plus-test in each of two worktrees can
 * never look wedged. This is NOT optional: the job-level watchdog is TIGHTER than one command's
 * own ({@link reproductionCommandTimeoutMs}, 15 min), and the harness spawns these itself rather
 * than through the agent, so they emit no activity of their own — without the heartbeat a
 * legitimately slow proof aborts the entire run as "inactivity" and the per-command timeout is
 * unreachable at stock settings.
 */
export function reproductionHeartbeatMs(): number {
  const n = Number(process.env.REPRODUCTION_HEARTBEAT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
}

/**
 * The ceiling on the WHOLE proof phase — every attempt, both trees, setup included. Overridable
 * via env; defaults to 45 minutes.
 *
 * The per-command watchdog bounds one command, not the phase, and the phase multiplies: a spent
 * budget is `maxAttempts` × two trees × (setup + check), each of which may legitimately run for
 * {@link reproductionCommandTimeoutMs}. At stock settings that is hours of container time spent
 * BEFORE the pre-PR validation loop has run its own rounds, and nothing else stops it — the
 * heartbeat deliberately keeps the job-level inactivity watchdog from firing, which is exactly
 * what removes the accidental backstop the phase would otherwise have had.
 *
 * Enforced at PHASE boundaries (before each tree's run, and before each repair round) rather than
 * mid-command: a command already carries its own watchdog, so the real bound is this budget plus
 * at most one command's timeout. Exceeding it settles `inconclusive` with a note saying so —
 * never a run failure, exactly like every other unproven shape.
 */
export function reproductionTotalBudgetMs(): number {
  const n = Number(process.env.REPRODUCTION_TOTAL_BUDGET_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 45 * 60_000
}

/**
 * Parse the job body's `reproduction` envelope, or `undefined` for "no proof on this job".
 *
 * Lenient in exactly one direction: anything malformed yields `undefined`, so the run behaves
 * byte-for-byte as it did before this feature existed. A body that names no command has nothing
 * to run, and inventing one would manufacture a verdict. Test paths are re-checked here even
 * though the engine already sanitized them — this is the harness's own trust boundary, and these
 * paths are handed to `git checkout` against a worktree.
 */
export function parseReproductionSpec(value: unknown): ReproductionSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (command === '') return undefined
  const setupCommand = typeof o.setupCommand === 'string' ? o.setupCommand.trim() : ''
  const declared = Array.isArray(o.testPaths) ? o.testPaths : []
  const testPaths = declared
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter((p) => isSafeTestPath(p))
  const omitted =
    typeof o.omittedTestPaths === 'number' && o.omittedTestPaths > 0
      ? Math.floor(o.omittedTestPaths)
      : 0
  // Anything this parse itself refused is an omission too — the report must not describe a
  // pre-fix tree rebuilt from a shorter list than the one the count claims.
  const droppedHere = declared.length - testPaths.length
  const omittedTestPaths = omitted + Math.max(0, droppedHere)
  const parsedAttempts =
    typeof o.maxAttempts === 'number' && Number.isFinite(o.maxAttempts) && o.maxAttempts > 0
      ? Math.floor(o.maxAttempts)
      : undefined
  return {
    command,
    testPaths,
    ...(omittedTestPaths > 0 ? { omittedTestPaths } : {}),
    ...(setupCommand ? { setupCommand } : {}),
    maxAttempts: Math.min(
      parsedAttempts ?? REPRODUCTION_DEFAULT_MAX_ATTEMPTS,
      REPRODUCTION_MAX_ATTEMPTS_CEILING,
    ),
  }
}

/**
 * A repo-relative path with no traversal, no root/drive anchor, no leading dash, and no git
 * PATHSPEC MAGIC. Must stay in step with the engine's `isSafeTestPath`
 * (`orchestration/src/modules/execution/reproductionProof.logic.ts`) — this is the harness's own
 * trust boundary, not a duplicate of the engine's for its own sake.
 *
 * The magic exclusion is the load-bearing part and is easy to miss: these strings are handed to
 * `git checkout <finalSha> -- <path>`, where `--` stops a path being read as a REVISION but does
 * nothing about pathspec syntax. `:(glob)**`, `*`, `foo/*.ts` are all valid pathspecs, so a
 * model-authored path containing one would apply far more of the final tree onto the pre-fix
 * worktree than the declared reproduction — dragging the fix across and GREENING the base. That
 * lands as an `inconclusive` reading "the check passed before your change", which is the exact
 * false diagnosis this feature exists to remove, and it is under the model's control. A dropped
 * path is counted as an omission, so the report says the pre-fix tree was rebuilt from an
 * incomplete set rather than implying a clean verdict.
 */
function isSafeTestPath(path: string): boolean {
  if (path.length === 0 || path.length > REPRODUCTION_MAX_TEST_PATH_CHARS) return false
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('-')) return false
  // A leading `:` opens pathspec magic (`:(glob)`, `:(exclude)`, `:/`), and the wildcard
  // metacharacters make any path a glob wherever they appear.
  if (path.startsWith(':') || /[*?[\]]/.test(path)) return false
  if (/^[a-zA-Z]:\//.test(path)) return false
  return !path.split('/').includes('..')
}

/**
 * Longest accepted declared test path. A DELIBERATE DUPLICATE of
 * `REPRODUCTION_MAX_TEST_PATH_CHARS` in `@cat-factory/contracts` (the published image takes no
 * schema dependency) — keep the two in step.
 */
const REPRODUCTION_MAX_TEST_PATH_CHARS = 400

/** Everything one proof attempt needs. Every field is per-job; nothing is read from a global. */
export interface ReproductionProofArgs {
  /** The agent's own checkout — the worktrees' parent clone. Never modified by the proof. */
  dir: string
  /** The pre-fix tree: the branch tip captured BEFORE this pass ran (never `HEAD~1`/a base ref). */
  baseSha: string
  /** The tree the pull request will open from (the checkout's HEAD, after committing). */
  finalSha: string
  /** In a monorepo, the service subdirectory the commands run in (relative to each worktree). */
  serviceDirectory?: string
  spec: ReproductionSpec
  attempt: number
  logger: Logger
  opts: RunOptions
  /** Epoch ms after which no further phase may START (see {@link reproductionTotalBudgetMs}). */
  deadlineAt?: number
  /**
   * The files the PRE-FIX tree already changes relative to the PR base branch, or `undefined`
   * when that could not be determined. Consulted ONLY when the base tree comes back green — see
   * {@link priorWorkAtBase} for why a green base is otherwise misdiagnosed.
   */
  listBaseTreeChanges?: () => Promise<string[] | undefined>
}

/** One proof attempt: the report, the full tails for a repair prompt, and whether to repair. */
export interface ReproductionAttempt {
  report: ReproductionReport
  fullTails: Map<string, string>
  /**
   * Whether spending an agent repair round on this outcome can plausibly change it. An explicit
   * OUTPUT of the attempt rather than something re-derived from the report, because the two
   * unrepairable shapes are known only here: a broken environment (the agent cannot change a
   * setup command it did not declare) and a pre-fix tree that already carries this run's own
   * earlier work (nothing is wrong with the test, so "make it exercise the defect" is bad advice).
   */
  repairable: boolean
}

/**
 * Run ONE proof attempt: create both worktrees, run the declared check in each, and compute the
 * verdict from the two exit codes.
 *
 * The base worktree is built at `baseSha` and then has the DECLARED test files checked out of
 * `finalSha` on top — the paths only, never a whole-tree checkout, which would drag the fix across
 * and green the base. In the RESUMED case (a prior `repro-test` step already pushed the failing
 * test onto the shared work branch, so `baseSha` already carries it) that overlay is a no-op by
 * construction. Doing it unconditionally is what guarantees BOTH trees run the byte-identical
 * check, which is the claim the report makes.
 *
 * Keeps the run's inactivity watchdog fed for the whole attempt (see
 * {@link reproductionHeartbeatMs}) and always tears both worktrees down, including on a throw.
 */
export async function runReproductionProof(
  args: ReproductionProofArgs,
): Promise<ReproductionAttempt> {
  const { dir, baseSha, finalSha, serviceDirectory, spec, attempt, logger, opts, deadlineAt } = args
  const fullTails = new Map<string, string>()
  const heartbeat = setInterval(() => opts.onActivity?.(), reproductionHeartbeatMs())
  heartbeat.unref?.()
  // A per-job temp root: two concurrent jobs on the ONE local-native host process get disjoint
  // worktree paths, so neither can see (or clobber) the other's base tree.
  const root = await mkdtemp(join(tmpdir(), 'cat-repro-'))
  const baseDir = join(root, 'base')
  const finalDir = join(root, 'final')
  /** Every return below is one of these — the invariant fields are stated once. */
  const settle = (
    fields: Partial<ReproductionReport>,
    repairable: boolean,
  ): ReproductionAttempt => ({
    report: {
      status: 'inconclusive',
      command: spec.command,
      testPaths: [...spec.testPaths],
      ...(spec.omittedTestPaths ? { omittedTestPaths: spec.omittedTestPaths } : {}),
      attempts: attempt,
      maxAttempts: spec.maxAttempts,
      ...fields,
      at: Date.now(),
    },
    fullTails,
    repairable,
  })
  try {
    // The proof runs against COMMITTED trees, so a declared test the agent never `git add`ed is
    // invisible to it — and equally invisible to the push, which is the more important half to
    // tell the agent about. Report that rather than a verdict computed without the reproduction.
    const present = await pathsPresentAtCommit(dir, finalSha, spec.testPaths, opts.signal)
    const missing = spec.testPaths.filter((p) => !present.includes(p))
    if (spec.testPaths.length > 0 && present.length === 0) {
      logger.warn('reproduction: no declared test file is committed', { missing })
      return settle(
        {
          note: `None of the declared reproduction test files are committed on the branch (${missing.join(', ')}), so the pre-fix tree could not be reconstructed.`,
        },
        true,
      )
    }
    if (budgetSpent(deadlineAt)) return settle({ note: BUDGET_NOTE }, false)

    await addWorktree(dir, baseDir, baseSha, opts.signal)
    await checkoutPathsFrom(baseDir, finalSha, present, opts.signal)
    logger.info('reproduction: base worktree ready', {
      attempt,
      appliedTestPaths: present.length,
      missingTestPaths: missing.length,
    })
    const baseRun = await runPhase({
      phase: 'base',
      worktree: baseDir,
      ...(serviceDirectory ? { serviceDirectory } : {}),
      spec,
      logger,
      opts,
    })
    const base = baseRun.outcome
    if (baseRun.fullTail) fullTails.set('base', baseRun.fullTail)

    // A green base settles it: `reproduced` requires a RED base, so running the final tree could
    // only confirm what is already not proof — and each phase costs a full setup + test run. The
    // report's `final` is documented as absent in exactly this case.
    if (base.passed || base.setupFailed) {
      // A GREEN base is the one outcome whose meaning depends on what the pre-fix tree actually
      // is, so establish that before naming a cause — see {@link priorWorkAtBase}.
      const priorWork = base.passed ? await priorWorkAtBase(args, logger) : undefined
      return settle(
        { base, note: noteFor(base, undefined, missing, priorWork) },
        // A setup failure and a base that already carries the fix are both unrepairable, for the
        // same underlying reason: the agent is not what is wrong, so a repair round can only make
        // things worse (here, by inviting it to weaken a reproduction test that is fine).
        !base.setupFailed && !priorWork?.length,
      )
    }
    if (budgetSpent(deadlineAt)) return settle({ base, note: BUDGET_NOTE }, false)

    await addWorktree(dir, finalDir, finalSha, opts.signal)
    const finalRun = await runPhase({
      phase: 'final',
      worktree: finalDir,
      ...(serviceDirectory ? { serviceDirectory } : {}),
      spec,
      logger,
      opts,
    })
    const final = finalRun.outcome
    if (finalRun.fullTail) fullTails.set('final', finalRun.fullTail)
    const reproduced = final.passed && !final.setupFailed
    return {
      report: {
        status: reproduced ? 'reproduced' : 'inconclusive',
        command: spec.command,
        testPaths: [...spec.testPaths],
        ...(spec.omittedTestPaths ? { omittedTestPaths: spec.omittedTestPaths } : {}),
        base,
        final,
        attempts: attempt,
        maxAttempts: spec.maxAttempts,
        ...(reproduced && missing.length === 0
          ? {}
          : { note: noteFor(base, final, missing, undefined) }),
        at: Date.now(),
      },
      fullTails,
      // A timed-out or un-runnable FINAL tree is not something a repair pass fixes: the agent is
      // handed a watchdog kill or a broken environment, not a failing assertion it can act on,
      // and each round costs another two full tree runs to learn the same thing.
      repairable: !reproduced && !final.setupFailed && !final.timedOut && !base.timedOut,
    }
  } finally {
    clearInterval(heartbeat)
    // Teardown is best-effort throughout: a proof that ran must never be lost to a failed rmdir.
    await removeWorktree(dir, baseDir, opts.signal)
    await removeWorktree(dir, finalDir, opts.signal)
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** Whether the whole-phase budget is spent (see {@link reproductionTotalBudgetMs}). */
function budgetSpent(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt
}

const BUDGET_NOTE =
  'The reproduction proof ran out of its time budget before it could finish, so no verdict was reached. This is a cost limit, not a statement about the fix.'

/**
 * The non-test changes the PRE-FIX tree already carries relative to the PR base branch, when that
 * can be determined (`undefined` when it cannot, and only ever consulted for a GREEN base).
 *
 * This is what makes a green base interpretable. The pre-fix tree is `baseSha` — the work branch
 * as it stood when this pass STARTED — which in the designed bugfix flow is the reproduction
 * step's test commit and nothing else, so green there genuinely means "the test does not
 * demonstrate the defect". But a coder container that is evicted mid-run has already committed
 * and checkpoint-pushed its work, and the re-dispatch RESUMES that branch: `baseSha` then carries
 * this same step's own partial fix, the check legitimately passes on it, and the old diagnosis
 * stated as fact that the agent's test was worthless — then spent the whole repair budget telling
 * it to "make the test actually exercise the defect", which invites weakening a perfectly good
 * reproduction. Non-test changes at the base are the signal that separates the two.
 *
 * Best-effort by construction: the probe needs the base branch and a reachable merge base, and a
 * fresh clone is shallow. An unavailable answer degrades to the original diagnosis rather than
 * suppressing one.
 */
async function priorWorkAtBase(
  args: ReproductionProofArgs,
  logger: Logger,
): Promise<string[] | undefined> {
  if (!args.listBaseTreeChanges) return undefined
  let changed: string[] | undefined
  try {
    changed = await args.listBaseTreeChanges()
  } catch (error) {
    logger.warn('reproduction: could not inspect the pre-fix tree’s provenance', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  if (!changed) return undefined
  const declared = new Set(args.spec.testPaths)
  const priorWork = changed.filter((p) => !declared.has(p))
  if (priorWork.length > 0) {
    logger.info('reproduction: the pre-fix tree already carries non-test work', {
      count: priorWork.length,
      files: priorWork.slice(0, 10),
    })
  }
  return priorWork
}

/**
 * One line naming the shape that was observed, for the report and the step card. Every
 * non-`reproduced` outcome gets one: a bare `inconclusive` with no explanation is indistinguishable
 * from a rendering bug, which is how "nobody tried" creeps back in through the door this feature
 * closed.
 *
 * `priorWork` (see {@link priorWorkAtBase}) is what stops the green-base line asserting a cause it
 * cannot know. Nothing here ever states more than was measured.
 */
function noteFor(
  base: ReproductionPhaseOutcome,
  final: ReproductionPhaseOutcome | undefined,
  missing: readonly string[],
  priorWork: readonly string[] | undefined,
): string {
  const incomplete = missing.length
    ? ` Declared test file(s) not committed on the branch and therefore not part of the check: ${missing.join(', ')}.`
    : ''
  if (base.setupFailed) {
    return `The setup command failed in the pre-fix worktree (exit ${base.exitCode}), so neither tree could be checked. This is an environment problem, not a verdict about the fix.${incomplete}`
  }
  if (base.passed) {
    if (priorWork?.length) {
      const shown = priorWork.slice(0, 5).join(', ')
      const more = priorWork.length > 5 ? `, +${priorWork.length - 5} more` : ''
      return `The declared check PASSED on the pre-fix tree, but that tree ALREADY carries non-test work committed on this branch (${shown}${more}) — most likely an earlier, interrupted pass of this same step. So this says nothing about whether the test demonstrates the defect, and no fix-free tree was available to check it against.${incomplete}`
    }
    return `The declared check PASSED on the pre-fix tree, so it does not demonstrate the defect.${incomplete}`
  }
  if (!final) {
    return `The pre-fix tree was red but the final tree was never checked.${incomplete}`
  }
  if (final.setupFailed) {
    return `The pre-fix tree was red (exit ${base.exitCode}), but the setup command failed in the final worktree (exit ${final.exitCode}), so the fix could not be checked.${incomplete}`
  }
  if (!final.passed) {
    // Identical failures on two trees that differ only by the fix are far more often one
    // environment failing both ways — a missing toolchain, an absent dependency, a collection
    // error — than a fix that does nothing. Say which reading the evidence favours instead of
    // offering both with equal weight and leaving the reviewer to guess.
    if (base.timedOut && final.timedOut) {
      return `The declared check TIMED OUT on both the pre-fix tree and the final tree, so neither run reached a verdict. The command is too slow for the proof's watchdog, or it hangs — either way this says nothing about the fix.${incomplete}`
    }
    const identical = base.exitCode === final.exitCode
    const reading = identical
      ? `Both trees failed the SAME way (exit ${base.exitCode}), which usually means the check never ran meaningfully in either — a missing dependency or setup step — rather than that the fix does nothing.`
      : 'The change does not make the check pass.'
    return `The declared check FAILED on both the pre-fix tree (exit ${base.exitCode}) and the final tree (exit ${final.exitCode}). ${reading}${incomplete}`
  }
  return `The reproduction was demonstrated (red at the pre-fix tree, green at the final tree).${incomplete}`
}

/**
 * Run one tree's phase: the optional setup command, then the declared check, both in the
 * worktree (offset by the monorepo service directory when the run has one).
 *
 * A failed setup short-circuits the check and is flagged `setupFailed`, so a broken environment is
 * reported as such instead of masquerading as a red tree. The setup command runs in BOTH
 * worktrees or neither — an asymmetric setup is exactly how a false `reproduced` is manufactured.
 */
async function runPhase(args: {
  phase: 'base' | 'final'
  worktree: string
  serviceDirectory?: string
  spec: ReproductionSpec
  logger: Logger
  opts: RunOptions
}): Promise<{ outcome: ReproductionPhaseOutcome; fullTail?: string }> {
  const { phase, worktree, serviceDirectory, spec, logger, opts } = args
  const cwd = serviceDirectory ? join(worktree, serviceDirectory) : worktree
  if (spec.setupCommand) {
    logger.info('reproduction: running setup', { phase })
    const setup = await runOneCommand(cwd, spec.setupCommand, phase, logger, opts)
    if (!setup.outcome.passed) {
      logger.warn('reproduction: setup failed', { phase, exitCode: setup.outcome.exitCode })
      return {
        outcome: { ...setup.outcome, setupFailed: true },
        ...(setup.fullTail ? { fullTail: setup.fullTail } : {}),
      }
    }
  }
  logger.info('reproduction: running declared check', { phase })
  const check = await runOneCommand(cwd, spec.command, phase, logger, opts)
  logger.info('reproduction: phase finished', { phase, exitCode: check.outcome.exitCode })
  return { outcome: check.outcome, ...(check.fullTail ? { fullTail: check.fullTail } : {}) }
}

/**
 * Run ONE of the phase's commands through the shared {@link runCapturedCommand} seam and shape it
 * as a phase outcome. The exit code is the verdict — computed by the harness, never self-reported
 * by the model, which is what this whole feature replaces.
 */
async function runOneCommand(
  cwd: string,
  command: string,
  phase: 'base' | 'final',
  logger: Logger,
  opts: RunOptions,
): Promise<{ outcome: ReproductionPhaseOutcome; fullTail?: string }> {
  const { fullTail, ...run } = await runCapturedCommand({
    cwd,
    command,
    timeoutMs: reproductionCommandTimeoutMs(),
    reportTailChars: REPRODUCTION_REPORT_TAIL_CHARS,
    logLabel: 'reproduction',
    logFields: { phase },
    logger,
    opts,
  })
  return { outcome: run, ...(fullTail ? { fullTail } : {}) }
}

/**
 * The repair instruction handed to the agent after a failed verification: which tree behaved how,
 * the captured output, and an explicit statement of the exit condition. The FULL captured tail is
 * used here (not the report's smaller bound) — the agent needs the whole failure to act on it, and
 * this text never leaves the container.
 *
 * Deliberately prescriptive about scope, for the same reason the validation loop's prompt is: a
 * loop that lets the agent "succeed" by weakening the reproduction is worse than no loop at all,
 * because it launders an unverified claim into a captured "fact" — the exact failure mode this
 * whole feature exists to remove.
 */
export function buildReproductionRepairPrompt(
  report: ReproductionReport,
  fullTails: Map<string, string>,
  /**
   * New files the agent created but never `git add`ed, if the caller can tell. The proof runs
   * against COMMITTED trees, so an unadded reproduction test is invisible to it — and to the push.
   */
  untrackedFiles: string[] = [],
): string {
  const remaining = report.maxAttempts - report.attempts
  const diagnosis = report.base?.setupFailed
    ? 'The setup command failed before either tree could be checked.'
    : !report.base
      ? 'The reproduction test files are not committed, so the pre-fix tree could not be reconstructed.'
      : report.base.passed
        ? 'The check PASSED on the pre-fix tree — the code WITHOUT your change. A test that passes before the fix does not demonstrate the bug, so it proves nothing about what you changed.'
        : report.final && !report.final.passed
          ? 'The check FAILED on the pre-fix tree (good — it demonstrates the bug) but ALSO on the final tree, which includes your change. Your fix does not make the reproduction pass.'
          : 'The reproduction could not be demonstrated.'
  const blocks = (['base', 'final'] as const)
    .map((phase) => {
      const outcome = phase === 'base' ? report.base : report.final
      if (!outcome) return ''
      const body = fullTails.get(phase) ?? outcome.outputTail ?? '(no output captured)'
      const label =
        phase === 'base' ? 'Pre-fix tree (without your change)' : 'Final tree (with your change)'
      const reason = outcome.timedOut
        ? `timed out after ${Math.round((outcome.durationMs ?? 0) / 1000)}s`
        : `exited ${outcome.exitCode}`
      return `### ${label} — ${reason}\n\n\`\`\`\n$ ${report.command}\n${body}\n\`\`\``
    })
    .filter((b) => b !== '')
    .join('\n\n')
  const untracked = untrackedFiles.length
    ? [
        '',
        '## Uncommitted new files',
        '',
        'These files exist in your checkout but were never added to git, so they are not on the',
        'branch — and the reproduction is checked against committed trees, so they took no part in',
        'it. `git add` each one you meant to keep (or delete it):',
        '',
        ...untrackedFiles.map((f) => `- ${f}`),
      ]
    : []
  return [
    'Your change is being checked for REPRODUCTION PROOF: the declared reproduction command is run',
    'against the tree WITHOUT your change and again against the tree WITH it. It has to fail on the',
    'first and pass on the second. It did not.',
    '',
    diagnosis,
    '',
    ...(blocks ? [blocks, ''] : []),
    ...untracked,
    '',
    '## How this is judged',
    '',
    `The command \`${report.command}\` is re-run against both trees when you stop. The proof succeeds`,
    'only when it fails without your change and passes with it. You have',
    `${remaining} attempt(s) left; after that the pull request still opens, but it will state that the`,
    'reproduction could not be demonstrated.',
    '',
    '## Rules',
    '',
    '- Do NOT weaken, skip, delete, or relax the reproduction test to make this pass. A proof',
    '  obtained that way is a failed task — it is precisely the unverified claim this check exists',
    '  to catch.',
    '- If the test passes without your change, make it actually exercise the defect: assert on the',
    '  buggy behaviour itself, not on something incidental.',
    '- If the test fails with your change too, fix the underlying defect rather than the test.',
    '- Do not revert your earlier work; build on it.',
    '- Commit your work, and `git add` any NEW file you create — only changes to files already',
    '  tracked by git are staged for you.',
  ].join('\n')
}

/**
 * The reproduction-proof LOOP: verify, and while the verification fails, is repairable and budget
 * remains, hand the captured output back to the agent as its next instruction and verify again.
 * Returns the LAST attempt's report.
 *
 * A failed verification is a REPAIR, never a run failure (the initiative's D6). Exhausting the
 * budget degrades to `inconclusive` and the caller opens the pull request anyway — deliberately a
 * different disposition from the pre-PR validation loop, which opens nothing. A red validation
 * check means the WORK is broken, so refusing the PR is right; a reproduction that could not be
 * demonstrated means the EVIDENCE is weak, which is a reviewer's call, not a machine's, and
 * failing the run would throw away a fix that may well be correct. The report says plainly what
 * was and was not proven.
 *
 * Every settled attempt — including the ones that never ran a tree — is published on the job view
 * (a fresh `at` per publish, which the engine's change detection relies on), so the loop is
 * observable while it runs; `onAgentPass` lets the caller fold each repair pass's
 * stats/usage/telemetry into the run's totals.
 *
 * The loop is bounded twice over: by `maxAttempts` rounds, and by the wall-clock
 * {@link reproductionTotalBudgetMs} — attempts multiply two full tree runs each, and the phase's
 * own heartbeat deliberately stops the job-level inactivity watchdog from ever cutting it short.
 */
export async function runReproductionLoop<TRun>(args: {
  dir: string
  baseSha: string
  /** Re-read before every attempt: a repair pass commits, so the final tree moves. */
  resolveFinalSha: () => Promise<string>
  serviceDirectory?: string
  spec: ReproductionSpec
  logger: Logger
  opts: RunOptions
  runAgentPass: (userPrompt: string) => Promise<TRun>
  onAgentPass?: (run: TRun) => void
  /** The new files left uncommitted in the checkout, folded into each repair prompt. */
  listUncommittedNewFiles?: () => Promise<string[]>
  /**
   * The files the PRE-FIX tree already changes relative to the PR base branch (see
   * `priorWorkAtBase`). Invariant across attempts — `baseSha` never moves — so it is resolved at
   * most once and memoised here rather than re-probed per round.
   */
  listBaseTreeChanges?: () => Promise<string[] | undefined>
}): Promise<ReproductionReport> {
  const { dir, baseSha, resolveFinalSha, serviceDirectory, spec, logger, opts } = args
  const deadlineAt = Date.now() + reproductionTotalBudgetMs()
  const listBaseTreeChanges = memoiseBaseTreeChanges(args.listBaseTreeChanges)
  let attempt = 1
  for (;;) {
    const finalSha = await resolveFinalSha()
    // A tree that never moved has nothing to prove: the "final" tree IS the pre-fix tree, so the
    // check would necessarily agree with itself and the verdict would be meaningless.
    if (finalSha === baseSha) {
      logger.info('reproduction: final tree equals the pre-fix tree — nothing to verify', {
        attempt,
      })
      const report: ReproductionReport = {
        status: 'inconclusive',
        command: spec.command,
        testPaths: [...spec.testPaths],
        ...(spec.omittedTestPaths ? { omittedTestPaths: spec.omittedTestPaths } : {}),
        attempts: attempt,
        maxAttempts: spec.maxAttempts,
        note: 'The branch carries no commit beyond the pre-fix tree, so there was no change to verify a reproduction against.',
        at: Date.now(),
      }
      // Published like every other settled attempt: a verdict that reaches the step only in the
      // terminal result is invisible for as long as the job keeps running, and "the step shows no
      // reproduction section" is exactly what a reader cannot distinguish from "it never ran".
      opts.onReproductionProof?.(report)
      return report
    }
    const { report, fullTails, repairable } = await runReproductionProof({
      dir,
      baseSha,
      finalSha,
      ...(serviceDirectory ? { serviceDirectory } : {}),
      spec,
      attempt,
      logger,
      opts,
      deadlineAt,
      ...(listBaseTreeChanges ? { listBaseTreeChanges } : {}),
    })
    opts.onReproductionProof?.(report)
    if (report.status === 'reproduced') {
      logger.info('reproduction: proved', { attempt })
      return report
    }
    if (!repairable) {
      logger.warn('reproduction: not repairable by the agent — settling', {
        attempt,
        note: report.note,
      })
      return report
    }
    if (attempt >= spec.maxAttempts) {
      logger.warn('reproduction: attempt budget spent — recording inconclusive', {
        attempt,
        maxAttempts: spec.maxAttempts,
      })
      return report
    }
    if (budgetSpent(deadlineAt)) {
      logger.warn('reproduction: time budget spent — recording inconclusive', { attempt })
      return { ...report, note: `${report.note ? `${report.note} ` : ''}${BUDGET_NOTE}` }
    }
    attempt += 1
    logger.info('reproduction: repairing', { nextAttempt: attempt })
    opts.onPhase?.('reproduction-repair')
    const untracked = await safeListUncommitted(args.listUncommittedNewFiles, logger)
    const run = await args.runAgentPass(buildReproductionRepairPrompt(report, fullTails, untracked))
    args.onAgentPass?.(run)
    opts.onPhase?.('agent')
  }
}

/**
 * Memoise the pre-fix tree's provenance probe across a loop's attempts. It costs a fetch of the
 * base branch and answers a question about `baseSha`, which never moves — so re-running it each
 * round would be one network round-trip per attempt for an answer that cannot have changed.
 */
function memoiseBaseTreeChanges(
  probe: (() => Promise<string[] | undefined>) | undefined,
): (() => Promise<string[] | undefined>) | undefined {
  if (!probe) return undefined
  let pending: Promise<string[] | undefined> | undefined
  return () => (pending ??= probe())
}

/**
 * The uncommitted-new-file list for a repair prompt, never throwing: an ADVISORY addition to the
 * instruction must degrade to "no warning" rather than failing a loop that is otherwise working.
 */
async function safeListUncommitted(
  list: (() => Promise<string[]>) | undefined,
  logger: Logger,
): Promise<string[]> {
  if (!list) return []
  try {
    return await list()
  } catch (error) {
    logger.warn('reproduction: could not list uncommitted new files', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
