import type { Block, ExecutionInstance } from '@cat-factory/kernel'
import { PR_REVIEWER_KIND } from '@cat-factory/agents'
import { DEFAULT_REVIEW_EFFORT_LEVEL, type ReviewEffortLevel } from '@cat-factory/contracts'
import type { RunPolicyScope } from './policy-types.js'

/**
 * The post-implementation code reviewer: the `coder`'s companion in the standard pipelines (see
 * the built-in companion catalog in `@cat-factory/agents`). Its effort comes from the run's risk
 * policy rather than from the task, because nobody files it: it is a step every implementation
 * passes through, and how hard it looks is a posture the policy already owns beside the rework
 * budget it spends.
 */
const POST_IMPLEMENTATION_REVIEWER_KIND = 'reviewer'

/** Reads the run's resolved risk policy for the post-implementation review effort. */
export type ResolvePostImplementationReviewEffort = (
  workspaceId: string,
  block: Block,
  run: RunPolicyScope,
) => Promise<ReviewEffortLevel>

/**
 * The `reviewEffort` slice of an agent context: which effort level this dispatch reviews at, or
 * nothing for a kind that does not review code.
 *
 * - `pr-reviewer` reads the `review` task's own pick (`taskTypeFields.reviewEffort`), chosen when
 *   the task was created.
 * - the post-implementation `reviewer` reads the run's risk policy.
 *
 * Absent on either side resolves to {@link DEFAULT_REVIEW_EFFORT_LEVEL}, the level both reviews
 * ran at before the setting existed. A HELPER dispatched off a `pr-reviewer` step (the challenge
 * investigator, the fixer) runs under its own kind and gets nothing here, which is right: neither
 * one reviews.
 */
export async function reviewEffortSlice(
  deps: { resolvePostImplementationReviewEffort?: ResolvePostImplementationReviewEffort },
  workspaceId: string,
  agentKind: string,
  block: Block,
  instance: ExecutionInstance,
): Promise<{ reviewEffort?: ReviewEffortLevel }> {
  if (agentKind === PR_REVIEWER_KIND) {
    return { reviewEffort: block.taskTypeFields?.reviewEffort ?? DEFAULT_REVIEW_EFFORT_LEVEL }
  }
  if (agentKind === POST_IMPLEMENTATION_REVIEWER_KIND) {
    const resolve = deps.resolvePostImplementationReviewEffort
    const level = resolve
      ? await resolve(workspaceId, block, instance)
      : DEFAULT_REVIEW_EFFORT_LEVEL
    return { reviewEffort: level }
  }
  return {}
}
