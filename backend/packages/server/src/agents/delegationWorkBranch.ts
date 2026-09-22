import {
  UnavailableError,
  describeError,
  getErrorMessage,
  type DelegatedRepoFilesResolver,
  type DelegationBrief,
  type Logger,
  type RepoFiles,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Creating the work branch a delegated dispatch names, for the executors that declared they need
// it there (`workBranch: 'platform-creates'`).
//
// The join neither side owned. A container step's work branch is created by the harness's own
// clone; nothing creates it for a delegated step, so an external CI system told to check out
// `branches.work` fails the job before any of the work begins. Worse, a runner that substitutes a
// branch of its own on a missing ref SUCCEEDS, publishing to a branch the platform never recorded,
// and the run then reports as having produced nothing over a pull request nobody links to.
//
// It belongs to the ENGINE rather than to each executor: the branch name is the engine's own
// (`cat-factory/<blockId>`), the engine already holds the checkout-free repo binding a pre/post-op
// writes through, and one write at the claim beats the same write re-implemented in every
// deployment's executor over a second credential.
// ---------------------------------------------------------------------------

/** What {@link ensureDelegatedWorkBranch} needs, as bound callbacks rather than a container. */
export interface DelegationWorkBranchDeps {
  resolveRepoFiles: DelegatedRepoFilesResolver
  logger: Logger
}

/**
 * Create the brief's work branch at the base branch's head, unless it is already there.
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
  executorId: string,
): Promise<void> {
  const { base, work } = brief.branches
  const log = deps.logger.child({ executor: executorId, branch: work })
  const repo = await resolveRepo(deps, brief, executorId, work)
  if (await repo.headSha(work)) return
  const baseSha = await repo.headSha(base)
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
    if (await repo.headSha(work)) {
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
 * The checkout-free binding for this run's repository.
 *
 * A null answer is a workspace with no VCS connection, which is a different fact from the facade
 * wiring no resolver at all: that one is refused where the delegated arm is BUILT, so it can never
 * reach here.
 */
async function resolveRepo(
  deps: DelegationWorkBranchDeps,
  brief: DelegationBrief,
  executorId: string,
  work: string,
): Promise<RepoFiles> {
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
