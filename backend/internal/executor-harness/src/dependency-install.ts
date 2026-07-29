import { runCapturedCommand } from './captured-command.js'
import type { RunOptions } from './runner.js'
import type { Logger } from './logger.js'

// DEPENDENCY PREPOPULATION — the pre-agent install phase (see
// docs/initiatives/agent-dependency-prepopulation.md).
//
// A repo-aware agent that opens a fresh clone sees manifests, not dependencies: it can read that
// a library is depended upon but not what that library actually exposes, so it guesses at APIs,
// re-derives type shapes, or declines work it could have done. This module runs the service's
// declared install against the checkout BEFORE the agent's first turn, and tells the agent what
// happened either way.
//
// Three properties are load-bearing, and each has cost the platform a run when it was missing
// somewhere else:
//
//  - BEST-EFFORT, NEVER A GATE. A private registry the deployment has no token for, a toolchain
//    the image lacks, a network hiccup — none of those are the agent's fault or the run's. A
//    failed install produces a NOTE the agent reads (and can act on: it may install what it
//    needs itself) rather than a dead run. This is the opposite disposition from the pre-PR
//    validation loop, which is a gate on purpose: an install is setup, a check is a verdict.
//  - HEARTBEAT. A cold `pnpm install` is exactly the activity-SILENT phase the job inactivity
//    watchdog (`JOB_INACTIVITY_MS`, default 10 min) was never meant to judge, and the harness
//    spawns it itself so it emits no agent activity. Without the heartbeat a healthy install
//    aborts the run as "likely hung" — the same trap `frontend-infra.ts` and `validation-checks.ts`
//    each had to answer.
//  - PER-JOB BY CONSTRUCTION. The command, the cwd and the environment all arrive as arguments;
//    nothing is read from or written to `process.env`/`HOME`. The local NATIVE transport serves
//    every concurrent job from ONE host process, so a global would leak one job's install into a
//    sibling's checkout and the container path would never catch it.

/** The dependency-install phase as it arrives on the job body. */
export interface DependencyInstallSpec {
  /** The shell command, run as `sh -c` in the checkout (the service directory for a monorepo). */
  command: string
}

/** What the install did — folded into the agent's prompt, never a verdict about the run. */
export interface DependencyInstallOutcome {
  command: string
  exitCode: number
  passed: boolean
  /** Scrubbed, bounded tail of the combined output. Only kept for a FAILED install. */
  outputTail?: string
  durationMs: number
  timedOut?: boolean
}

/**
 * How much of a failed install's output the agent is shown. Smaller than the validation loop's
 * repair budget (16k) on purpose: a repair prompt has to carry the whole failure because fixing
 * it IS the task, whereas this note only has to let the agent decide whether to install
 * something itself. The tail is where a package manager puts its actual error.
 */
export const DEPENDENCY_INSTALL_TAIL_CHARS = 4_000

/**
 * The per-install watchdog: the longest the install may run before it is killed and reported as
 * failed, so one wedged package manager cannot hold a container for the whole run. Generous
 * (20 min) because a cold monorepo install on a slow registry legitimately takes many minutes —
 * and unlike a validation check, nothing downstream is blocked on it finishing quickly.
 * Overridable via env for tests, like the validation loop's knobs.
 */
export function dependencyInstallTimeoutMs(): number {
  const n = Number(process.env.DEPENDENCY_INSTALL_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 60_000
}

/**
 * How often the install feeds the run's inactivity watchdog. Well under `JOB_INACTIVITY_MS`
 * (default 10 min); matches the validation loop's and the frontend stand-up's heartbeat, which
 * exist for exactly the same reason.
 */
export function dependencyInstallHeartbeatMs(): number {
  const n = Number(process.env.DEPENDENCY_INSTALL_HEARTBEAT_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000
}

/**
 * Parse the optional DEPENDENCY INSTALL envelope off the job body. A missing/blank command
 * returns `undefined`, so a malformed body degrades to the exact pre-feature behaviour (no
 * install phase, the agent starts against the bare clone) rather than failing a good run.
 *
 * Lives with the feature rather than in `job.ts`, following the same rule the two pre-PR
 * verification phases do: each phase owns its own job-body parser next to the code that consumes
 * it, and `job.ts` stays the job SHAPE plus the generic assembly.
 */
export function parseDependencyInstallSpec(value: unknown): DependencyInstallSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>).command
  const command = typeof raw === 'string' ? raw.trim() : ''
  return command ? { command } : undefined
}

