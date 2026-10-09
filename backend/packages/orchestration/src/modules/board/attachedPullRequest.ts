import {
  resolvePrNumber,
  taskTypeAttachesPullRequest,
  type AttachedPrReason,
  type PullRequestRef,
} from '@cat-factory/contracts'
import type {
  Block,
  OpenedPullRequest,
  ResolveRunRepoContext,
  RunRepoContext,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { parsePrUrlRepo, sameRepo } from './reviewTaskTarget.js'

// The pull request a `resolve-conflicts` task ATTACHES at creation: an existing one somebody else
// opened, recorded as the block's own `pullRequest` so the in-place coding kinds and the
// mergeability gate target it exactly as they target a pull request a run opened itself.
//
// Stricter than the review target (`reviewTaskTarget.ts`), which passes through whatever it cannot
// check. A run of this task PUSHES onto the attached head branch, so a reference that cannot be
// positively confirmed as an open, same-repository pull request is refused rather than created.

/** What {@link resolveAttachedPullRequest} needs: the run-repo seam every facade wires. */
export interface AttachedPullRequestDependencies {
  /** The SAME seam the run itself reaches the repository through. Absent: refused as unresolvable. */
  resolveRunRepoContext?: ResolveRunRepoContext
}

/** The canonical per-type fields and the pull request to record on the block. */
export interface AttachedPullRequest {
  fields: NonNullable<Block['taskTypeFields']>
  pullRequest: PullRequestRef
}

function refuse(
  message: string,
  reason: AttachedPrReason,
  details: Record<string, unknown> = {},
): never {
  throw new ValidationError(message, { reason, ...details })
}

function repoName(context: RunRepoContext): string | null {
  return context.owner && context.name ? `${context.owner}/${context.name}` : null
}

/** A URL naming a different repository than the service's would attach whatever PR shares its number. */
function assertSameRepository(prUrl: string | undefined, context: RunRepoContext): void {
  const { owner, name } = context
  const target = prUrl ? parsePrUrlRepo(prUrl) : null
  if (!owner || !name || !target || sameRepo(target, { owner, repo: name })) return
  const expected = `${owner}/${name}`
  refuse(
    `That pull request belongs to ${target.owner}/${target.repo}, but this service is linked to ` +
      `${expected}. Create the task under the service linked to ${target.owner}/${target.repo}.`,
    'attached_pr_repo_mismatch',
    { expected },
  )
}

/** Refuse a pull request the run could not push a resolution onto, naming why. */
function assertPushable(pr: OpenedPullRequest, context: RunRepoContext): string {
  const label = `Pull request #${pr.number}`
  if (pr.merged || pr.state === 'closed') {
    const state = pr.merged ? 'merged' : 'closed'
    refuse(
      `${label} is ${state}; only an open pull request can be updated.`,
      'attached_pr_not_open',
      {
        state,
      },
    )
  }
  if (pr.crossRepository === true) {
    refuse(
      `${label} comes from a fork. The resolution is pushed onto the pull request's head branch ` +
        'in the service repository, and a fork branch is out of its reach.',
      'attached_pr_from_fork',
    )
  }
  if (pr.crossRepository === undefined || !pr.headRef || !pr.baseRef) {
    refuse(
      `${label} could not be attached: the provider did not report which repository and branches it connects.`,
      'attached_pr_unresolvable',
    )
  }
  if (pr.baseRef !== context.baseBranch) {
    refuse(
      `${label} targets ${pr.baseRef}, but conflicts are resolved against the repository's base ` +
        `branch ${context.baseBranch}.`,
      'attached_pr_base_mismatch',
      { expected: context.baseBranch },
    )
  }
  return pr.headRef
}

const unreadable = (number: number): string =>
  `Pull request #${number} cannot be attached: this service has no repository the platform can read pull requests from.`

/**
 * The service's repository context. The resolver throws a reason-less `ValidationError` for a task
 * under no repo-linked service, which is this refusal's documented `attached_pr_unresolvable` case.
 */
async function readRepoContext(
  deps: AttachedPullRequestDependencies,
  workspaceId: string,
  blockId: string,
  number: number,
): Promise<RunRepoContext | null> {
  try {
    return (await deps.resolveRunRepoContext?.(workspaceId, blockId)) ?? null
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    return refuse(unreadable(number), 'attached_pr_unresolvable', { cause: error.message })
  }
}

/**
 * For a task type that attaches a pull request, confirm the referenced one against the provider
 * and return the canonical fields plus the `pullRequest` to record. `null` for every other type.
 *
 * `blockId` is the task itself on a patch, or the container it is about to be created in: either
 * resolves to the same service repository through the ancestry walk.
 */
export async function resolveAttachedPullRequest(
  deps: AttachedPullRequestDependencies,
  workspaceId: string,
  blockId: string,
  taskType: Block['taskType'],
  fields: Block['taskTypeFields'],
): Promise<AttachedPullRequest | null> {
  if (!taskTypeAttachesPullRequest(taskType)) return null
  const number = resolvePrNumber(fields)
  if (number == null) {
    const problem = 'Name the pull request to resolve: supply fields.prNumber or fields.prUrl.'
    throw new ValidationError(problem, { reason: 'task_type_fields_invalid', problems: [problem] })
  }
  const context = await readRepoContext(deps, workspaceId, blockId, number)
  const getPullRequest = context?.repo.getPullRequest
  if (!context || !getPullRequest) {
    return refuse(unreadable(number), 'attached_pr_unresolvable')
  }
  assertSameRepository(fields?.prUrl, context)
  const pr = await getPullRequest(number)
  if (!pr) {
    const where = repoName(context)
    refuse(
      `Pull request #${number} was not found${where ? ` in ${where}` : ''}.`,
      'attached_pr_not_found',
      { prNumber: number },
    )
  }
  const branch = assertPushable(pr, context)
  const url = pr.url || fields?.prUrl || ''
  return {
    fields: { ...fields, prNumber: pr.number, ...(url ? { prUrl: url } : {}) },
    pullRequest: { url, number: pr.number, branch },
  }
}
