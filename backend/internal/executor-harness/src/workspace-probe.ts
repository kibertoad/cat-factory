import { changedPathsFromPorcelain, headCommit, workingTreeStatus } from './git.js'
import { EFFORT_REPORT_FILE } from './effort.js'
import { FOLLOW_UPS_FILENAME } from './follow-ups.js'
import { PR_DESCRIPTION_FILE } from './pr-description.js'

// The working-tree answer to "has this run actually changed the repository". The no-progress
// guard's no-edit bound used to answer it from TOOL NAMES, which is a fact about which tool the
// model happened to pick, not about the repo: an agent writing every file through `bash`
// (heredocs, `sed -i`, `node -e`) read as forty calls and not one edit however much it had built,
// and the guard killed it. This module is the evidence the guard now decides on instead.
//
// Kept OFF the hot path. The bound only matters at the instant it is about to abort, so the probe
// runs there and at most once per run (see `guard-driver.ts`), never per tool call.

/**
 * The harness's own side-channel sentinels, written INTO the checkout by the platform rather than
 * by the agent. Excluded from the dirty check, or a run that wrote nothing but its effort report
 * reads as productive and the guard it is meant to satisfy never fires again.
 *
 * Deliberately just this list. A cleverer rule (anything dotted, anything the harness has ever
 * touched) would start excluding the agent's own work — a `.github/workflows/ci.yml` or an
 * `eslint.config.js` is exactly the greenfield deliverable this whole change exists to keep.
 */
export const HARNESS_SENTINEL_FILES: readonly string[] = [
  EFFORT_REPORT_FILE,
  FOLLOW_UPS_FILENAME,
  PR_DESCRIPTION_FILE,
]

/** What a workspace probe found. Never `undefined`: a probe that cannot answer THROWS. */
export interface WorkspaceEvidence {
  /** Whether the repository changed: a dirty working tree, or HEAD moved off the pass's base. */
  mutated: boolean
  /** HEAD at probe time, quoted in the guard's diagnostic so the evidence is on the record. */
  headSha: string
  /** Whether HEAD moved off the sha the pass started from (the agent committed). */
  headMoved: boolean
  /** How many non-sentinel paths the working tree reports as changed. */
  dirtyPathCount: number
}

/** Probes the working tree for evidence the agent changed the repository. Throws if it cannot. */
export type WorkspaceProbe = () => Promise<WorkspaceEvidence>

/**
 * The non-sentinel paths in a porcelain status — the working-tree half of the evidence.
 *
 * Pure, so the sentinel rule is unit-testable without a repository. A sentinel matches by BASENAME
 * as well as by exact path: the agent's cwd is a service subdirectory in a monorepo, so its effort
 * report lands at `services/api/.cat-effort.json`, and a root-anchored comparison would miss it.
 */
export function agentChangedPaths(status: string): string[] {
  const sentinels = new Set<string>(HARNESS_SENTINEL_FILES)
  return changedPathsFromPorcelain(status).filter((path) => {
    const basename = path.slice(path.lastIndexOf('/') + 1)
    return !sentinels.has(path) && !sentinels.has(basename)
  })
}

/**
 * Build the probe for one pass: the working tree at `dir`, judged against the sha the pass
 * started from.
 *
 * The repository changed if the tree is dirty or HEAD has moved off `baseSha`. Both are the agent
 * changing the repo, and between them they cover the two shapes the tool-name proxy missed: files
 * written through `bash` and left in the tree, and files written and then committed. Gitignored
 * paths are excluded by git itself, so an `npm install` still reads as nothing.
 *
 * ORDER MATTERS, and carries the "is this a repository at all" question. The status runs FIRST and
 * is never caught: a `dir` that is no git repository fails there, and the driver treats a throw as
 * inconclusive (re-arm and warn, never abort). HEAD is read second and a failure to read it is
 * NOT a failed probe: a scaffold-from-scratch checkout has no commit yet, so `rev-parse HEAD`
 * errors in exactly the case the dirty-tree half was written for. It reads as the empty sha, which
 * is what the pass baselined against too, so the two agree that HEAD has not moved and the tree
 * decides. Catching it around the status instead would turn "not a repository" into "no evidence
 * of change" and hand the guard a clean verdict it has no business acting on.
 *
 * INJECTED, never imported by the guard: the guard stays pure and synchronous so it can be driven
 * over a fixed event sequence in a unit test, and the git access lives out here where a test
 * substitutes a stub.
 */
