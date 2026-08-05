import type { BlockEditActor, RiskPolicySelectionRefusal } from '@cat-factory/contracts'
import { refuseRiskPolicySelection } from '@cat-factory/contracts'
import type { RiskPolicyRepository } from '@cat-factory/kernel'
import { ForbiddenError } from '@cat-factory/kernel'
import { resolveRiskPolicy } from '../merge/riskPolicyResolution.js'

/**
 * Refuse a task's merge-preset SELECTION that would relax what the selector's own role is held to.
 *
 * The rule itself is `refuseRiskPolicySelection` in contracts (the SPA's picker applies the same
 * one); this is the part that needs the repository: resolving both sides of the swap through the
 * SAME resolution the engine will use when the run settles, so a task that pins nothing is judged
 * against the workspace default rather than against nothing at all. That last part is what makes
 * the guard cover CREATION too: a member authoring a task straight onto a permissive preset is
 * moving off the default that would otherwise have governed it.
 *
 * Read live rather than through the `riskPolicy` cache slice: this runs on a rare board write, not
 * on the engine's per-gate path, and an authorization decision is the last place to want a
 * stale-by-a-TTL answer on a facade whose cross-isolate invalidation is a pass-through.
 */
export interface RiskPolicySelectionGuard {
  /**
   * Throw a {@link ForbiddenError} when `actor` may not move a task from `currentId` to `nextId`.
   *
   * Both ids are the RAW stored/patched values: absent or empty means "the workspace default",
   * which is a real selection with a real policy behind it, not the absence of one.
   */
  assertMaySelect(input: {
    workspaceId: string
    actor: BlockEditActor
    currentId: string | null | undefined
    nextId: string | null | undefined
  }): Promise<void>
}

/** Why the swap was refused, in copy the person holding the picker can act on. */
const REFUSAL_MESSAGE: Record<RiskPolicySelectionRefusal, string> = {
  relaxes_role_sandbox:
    'This task runs sandboxed for your role, and the merge policy you picked does not. Ask a ' +
    'workspace admin to change the policy or to run this task themselves.',
  relaxes_role_submission_allowlist:
    'The merge policy you picked would let your role land kinds of change this task holds it ' +
    'back from. Ask a workspace admin to change the policy or to run this task themselves.',
  relaxes_role_class_rule:
    'The merge policy you picked auto-merges changes your role is held to review on this task. ' +
    'Ask a workspace admin to change the policy or to run this task themselves.',
}

export function createRiskPolicySelectionGuard(deps: {
  riskPolicyRepository?: RiskPolicyRepository
}): RiskPolicySelectionGuard {
  return {
    async assertMaySelect(input) {
      const { workspaceId, actor, currentId, nextId } = input
      // Short-circuit before either read on the two cases that cannot refuse anything: an editor
      // with no tier to be scoped by, and one who owns the preset library outright. Both are
      // decided by the contracts rule as well, so this only spares them the round trip.
      if (!actor.role || actor.managesPolicy) return
      if ((currentId ?? '') === (nextId ?? '')) return
      const [from, to] = await Promise.all([
        resolveRiskPolicy({
          repository: deps.riskPolicyRepository,
          workspaceId,
          riskPolicyId: currentId,
        }),
        resolveRiskPolicy({
          repository: deps.riskPolicyRepository,
          workspaceId,
          riskPolicyId: nextId,
        }),
      ])
      const refusal = refuseRiskPolicySelection({ from, to, actor })
      if (refusal) throw new ForbiddenError(REFUSAL_MESSAGE[refusal], { reason: refusal })
    },
  }
}
