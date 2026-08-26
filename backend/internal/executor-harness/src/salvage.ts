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

/**
 * Basenames and suffixes that carry CREDENTIALS, withheld from every salvage.
 *
 * The deny-list above trades a cheap miss (a `dist/` that belonged in a commit) against an
 * expensive one (`node_modules/` in a PR). For a secret that trade INVERTS: a private key or a
 * populated `.env` pushed to a branch is a disclosure that outlives the run, cannot be taken back
 * by deleting the commit, and forces a rotation. Missing a file is recoverable; leaking one is not.
 *
 * This exists for the same reason the deny-list does: on the greenfield case the salvage was
 * written for, the agent was killed before it wrote a `.gitignore`, so git excludes nothing and
 * the harness is the only thing standing between an agent-authored key and the pull request.
 *
 * Unlike a junk path, a withheld secret is REPORTED (see {@link SalvageReport.withheld}): the file
 * is real work that did not land, and whoever reads the run has to decide whether to re-create it
 * or, if it holds a live credential, to rotate it.
 */
export const SALVAGE_SECRET_BASENAMES: readonly string[] = [
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]

/**
 * Suffixes that mark a key store or an environment file, withheld for the reason above.
 *
 * `.env` is here as well as in {@link isSecretBearingName}'s own `.env` / `.env.*` test, so that
 * `prod.env` and `local.env` are caught alongside `.env` and `.env.production`. The sample
 * allow-list is unaffected: `.env.example` ends in `.example`, not in `.env`.
 */
export const SALVAGE_SECRET_SUFFIXES: readonly string[] = [
  '.env',
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
]

/** Path segments that are credential or state stores rather than source. */
export const SALVAGE_SECRET_SEGMENTS: readonly string[] = ['.aws', '.gnupg', '.ssh', '.terraform']

/**
 * The `.env` files that carry no secret and ARE the deliverable: the checked-in sample every
 * scaffold ships so a reader knows which variables the service wants.
 *
 * An allow-list rather than a cleverer rule, because the two are the same shape and only the
 * convention tells them apart. `.env` and every other `.env.<something>` is withheld: a scaffolded
 * `.env.local` or `.env.production` is exactly where a real key ends up.
 */
export const SALVAGE_ENV_SAMPLE_BASENAMES: readonly string[] = [
  '.env.defaults',
  '.env.dist',
  '.env.example',
  '.env.sample',
  '.env.template',
]

/** Whether `basename` is a credential-bearing file the salvage must never commit. */
function isSecretBearingName(basename: string): boolean {
  const lower = basename.toLowerCase()
  if (SALVAGE_ENV_SAMPLE_BASENAMES.includes(lower)) return false
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (SALVAGE_SECRET_BASENAMES.includes(lower)) return true
  return SALVAGE_SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

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
  /**
   * Secret-bearing paths the salvage refused to commit, whatever its `status` (a run with nothing
   * else to salvage still reports them, as `none`). Named rather than counted: the point is that
   * someone can look at the file and decide whether it held a live credential.
   */
  withheld?: string[]
}

/** How many paths a report quotes. The count carries the rest; a report is a summary, not a manifest. */
const REPORTED_PATHS = 20

/**
 * What the salvage does with one path.
 *
 * Three outcomes, not two, because the reasons for withholding a file are not the same fact. A
 * `skip` is expected and uninteresting: nobody wants `node_modules` in a PR, and saying so would
 * be noise on every run. A `secret` is a decision someone has to know about — the file was real
 * work, it did not land, and it may hold a live credential that now needs rotating.
 */
export type SalvageDisposition = 'salvage' | 'skip' | 'secret'