export function createWorkspaceProbe(deps: {
  dir: string
  /** HEAD when this pass began — a repair round's base is its own start, not the clone's. */
  baseSha: string
  signal?: AbortSignal
}): WorkspaceProbe {
  return async () => {
    const status = await workingTreeStatus(deps.dir, deps.signal)
    const dirty = agentChangedPaths(status)
    const headSha = await readHeadOrEmpty(deps.dir, deps.signal)
    const headMoved = headSha !== deps.baseSha
    return {
      mutated: dirty.length > 0 || headMoved,
      headSha,
      headMoved,
      dirtyPathCount: dirty.length,
    }
  }
}

/**
 * HEAD at `dir`, or the empty sha where there is no commit to read.
 *
 * The one shared reader for both the pass BASELINE and the probe, so the two can never disagree
 * about what a commit-less checkout is worth: if the baseline tolerates a missing HEAD and the
 * probe throws on it, a from-scratch build has no working bound at all.
 */
export async function readHeadOrEmpty(dir: string, signal?: AbortSignal): Promise<string> {
  return headCommit(dir, signal).catch(() => '')
}

/**
 * One probe over SEVERAL checkouts, for a run whose cwd is not itself a repository.
 *
 * A multi-repo run works at a WORKSPACE ROOT holding sibling checkouts, so probing the cwd asks
 * git about a directory that is no repository: every probe throws, the driver re-arms forever and
 * the no-edit bound is permanently unenforceable. The honest question there is "did the run change
 * ANY of the repositories it was given", which is this.
 *
 * Mutation is a disjunction and inconclusiveness WINS OVER cleanliness. A leg that answers
 * `mutated` settles it, since one changed repository is the run making progress. But a leg that
 * THREW might have been the changed one, so `mutated: false` is only reported when every leg
 * actually answered; otherwise this throws and the driver re-arms, which is the same fail-open
 * disposition a single failing probe already gets. Killing a productive run is the expensive error.
 *
 * `headSha` joins the answering legs' shas, because a workspace has no single HEAD and quoting one
 * leg's would put a sha in the abort diagnostic that says nothing about where the run actually was.
 */
export function composeWorkspaceProbes(probes: readonly WorkspaceProbe[]): WorkspaceProbe {
  if (probes.length === 1) return probes[0] as WorkspaceProbe
  return async () => {
    const settled = await Promise.allSettled(probes.map((probe) => probe()))
    const answered = settled.filter(
      (result): result is PromiseFulfilledResult<WorkspaceEvidence> =>
        result.status === 'fulfilled',
    )
    const evidence = answered.map((result) => result.value)
    const mutated = evidence.some((one) => one.mutated)
    if (!mutated && answered.length < probes.length) {
      const first = settled.find((result) => result.status === 'rejected')
      throw new Error(
        `${probes.length - answered.length} of ${probes.length} checkouts could not be probed and ` +
          `none of the rest had changed, so whether this run changed anything is unknown`,
        { cause: first?.status === 'rejected' ? first.reason : undefined },
      )
    }
    return {
      mutated,
      headSha: evidence.map((one) => one.headSha).join(', '),
      headMoved: evidence.some((one) => one.headMoved),
      dirtyPathCount: evidence.reduce((total, one) => total + one.dirtyPathCount, 0),
    }
  }
}
