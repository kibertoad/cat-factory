import {
  UnavailableError,
  describeError,
  getErrorMessage,
  runBestEffort,
  type DelegatedRepoFilesResolver,
  type DelegationBrief,
  type Logger,
  type RepoFiles,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Making sure the work branch a delegated dispatch names is THERE, for the executors that
// declared they need it there (`workBranch: 'platform-creates'`).
//
// The join neither side owned. A container step's work branch is created by the harness's own
// clone; nothing creates it for a delegated step, so an external CI system told to check out
// `branches.work` fails the job before any of the work begins. Worse, a runner that substitutes a
// branch of its own on a missing ref SUCCEEDS, publishing to a branch the platform never recorded,
// and the run then reports as having produced nothing over a pull request nobody links to.
//
// It belongs to the ENGINE rather than to each executor: the engine resolves the branch name, the
// engine already holds the checkout-free repo binding a pre/post-op writes through, and one write
// at the claim beats the same write re-implemented in every deployment's executor over a second
// credential.
//
// `RepoFiles` rather than the container path's `EnsureWorkBranch` (`../github/ensureWorkBranch.ts`)
// deliberately: that one is GitHub REST over a minted installation token, so a GitLab deployment
// would need a second implementation, and it answers a best-effort boolean where a delegated
// dispatch has to be REFUSED. This binding is the provider-neutral one a registered kind's
// pre/post-ops already write through. Converging the container path onto it is a slice of its own
// (`docs/initiatives/delegated-executors.md`).
// ---------------------------------------------------------------------------

/** What {@link ensureDelegatedWorkBranch} needs, as bound callbacks rather than a container. */
export interface DelegationWorkBranchDeps {
  /** Absent ⇒ this deployment configured no VCS provider, which is its own refusal below. */
  resolveRepoFiles: DelegatedRepoFilesResolver | undefined
  logger: Logger
}

/** One request to prepare a branch: whose dispatch it is for, and who may create it. */
export interface DelegationWorkBranchRequest {
  executorId: string
  /**
   * Whether the task named this branch itself (an apriori WORKING branch) rather than the engine
   * deriving `cat-factory/<blockId>`. The platform never CREATES one of those: a run whose user
   * picked an existing feature branch and found an empty one instead cannot tell that from the
   * run ignoring their choice. Probed and refused when absent, exactly as the container path
   * refuses it (`ContainerAgentExecutor.resolveWorkBranchReady`).
   */
  apriori: boolean
}

/**
 * Make sure the brief's work branch exists before the executor is called, creating it at the base
 * branch's head when the platform is the one allowed to.
 *
 * IDEMPOTENT by construction, which both durable drivers require: a replayed dispatch re-reads the
 * head and finds the ref it made last time. The concurrent case is settled by CONTENT rather than
 * by parsing a provider's refusal, because the two providers answer a lost create differently (a
 * GitHub 422, a GitLab 400) and a failing create is indistinguishable from a losing one by status
 * alone: re-read the ref, and let the write's own error propagate when it genuinely is not there.
 */
export async function ensureDelegatedWorkBranch(
  deps: DelegationWorkBranchDeps,
  brief: DelegationBrief,
  request: DelegationWorkBranchRequest,
): Promise<void> {
  const { base, work } = brief.branches
  const { executorId } = request
  const log = deps.logger.child({ executor: executorId, branch: work })
  const repo = await resolveRepo(deps, brief, request, work)
  const headOf = branchReader(repo, executorId, work)
  if (await headOf(work)) return
  if (request.apriori) {
    throw unprepared(
      `Cannot dispatch the "${executorId}" executor onto the work branch "${work}": the task ` +
        `names it as the branch to build inside and it does not exist in ` +
        `${brief.repo.owner}/${brief.repo.name}. Push it, or clear the task's working branch so ` +
        `the run builds on its own. The platform never creates a branch a task named.`,
      { executor: executorId, branch: work, aprioriBranch: true },
    )
  }
  const baseSha = await headOf(base)
  if (!baseSha) {
    // The base branch the projection records is not in the repository. Refused rather than
    // forked from the default branch instead: a service whose recorded base is wrong would then
    // silently produce every change against a branch nobody chose.
    throw unprepared(
      `Cannot create the work branch "${work}" for the "${executorId}" executor: the base ` +
        `branch "${base}" does not exist in ${brief.repo.owner}/${brief.repo.name}.`,
      { executor: executorId, branch: work, baseBranch: base },
    )
  }
  try {
    await repo.createBranch(work, baseSha)
  } catch (error) {
    // Best-effort on purpose: this read exists only to tell a LOST RACE from a failed write, and
    // a read that fails too answers neither. Letting it throw would replace the create's cause
    // (the actionable one: the app lacks write access) with a probe error naming nothing.
    const settled = await runBestEffort(log, 'work-branch race re-read', () => repo.headSha(work))
    if (settled) {
      log.info('another writer created the work branch first', describeError(error))
      return
    }
    log.warn('could not create the work branch for a delegated dispatch', describeError(error))
    throw unprepared(
      `Cannot create the work branch "${work}" for the "${executorId}" executor: ` +
        getErrorMessage(error),
      { executor: executorId, branch: work },
    )
  }
  log.info('created the work branch for a delegated dispatch', { baseBranch: base })
}

/**
 * Read a branch's head, as this dispatch's own refusal rather than a raw rejection.
 *
 * The probes are as much a part of preparing the branch as the write is, so a provider blip on one
 * owes the same `details.reason`: unwrapped, the SPA has nothing to map, the operator reads the
 * generic 500 copy, and the step's cause is indistinguishable from an engine bug.
 */
function branchReader(
  repo: RepoFiles,
  executorId: string,
  work: string,
): (read: string) => Promise<string | null> {
  return async (read) => {
    try {
      return await repo.headSha(read)
    } catch (error) {
      throw unprepared(
        `Cannot prepare the work branch "${work}" for the "${executorId}" executor: reading the ` +
          `branch "${read}" failed (${getErrorMessage(error)}).`,
        { executor: executorId, branch: work, readBranch: read },
      )
    }
  }
}

/**
 * The checkout-free binding for this run's repository, refusing the two ways it can be absent.
 *
 * They are separated because the remedies are: a facade with no resolver at all is a deployment
 * whose VCS provider is not configured (an operator's env change), while a null answer is one
 * workspace with no repository connected (a connection somebody makes in the product). Both are
 * refused HERE, at the dispatch, rather than where the arm is built: that build runs per request
 * on the Worker, so a throw there turns a delegated-only misconfiguration into a total outage on
 * every unrelated endpoint, and the dispatch is where the fact is finally load-bearing.
 */
async function resolveRepo(
  deps: DelegationWorkBranchDeps,
  brief: DelegationBrief,
  request: DelegationWorkBranchRequest,
  work: string,
): Promise<RepoFiles> {
  const { executorId } = request
  if (!deps.resolveRepoFiles) {
    throw unprepared(
      `Cannot create the work branch "${work}" for the "${executorId}" executor: this deployment ` +
        'has no VCS provider configured, so the platform can write to no repository. Configure ' +
        "one, or register the executor with `workBranch: 'executor-creates'` if its own system " +
        'makes the branch when it pushes.',
      { executor: executorId, branch: work },
    )
  }
  const repo = await deps.resolveRepoFiles({
    workspaceId: brief.workspaceId,
    blockId: brief.blockId,
  })
  if (!repo) {
    throw unprepared(
      `Cannot create the work branch "${work}" for the "${executorId}" executor: this workspace ` +
        'has no repository connection the platform can write through. Connect one, or register ' +
        "the executor with `workBranch: 'executor-creates'` if its own system makes the branch.",
      { executor: executorId, branch: work },
    )
  }
  return repo
}

/** The 503 a dispatch is refused with, naming the ref and the dispatch it was for. */
function unprepared(message: string, details: Record<string, unknown>): UnavailableError {
  return new UnavailableError(message, 'delegated_work_branch_unprepared', details)
}