/** What the salvage would do with `path`: keep it, drop it quietly, or withhold it as a secret. */
export function classifySalvagePath(path: string): SalvageDisposition {
  const segments = path.split('/')
  const basename = segments[segments.length - 1] ?? ''
  if (isSecretBearingName(basename)) return 'secret'
  if (segments.some((segment) => SALVAGE_SECRET_SEGMENTS.includes(segment))) return 'secret'
  if (HARNESS_SENTINEL_FILES.includes(basename)) return 'skip'
  if (SALVAGE_DENIED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return 'skip'
  if (segments.some((segment) => SALVAGE_DENIED_SEGMENTS.includes(segment))) return 'skip'
  return 'salvage'
}

/**
 * Split the untracked paths into what the salvage commits and what it withholds as secret-bearing.
 *
 * The secret check runs BEFORE the junk one, so a key under a denied directory is still counted as
 * withheld rather than swallowed as junk: the point of the count is telling someone a credential
 * may have been created, and where it happened to sit does not change that.
 */
export function partitionSalvageCandidates(paths: readonly string[]): {
  candidates: string[]
  withheld: string[]
} {
  const candidates: string[] = []
  const withheld: string[] = []
  for (const path of paths) {
    const disposition = classifySalvagePath(path)
    if (disposition === 'salvage') candidates.push(path)
    else if (disposition === 'secret') withheld.push(path)
  }
  return { candidates, withheld }
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
  const { candidates, withheld } = partitionSalvageCandidates(
    await listUntrackedFiles(args.dir, args.signal),
  )
  if (withheld.length > 0) {
    args.logger.warn('salvage: withheld secret-bearing files from the commit', { withheld })
  }
  const secrets = withheld.length > 0 ? { withheld } : {}
  if (candidates.length === 0) {
    return { status: 'none', files: [], fileCount: 0, totalBytes: 0, ...secrets }
  }

  const totalBytes = await measure(args.dir, candidates)
  const report = {
    files: candidates.slice(0, REPORTED_PATHS),
    fileCount: candidates.length,
    totalBytes,
    ...secrets,
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
    if (!commitSha) return { status: 'none', files: [], fileCount: 0, totalBytes: 0, ...secrets }
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

/**
 * The banner for a pull request whose ENTIRE content is a salvage.
 *
 * A branch the agent never committed to, which exists only because the harness swept up the
 * untracked files left in that checkout, is not a change anyone proposed. It is still worth
 * opening (dropping it is the loss this whole module exists to prevent, and a peer repository in a
 * multi-repo run is where a cross-service change most easily goes missing), but its reviewer has
 * to be told that before reading it as a considered contribution: the agent may have been building
 * there, or it may have left scratch work behind while working on a sibling repository, and
 * nothing in the diff distinguishes the two.
 *
 * Lives here with {@link salvageCommitMessage} and {@link describeSalvage} because all three are
 * the same job — saying what a salvage is to whoever finds it — and the three had better not drift
 * into describing it differently. The caller decides WHERE it goes.
 */
export function salvageOnlyNotice(): string {
  return (
    `> **This branch is a salvage.** The agent committed nothing to this repository; everything ` +
    `here is new files it left uncommitted in the checkout, swept up by the harness so they would ` +
    `not be discarded with the container. Nothing has reviewed them for completeness or ` +
    `relevance, and some may be scratch work from the agent's task in a sibling repository.`
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
 * Where a salvage commit ENDED UP, which the salvage itself cannot know: it commits, and someone
 * else pushes. A commit that was not pushed dies with the container exactly as the uncommitted
 * files would have, so a note that does not say so describes a rescue that did not happen.
 */
export interface SalvageDelivery {
  pushed: boolean
  /** Why the push did not land, when it did not. */
  reason?: string
}

/**
 * What a human can act on, in one or two sentences. Joined onto the failure an aborted run
 * reports, so the person reading "the run was killed" is told in the same breath what became of
 * its work: on the branch and reviewed by nobody, still in the container, or never committed.
 *
 * `delivery` is supplied by whoever pushed. Absent means the caller is on a path where the
 * ordinary push follows (the settle path), so there is nothing extra to say.
 */
export function describeSalvage(
  report: SalvageReport,
  delivery?: SalvageDelivery,
): string | undefined {
  const parts = [describeOutcome(report, delivery), describeWithheld(report)].filter(
    (part): part is string => part !== undefined,
  )
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** The fate of the files the salvage DID try to keep. */
function describeOutcome(
  report: SalvageReport,
  delivery: SalvageDelivery | undefined,
): string | undefined {
  switch (report.status) {
    case 'none':
      return undefined
    case 'committed': {
      const landed =
        delivery && !delivery.pushed
          ? `commit ${report.commitSha ?? 'unknown'}, which could NOT be pushed ` +
            `(${delivery.reason ?? 'the push failed'}) and so is lost with the container`
          : `commit ${report.commitSha ?? 'unknown'}`
      return (
        `${report.fileCount} uncommitted new file(s) the agent left behind were salvaged into ` +
        `${landed}; this run was aborted, so review them before trusting them.`
      )
    }
    case 'refused':
      return `Uncommitted new files were NOT salvaged: ${report.reason ?? 'over the salvage bounds'}`
    case 'failed':
      return (
        `${report.fileCount} uncommitted new file(s) were left behind and could NOT be salvaged: ` +
        `${report.reason ?? 'the commit failed'}`
      )
  }
}

/** The secret-bearing files the salvage refused, named so a live credential can be rotated. */
function describeWithheld(report: SalvageReport): string | undefined {
  const withheld = report.withheld ?? []
  if (withheld.length === 0) return undefined
  const shown = withheld.slice(0, REPORTED_PATHS).join(', ')
  const rest =
    withheld.length > REPORTED_PATHS ? ` (and ${withheld.length - REPORTED_PATHS} more)` : ''
  return (
    `${withheld.length} file(s) that look credential-bearing were withheld from the salvage and ` +
    `are NOT on the branch: ${shown}${rest}. Re-create them, and rotate anything real they held.`
  )
}
