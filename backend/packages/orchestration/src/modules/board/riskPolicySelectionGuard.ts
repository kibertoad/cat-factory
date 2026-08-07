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
 * A SELECTION is not the only way a task changes policy, which is why there are two methods.
 * `riskPolicyId` resolves against the workspace that HOMES the task, so carrying the task to
 * another home re-decides the policy while touching neither the id nor the library: the same swap,
 * spelled as a drag. {@link RiskPolicySelectionGuard.assertMayMove} is that arm.
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

  /**
   * Throw a {@link ForbiddenError} when `actor` may not carry tasks pinning `riskPolicyIds` out of
   * `fromWorkspaceId` and into `toWorkspaceId`.
   *
   * The two workspaces are the task's HOME before and after the move (a cross-home reparent, which
   * physically migrates the subtree's rows), never the acting board. Each pinned id is resolved on
   * both sides, because an id is only meaningful in the library that holds it: a preset belonging
   * to the source workspace is simply dangling at the destination and falls back to ITS default,
   * exactly like a deleted one. That is what makes the move a policy decision even when the id
   * never changes.
   *
   * The ids arrive as the raw stored values of every task in the moved subtree, deduplicated here:
   * a module of a hundred tasks sharing one preset (or pinning none, which is the default) costs
   * one pair of resolutions, not a hundred.
   */
  assertMayMove(input: {
    fromWorkspaceId: string
    toWorkspaceId: string
    actor: BlockEditActor
    riskPolicyIds: Iterable<string | null | undefined>
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

/**
 * The same three refusals, said about the DESTINATION rather than about a picked preset. Separate
 * copy rather than a shared string with the noun swapped, because the person who dragged a task
 * between two services picked no policy at all: told "the merge policy you picked", they would go
 * looking for a picker they never touched.
 */
const MOVE_REFUSAL_MESSAGE: Record<RiskPolicySelectionRefusal, string> = {
  relaxes_role_sandbox:
    'This task runs sandboxed for your role where it is now, and the merge policy governing it ' +
    'where you are moving it does not. Ask a workspace admin to move it.',
  relaxes_role_submission_allowlist:
    'The merge policy where you are moving this task would let your role land kinds of change it ' +
    'is held back from here. Ask a workspace admin to move it.',
  relaxes_role_class_rule:
    'The merge policy where you are moving this task auto-merges changes your role is held to ' +
    'review on it here. Ask a workspace admin to move it.',
}

export function createRiskPolicySelectionGuard(deps: {
  riskPolicyRepository?: RiskPolicyRepository
}): RiskPolicySelectionGuard {
  const resolve = (workspaceId: string, riskPolicyId: string | null | undefined) =>
    resolveRiskPolicy({ repository: deps.riskPolicyRepository, workspaceId, riskPolicyId })

  /** Both sides of one comparison, resolved together; the refusal, or null. */
  const judge = async (
    actor: BlockEditActor,
    from: { workspaceId: string; riskPolicyId: string | null | undefined },
    to: { workspaceId: string; riskPolicyId: string | null | undefined },
  ): Promise<RiskPolicySelectionRefusal | null> => {
    const [resolvedFrom, resolvedTo] = await Promise.all([
      resolve(from.workspaceId, from.riskPolicyId),
      resolve(to.workspaceId, to.riskPolicyId),
    ])
    return refuseRiskPolicySelection({ from: resolvedFrom, to: resolvedTo, actor })
  }

  return {
    async assertMaySelect(input) {
      const { workspaceId, actor, currentId, nextId } = input
      // Short-circuit before either read on the two cases that cannot refuse anything: an editor
      // with no tier to be scoped by, and one who owns the preset library outright. Both are
      // decided by the contracts rule as well, so this only spares them the round trip.
      if (!actor.role || actor.managesPolicy) return
      if ((currentId ?? '') === (nextId ?? '')) return
      const refusal = await judge(
        actor,
        { workspaceId, riskPolicyId: currentId },
        { workspaceId, riskPolicyId: nextId },
      )
      if (refusal) throw new ForbiddenError(REFUSAL_MESSAGE[refusal], { reason: refusal })
    },

    async assertMayMove(input) {
      const { fromWorkspaceId, toWorkspaceId, actor, riskPolicyIds } = input
      if (!actor.role || actor.managesPolicy) return
      // A move that does not change the home changes no resolution: same library, same ids, same
      // answer. Only the cross-home half of a reparent is a policy decision.
      if (fromWorkspaceId === toWorkspaceId) return
      const picks = new Set<string>()
      for (const id of riskPolicyIds) picks.add(id ?? '')
      // Concurrent over the DEDUPLICATED picks rather than sequential over the tasks: the reads
      // are independent, and the set is bounded by the presets the subtree names.
      const refusals = await Promise.all(
        [...picks].map((pick) =>
          judge(
            actor,
            { workspaceId: fromWorkspaceId, riskPolicyId: pick || null },
            { workspaceId: toWorkspaceId, riskPolicyId: pick || null },
          ),
        ),
      )
      const refusal = refusals.find((found): found is RiskPolicySelectionRefusal => found !== null)
      if (refusal) throw new ForbiddenError(MOVE_REFUSAL_MESSAGE[refusal], { reason: refusal })
    },
  }
}
