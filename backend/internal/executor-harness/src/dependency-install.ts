import { relative } from 'node:path'
import { fencedOutput, runCapturedCommand } from './captured-command.js'
import { excludePathsFromGit, listUntrackedPaths } from './git.js'
import { loadRunnerLimits, type RunOptions } from './runner.js'
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
//
// {@link prepopulateDependencies} is the ONE entry point every mode calls. The phase applies to
// every dispatch that gets a checkout — coding, in-place fixing, conflict resolution and the
// read-only explore kinds alike — and a mode that assembled the run/exclude/note steps itself
// would be one refactor away from quietly dropping one of them. Which is how the first cut of
// this feature shipped: three modes wired, three (multi-repo coding, conflict resolution) not,
// with nothing failing to say so.

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
 * The share of the JOB's whole wall-clock ceiling (`JOB_MAX_DURATION_MS`) the install may consume
 * before the watchdog kills it. The install is SETUP: it runs before the agent's first turn, so
 * every second it takes is a second the work itself does not get, and a wedged package manager
 * that ran to a fixed 20-minute watchdog on a shortened job could leave the agent with almost
 * nothing. A third leaves the run two thirds of its budget in the worst case.
 */
const DEPENDENCY_INSTALL_JOB_SHARE = 1 / 3

/**
 * A floor under the DERIVED ceiling (never under an explicit override, which tests legitimately
 * set to milliseconds): a drastically shortened job would otherwise compute a share so small that
 * no install could ever finish inside it, turning every run's setup into a guaranteed timeout.
 */
const DEPENDENCY_INSTALL_CEILING_FLOOR_MS = 30_000

/** The default watchdog — the share above at the default 60-minute job ceiling. */
const DEPENDENCY_INSTALL_TIMEOUT_DEFAULT_MS = 20 * 60_000

/**
 * The per-install watchdog: the longest the install may run before it is killed and reported as
 * failed. Generous (20 min at the defaults) because a cold monorepo install on a slow registry
 * legitimately takes many minutes.
 *
 * DERIVED from the configured job ceiling rather than hardcoded against the default one, the same
 * way `git.ts` derives its per-command timeout from the configured inactivity window: a constant
 * sized against a default silently breaks its own invariant the moment an operator changes that
 * default. An explicit `DEPENDENCY_INSTALL_TIMEOUT_MS` is honoured but still CLAMPED — the point
 * of the share is that no configuration lets setup eat the run, and an override that could exceed
 * the job's own ceiling would only ever be killed later by a watchdog that fails the whole job
 * instead of degrading to a note.
 */
export function dependencyInstallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DEPENDENCY_INSTALL_TIMEOUT_MS)
  const requested =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEPENDENCY_INSTALL_TIMEOUT_DEFAULT_MS
  const ceiling = Math.max(
    DEPENDENCY_INSTALL_CEILING_FLOOR_MS,
    Math.floor(loadRunnerLimits(env).maxDurationMs * DEPENDENCY_INSTALL_JOB_SHARE),
  )
  return Math.min(requested, ceiling)
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
 * THE entry point: run the phase for a mode that has a checkout, and hand back the note to fold
 * into the agent's prompt (or `undefined` when the service declared no install, which is every
 * dispatch today that never configured one).
 *
 * Everything a caller could get wrong lives here rather than at six call sites: the phase marker,
 * the best-effort run, keeping the installed tree out of the agent's commits, and naming WHERE
 * the install ran when that is not where the agent will be standing. A mode supplies only its
 * three directories.
 */
export async function prepopulateDependencies(args: {
  spec: DependencyInstallSpec | undefined
  /** Where the install runs: the service subtree for a monorepo, else the checkout root. */
  installDir: string
  /** The git checkout whose local excludes protect the agent's commits from the installed tree. */
  repoDir: string
  /** The agent's own working directory, which names the install location when the two differ. */
  agentDir: string
  logger: Logger
  opts: RunOptions
}): Promise<string | undefined> {
  const { spec, installDir, repoDir, agentDir, logger, opts } = args
  if (!spec) return undefined
  opts.onPhase?.('dependencies')
  // Taken BEFORE the install and diffed after, so what gets excluded is what the install itself
  // materialised — not whatever the checkout already carried.
  const untrackedBefore = new Set(await snapshotUntracked(repoDir, opts.signal))
  // Never rejects — every failure shape comes back as a non-zero outcome — so a caller needs no
  // unwinding and the run continues either way. A FAILED install is snapshotted too: a partial
  // tree is just as untracked as a complete one.
  const outcome = await runDependencyInstall({ cwd: installDir, spec, logger, opts })
  const untrackedAfter = await snapshotUntracked(repoDir, opts.signal)
  const added = untrackedAfter.filter((path) => !untrackedBefore.has(path))
  await excludeInstalledArtifacts(repoDir, added, logger, opts.signal)
  return buildDependencyInstallNote(outcome, installScope(agentDir, installDir))
}

