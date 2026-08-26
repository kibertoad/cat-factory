import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { commitPaths, listUntrackedFiles } from './git.js'
import { HARNESS_SENTINEL_FILES } from './workspace-probe.js'
import type { Logger } from './logger.js'

// Recovering the work an aborted run left in the tree. `commitTrackedEdits` is a safety net for
// forgotten edits to files git ALREADY tracks, so a NEW file the agent created and never committed
// was found, warned about, and dropped. On a greenfield task every file is new, which made that
// warning the whole deliverable going in the bin: a run that built, tested and verified a service
// through `bash` heredocs was killed by the progress guard and lost all of it.
//
// Observable is not recovered. This makes the salvage real, under guardrails, and MARKED — a
// salvage commit is evidence from an interrupted run, never work anyone should read as reviewed.

/**
 * Directory and file names never salvaged. A greenfield checkout may not have a `.gitignore` yet
 * (the agent had not written one when it was killed), and git only excludes what a `.gitignore`
 * tells it to, so without this a blanket salvage would commit `node_modules` into the PR.
 *
 * Matched against every SEGMENT of a path, so `packages/api/node_modules/x` is caught as surely as
 * a root-level one. Deliberately a short list of the unambiguous ones: a cleverer heuristic starts
 * discarding the deliverable, and a `dist/` that genuinely belonged in a commit is a far cheaper
 * miss than a `node_modules/` that did not.
 */
export const SALVAGE_DENIED_SEGMENTS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
  '.git',
]

/** Suffixes never salvaged: run output, not source. */
export const SALVAGE_DENIED_SUFFIXES: readonly string[] = ['.log']

/** How much may be salvaged before the whole salvage is refused. */
export interface SalvageBounds {
  maxFiles: number
  maxBytes: number
}

/**
 * The default bounds. Generous enough for a scaffolded service (the run this was written for left
 * about twenty source files) and far below anything that looks like a build output or a dependency
 * tree that slipped past the deny-list.
 */
export const DEFAULT_SALVAGE_BOUNDS: SalvageBounds = { maxFiles: 200, maxBytes: 5_000_000 }

/** What the salvage did, carried onto the run outcome so a human is told rather than left to infer. */
export interface SalvageReport {
  /**
   * `none`: nothing was left uncommitted. `committed`: the files below are in `commitSha`.
   * `refused`: there was work but it exceeded the bounds, so NOTHING was committed — a truncated
   * salvage is worse than none, because a half-committed tree reads as a complete one.
   * `failed`: the commit itself could not be made; the paths are named so the loss is on the record.
   */
  status: 'none' | 'committed' | 'refused' | 'failed'
  /** The salvaged (or would-be salvaged) paths, capped for the log/wire; `fileCount` is the truth. */
  files: string[]
  fileCount: number
  totalBytes: number
  commitSha?: string
  /** Why a `refused`/`failed` salvage did not land. */
  reason?: string
}

/** How many paths a report quotes. The count carries the rest; a report is a summary, not a manifest. */
const REPORTED_PATHS = 20