/**
 * Run the declared install against `cwd` and return what happened. Never throws and never fails
 * the job: every failure shape ({@link runCapturedCommand} maps a timeout to 124, a spawn error
 * to 127, an abort to 130) comes back as a non-zero outcome the caller turns into a prompt note.
 *
 * The output tail is kept ONLY for a failure. A successful install prints tens of thousands of
 * uninteresting lines, and the agent needs to know that it succeeded, not what it resolved.
 */
export async function runDependencyInstall(args: {
  cwd: string
  spec: DependencyInstallSpec
  logger: Logger
  opts: RunOptions
}): Promise<DependencyInstallOutcome> {
  const { cwd, spec, logger, opts } = args
  logger.info('dependencies: installing', { command: spec.command })
  const heartbeat = setInterval(() => opts.onActivity?.(), dependencyInstallHeartbeatMs())
  heartbeat.unref?.()
  try {
    const run = await runCapturedCommand({
      cwd,
      command: spec.command,
      timeoutMs: dependencyInstallTimeoutMs(),
      reportTailChars: DEPENDENCY_INSTALL_TAIL_CHARS,
      logLabel: 'dependencies',
      logger,
      opts,
    })
    logger.info('dependencies: install finished', {
      exitCode: run.exitCode,
      durationMs: run.durationMs,
    })
    return {
      command: spec.command,
      exitCode: run.exitCode,
      passed: run.passed,
      ...(run.passed ? {} : run.outputTail ? { outputTail: run.outputTail } : {}),
      durationMs: run.durationMs,
      ...(run.timedOut ? { timedOut: true } : {}),
    }
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * The note folded into the agent's prompt describing the checkout it is about to work in.
 *
 * Stated in BOTH directions on purpose. On success the agent is told the tree is ready, which is
 * what stops it spending turns re-running an install that already ran (and, on a repo whose
 * install is slow, spending most of its budget there). On failure it is told plainly what failed
 * and that it may install what it needs itself — an agent that merely finds no `node_modules` and
 * no explanation concludes the environment is offline and works around a gap that isn't there.
 *
 * `scope` names the checkout the install ran in and is set ONLY when that is not the agent's own
 * working directory — the multi-repo layout runs the agent at the workspace root while the install
 * belongs to the primary service's sibling directory. Saying "this checkout" there would point the
 * agent at a root that has no dependency tree of its own.
 */
export function buildDependencyInstallNote(
  outcome: DependencyInstallOutcome,
  scope?: string,
): string {
  const subject = scope ? `The \`${scope}/\` checkout's` : "This checkout's"
  if (outcome.passed) {
    return [
      `${subject} dependencies have already been installed for you (\`${outcome.command}\`), so the`,
      'installed packages are present on disk. Read them directly to confirm what a dependency',
      'actually exposes rather than inferring its API from the manifest, and do NOT re-run the',
      'install unless you change the dependency manifest.',
    ].join('\n')
  }
  const reason = outcome.timedOut
    ? `timed out after ${Math.round(outcome.durationMs / 1000)}s`
    : `exited ${outcome.exitCode}`
  return [
    `${subject} dependencies could NOT be installed for you: \`${outcome.command}\` ${reason}.`,
    'The installed packages are therefore missing or incomplete. You have network access, so you',
    'may install what you need yourself if it helps — but treat the failure below as a fact about',
    'the environment, not as a defect to fix as part of this task, and do not change the project’s',
    'dependency manifests to work around it.',
    ...(outcome.outputTail ? ['', '```', outcome.outputTail, '```'] : []),
  ].join('\n')
}