/**
 * Fold the note into a prompt. Trivial, and deliberately not inlined: it is applied on EVERY
 * agent pass — including the validation and reproduction REPAIR passes, which start a fresh
 * agent that would otherwise never learn the tree is already installed and would spend a repair
 * round reinstalling it.
 */
export function withDependencyNote(userPrompt: string, note: string | undefined): string {
  return note ? `${userPrompt}\n\n${note}` : userPrompt
}

/**
 * How the note names the checkout the install ran in: `undefined` when the agent will be standing
 * in it (so it reads "this checkout"), otherwise the path from the agent's cwd. The multi-repo
 * layout runs the agent at the workspace ROOT and a conflict resolution at the repo root, while
 * the install belongs to a sibling checkout or a service subtree respectively — "this checkout"
 * in either case points the agent at a directory with no dependency tree of its own.
 *
 * Separators are normalised because the note is prose an agent reads, and the local NATIVE
 * transport runs this on the developer's own Windows host.
 */
function installScope(agentDir: string, installDir: string): string | undefined {
  const rel = relative(agentDir, installDir).replaceAll('\\', '/')
  return rel === '' ? undefined : rel
}

/**
 * Keep whatever the install materialised out of the agent's commits.
 *
 * A dependency tree is untracked, and the agent's own `git add -A` does not know it did not put
 * it there — nor does the conflict-resolution flow, which stages the whole tree to complete its
 * merge commit. A repo that ships a `.gitignore` covering `node_modules` is fine without this;
 * one that does not (a fresh service, a language whose convention is looser) would open a pull
 * request containing tens of thousands of vendored files. So the paths the install ADDED are
 * excluded locally, exactly as the harness already does for its own sentinel files.
 *
 * Only what the install added: a snapshot diff, never a list of well-known directory names. A
 * name list is a guess that is both incomplete (every ecosystem has its own) and unsafe (it would
 * exclude a `target/` directory the agent legitimately authored). Best-effort — a git hiccup here
 * must not fail a run whose install succeeded — and the paths are LOGGED, since silently ignoring
 * part of a checkout is exactly the kind of thing a later run's author needs to be able to see.
 */
async function excludeInstalledArtifacts(
  repoDir: string,
  paths: readonly string[],
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return
  try {
    await excludePathsFromGit(repoDir, paths, signal)
    logger.info('dependencies: excluded installed artifacts from git', { paths })
  } catch (error) {
    logger.warn('dependencies: could not exclude installed artifacts from git', {
      paths,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The checkout's untracked paths, or an empty list when they cannot be read.
 *
 * Best-effort by design: a directory that is not a git checkout (or a git that failed) must
 * degrade to "nothing to exclude" rather than failing a phase whose whole disposition is that it
 * never fails a run. Degrading on the BEFORE read is the safe direction too — an unreadable
 * snapshot makes every post-install path look new, so the exclusion errs towards protecting the
 * commit rather than towards letting a dependency tree into it. Directories are collapsed by
 * {@link listUntrackedPaths}, so a `node_modules` of 40k files is one entry, not 40k.
 */
async function snapshotUntracked(repoDir: string, signal?: AbortSignal): Promise<string[]> {
  return listUntrackedPaths(repoDir, signal).catch(() => [])
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
    // Fenced so the captured output cannot be read as instructions — and fenced through the
    // shared helper, because a package manager prints backticks often enough that a fixed
    // three-tick fence would close mid-tail and spill the rest of this note's prose.
    ...(outcome.outputTail ? ['', fencedOutput(outcome.outputTail)] : []),
  ].join('\n')
}