/** Whether a path is the agent's own new work, rather than a dependency tree, build output or sentinel. */
export function isSalvageablePath(path: string): boolean {
  const segments = path.split('/')
  const basename = segments[segments.length - 1] ?? ''
  if (HARNESS_SENTINEL_FILES.includes(basename)) return false
  if (SALVAGE_DENIED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false
  return !segments.some((segment) => SALVAGE_DENIED_SEGMENTS.includes(segment))
}

/**
 * Commit the new, untracked, non-ignored files the agent left behind in `dir`.
 *
 * Bounded by FILE COUNT and TOTAL BYTES, and over either bound it salvages NOTHING and says so:
 * committing a prefix would produce a tree that looks complete and is not, which is the one
 * outcome worse than the loss this exists to prevent.
 *
 * The message names the salvage as a salvage. A commit that arrives on a branch with no
 * explanation is indistinguishable from work the agent chose to make, and this work was chosen by
 * nobody — the run was killed with it still on the floor.
 *
 * CODING MODE ONLY: the caller decides that. A read-only kind has no branch to carry a commit and
 * must never be given one.
 */
export async function salvageUntrackedWork(args: {
  dir: string
  /** How the run ended, which is what the commit message has to state. */
  occasion: SalvageOccasion
  logger: Logger
  signal?: AbortSignal
  bounds?: SalvageBounds
}): Promise<SalvageReport> {
  const bounds = args.bounds ?? DEFAULT_SALVAGE_BOUNDS
  const candidates = (await listUntrackedFiles(args.dir, args.signal)).filter(isSalvageablePath)
  if (candidates.length === 0) return { status: 'none', files: [], fileCount: 0, totalBytes: 0 }

  const totalBytes = await measure(args.dir, candidates)
  const report = {
    files: candidates.slice(0, REPORTED_PATHS),
    fileCount: candidates.length,
    totalBytes,
  }
  if (candidates.length > bounds.maxFiles || totalBytes > bounds.maxBytes) {
    const reason =
      `${candidates.length} uncommitted new files totalling ${totalBytes} bytes exceed the salvage ` +
      `bounds (${bounds.maxFiles} files / ${bounds.maxBytes} bytes), so none were committed — a ` +
      `partial salvage would read as a complete change.`
    args.logger.warn('salvage: refused, over bounds', { ...report, reason })
    return { status: 'refused', ...report, reason }
  }

  try {
    const commitSha = await commitPaths(
      args.dir,
      candidates,
      salvageCommitMessage(candidates.length, args.occasion),
      args.signal,
    )
    if (!commitSha) return { status: 'none', files: [], fileCount: 0, totalBytes: 0 }
    args.logger.warn('salvage: committed the new files the agent left untracked', {
      ...report,
      commitSha,
    })
    return { status: 'committed', ...report, commitSha }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    args.logger.error('salvage: could not commit the files the agent left behind', {
      ...report,
      reason,
    })
    return { status: 'failed', ...report, reason }
  }
}

/**
 * How the run that left these files behind ended. It decides what the commit message SAYS, which
 * is the whole point of marking a salvage: a commit arriving on a branch with no explanation is
 * indistinguishable from work the agent chose to make and someone chose to keep.
 */
export type SalvageOccasion =
  /** The run was killed mid-flight (guard, watchdog, eviction); `cause` is what killed it. */
  | { kind: 'aborted'; cause: string }
  /** The agent finished but never added its own new files. */
  | { kind: 'settled' }

/** The salvage commit's message: what it is, why it exists, and how much to trust it. */
export function salvageCommitMessage(fileCount: number, occasion: SalvageOccasion): string {
  const noun = fileCount === 1 ? 'file' : 'files'
  if (occasion.kind === 'settled') {
    return (
      `chore: commit ${fileCount} new ${noun} the agent left untracked\n\n` +
      `The agent created these files and finished without committing them. The harness committed ` +
      `them so they reach the pull request rather than being discarded with the container.`
    )
  }
  return (
    `chore: salvage ${fileCount} uncommitted ${noun} from an aborted agent run\n\n` +
    `This run was ABORTED (${occasion.cause}) with these files created and never committed. The ` +
    `harness committed them so the work is not lost. They are NOT a reviewed change: nothing ` +
    `checked that they are complete or consistent, and the run had not said it was finished.`
  )
}

/** Total size of `paths` under `dir`; a file that cannot be stat'd counts as zero rather than failing. */
async function measure(dir: string, paths: string[]): Promise<number> {
  const sizes = await Promise.all(
    paths.map((path) =>
      stat(join(dir, path)).then(
        (info) => info.size,
        () => 0,
      ),
    ),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * One sentence a human can act on. Joined onto the failure an aborted run reports, so the person
 * reading "the run was killed" is told in the same breath that its work is on the branch and has
 * been reviewed by nobody.
 */
export function describeSalvage(report: SalvageReport): string | undefined {
  switch (report.status) {
    case 'none':
      return undefined
    case 'committed':
      return (
        `${report.fileCount} uncommitted new file(s) the agent left behind were salvaged into ` +
        `commit ${report.commitSha ?? 'unknown'}; this run was aborted, so review them before ` +
        `trusting them.`
      )
    case 'refused':
      return `Uncommitted new files were NOT salvaged: ${report.reason ?? 'over the salvage bounds'}`
    case 'failed':
      return (
        `${report.fileCount} uncommitted new file(s) were left behind and could NOT be salvaged: ` +
        `${report.reason ?? 'the commit failed'}`
      )
  }
}
