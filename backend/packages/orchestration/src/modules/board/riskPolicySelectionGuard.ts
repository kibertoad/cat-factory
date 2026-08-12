import type {
  BlockEditActor,
  BlockEditAuthority,
  RunDefaultScope,
  RiskPolicySelectionRefusal,
} from '@cat-factory/contracts'
import { refuseRiskPolicySelection, RUN_DEFAULT_SCOPES } from '@cat-factory/contracts'
import type { RiskPolicy, WorkspaceRiskPolicyReader } from '@cat-factory/kernel'
import { ForbiddenError } from '@cat-factory/kernel'
import type { ResolvedRunRiskPolicy } from '../execution/policy-types.js'
import { preloadedRiskPolicyRead, resolveRiskPolicy } from '../merge/riskPolicyResolution.js'

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
 * **Every workspace named here is a HOME, never the acting board.** A board mounts services homed
 * elsewhere, and a write on one lands at that home: the row is written there, its preset id
 * resolves against THAT library, and a run on it is admitted through that board under the role the
 * editor holds THERE (`blockRepository.get` is scoped by physical `workspace_id`, so a run cannot
 * even resolve the block anywhere else). Which is why the editor arrives as a
 * {@link BlockEditAuthority} rather than a pre-resolved actor: asking it per workspace is what
 * keeps the policies and the role being compared answers to the same question.
 *
 * Read live rather than through the `riskPolicy` cache slice: this runs on a rare board write, not
 * on the engine's per-gate path, and an authorization decision is the last place to want a
 * stale-by-a-TTL answer on a facade whose cross-isolate invalidation is a pass-through.
 */
export interface RiskPolicySelectionGuard {
  /**
   * Throw a {@link ForbiddenError} when the editor may not move a task from `currentId` to
   * `nextId` within `homeWorkspaceId`.
   *
   * `homeWorkspaceId` is the workspace the row LIVES in, which for a task in a mounted foreign
   * service is not the board the request was addressed to. Both the library the two ids resolve
   * against and the role the editor is judged under are read there, because that is where the
   * write lands and where a run on it would be admitted.
   *
   * Both ids are the RAW stored/patched values: absent or empty means "the workspace default",
   * which is a real selection with a real policy behind it, not the absence of one.
   */
  assertMaySelect(input: {
    homeWorkspaceId: string
    authority: BlockEditAuthority
    currentId: string | null | undefined
    nextId: string | null | undefined
  }): Promise<void>

  /**
   * Throw a {@link ForbiddenError} when the editor may not carry blocks pinning `riskPolicyIds`
   * out of `fromWorkspaceId` and into `toWorkspaceId`.
   *
   * The two workspaces are the subtree's HOME before and after the move (a cross-home reparent,
   * which physically migrates the rows), never the acting board. Each pinned id is resolved on
   * both sides, because an id is only meaningful in the library that holds it: a preset belonging
   * to the source workspace is simply dangling at the destination and falls back to ITS default,
   * exactly like a deleted one. That is what makes the move a policy decision even when the id
   * never changes. The editor is resolved on both sides too, and for the same reason: a role is
   * only meaningful in the workspace that granted it.
   *
   * The ids arrive as the raw stored values of every RUNNABLE block in the moved subtree,
   * deduplicated here: a module of a hundred tasks sharing one preset (or pinning none, which is
   * the default) costs one pair of resolutions, not a hundred.
   */
  assertMayMove(input: {
    fromWorkspaceId: string
    toWorkspaceId: string
    authority: BlockEditAuthority
    riskPolicyIds: Iterable<string | null | undefined>
  }): Promise<void>
}

/**
 * The scopes a pair of selections has to be judged under.
 *
 * `resolveRiskPolicy` consults the scope for ONE thing: which default a side that pinned nothing
 * falls back to. So when both sides name a policy outright, every scope resolves the identical
 * pair and judging them one per scope is a second resolution of the same rows reaching the same
 * verdict. The moment either side falls back to a default the two scopes can disagree, and that
 * disagreement is exactly what the second scope was added to catch, so then both are judged.
 */
const scopesFor = (...ids: (string | null | undefined)[]): readonly RunDefaultScope[] =>
  ids.every((id) => id) ? SCOPE_INDEPENDENT : RUN_DEFAULT_SCOPES

/** One arbitrary scope, for the pinned case above where they all resolve alike. */
const SCOPE_INDEPENDENT: readonly RunDefaultScope[] = [RUN_DEFAULT_SCOPES[0]!]

/** Why the swap was refused, in copy the person holding the picker can act on. */
const REFUSAL_MESSAGE: Record<RiskPolicySelectionRefusal, string> = {
  relaxes_run_oversight:
    'The merge policy you picked lets a run of this task answer its own review checkpoints ' +
    'instead of stopping for a person. Ask a workspace admin to change the policy or to run ' +
    'this task themselves.',
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
 * The same four refusals, said about the DESTINATION rather than about a picked preset. Separate
 * copy rather than a shared string with the noun swapped, because the person who dragged a task
 * between two services picked no policy at all: told "the merge policy you picked", they would go
 * looking for a picker they never touched.
 *
 * Both maps are the UNTRANSLATED last resort behind `details.reason`, which is what the SPA maps
 * to its own copy (CLAUDE.md: the backend does not localize prose).
 */
const MOVE_REFUSAL_MESSAGE: Record<RiskPolicySelectionRefusal, string> = {
  relaxes_run_oversight:
    'The merge policy where you are moving this task lets a run answer its own review ' +
    'checkpoints instead of stopping for a person, and the one governing it here does not. Ask ' +
    'a workspace admin to move it.',
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
  /**
   * The board's merged library (ADR 0055). The guard judges a MOVE against the policy actually in
   * force on either side, and an inherited account policy is as much in force as a local one, so
   * reading the workspace tier alone would let a task move onto a wider posture unjudged.
   */
  riskPolicyReader?: WorkspaceRiskPolicyReader
}): RiskPolicySelectionGuard {
  /**
   * A resolver for every policy in force in ONE workspace, off ONE query.
   *
   * The library is read whole rather than per pinned id because the alternative is the N+1 this
   * repo bans (a point read per pin, with the workspace default re-read alongside every one of
   * them), and a preset library is a handful of hand-maintained rows either way. The resolution
   * itself stays `resolveRiskPolicy`, the one the engine uses, so a preloaded answer and a live
   * one cannot diverge on a dangling id or an unseeded default.
   *
   * The resolver takes a SCOPE because a task that pins no policy resolves a different row
   * depending on how its runs enter, and the guard cannot know which of those a future run will
   * be. Both callers therefore judge the pair under EVERY scope and refuse if any of them widens:
   * a move that is safe for the board's in-app runs and hands the same task's API-started runs a
   * wider landing authority is exactly the escalation this guard exists to catch.
   */
  const openLibrary = async (workspaceId: string) => {
    const library: readonly RiskPolicy[] = (await deps.riskPolicyReader?.list(workspaceId)) ?? []
    const read = preloadedRiskPolicyRead(library)
    return (
      riskPolicyId: string | null | undefined,
      scope: RunDefaultScope,
    ): Promise<ResolvedRunRiskPolicy> =>
      resolveRiskPolicy({
        repository: deps.riskPolicyReader,
        workspaceId,
        riskPolicyId,
        scope,
        read,
      })
  }

  /**
   * Whether the rule can refuse anything at all for this pair of authorities, before either
   * library is read. Not an optimisation the rule needs (`refuseRiskPolicySelection` decides the
   * same cases), but it spares a round trip on the two readings that dominate: an editor with no
   * tier on a side (an engine path, a headless key, dev-open) and one who owns the preset library.
   */
  const couldRefuse = (from: BlockEditActor, to: BlockEditActor): boolean =>
    Boolean(from.role) && Boolean(to.role) && !from.managesPolicy && !to.managesPolicy

  return {
    async assertMaySelect(input) {
      const { homeWorkspaceId, authority, currentId, nextId } = input
      if ((currentId ?? '') === (nextId ?? '')) return
      const actor = await authority.in(homeWorkspaceId)
      // Both sides are in force in the SAME workspace here, so one actor answers for both.
      if (!couldRefuse(actor, actor)) return
      const policy = await openLibrary(homeWorkspaceId)
      for (const scope of scopesFor(currentId, nextId)) {
        const [from, to] = await Promise.all([policy(currentId, scope), policy(nextId, scope)])
        const refusal = refuseRiskPolicySelection({
          from: { policy: from, actor },
          to: { policy: to, actor },
        })
        if (refusal) throw new ForbiddenError(REFUSAL_MESSAGE[refusal], { reason: refusal })
      }
    },

    async assertMayMove(input) {
      const { fromWorkspaceId, toWorkspaceId, authority, riskPolicyIds } = input
      // A move that does not change the home changes no resolution: same library, same ids, same
      // answer, same role. Only the cross-home half of a reparent is a policy decision.
      if (fromWorkspaceId === toWorkspaceId) return
      const [fromActor, toActor] = await Promise.all([
        authority.in(fromWorkspaceId),
        authority.in(toWorkspaceId),
      ])
      if (!couldRefuse(fromActor, toActor)) return
      const picks = new Set<string>()
      for (const id of riskPolicyIds) picks.add(id ?? '')
      if (picks.size === 0) return
      // Two reads for the whole subtree: each home's library, once. Every pick below resolves in
      // memory off those, so the pick count costs nothing.
      const [fromPolicy, toPolicy] = await Promise.all([
        openLibrary(fromWorkspaceId),
        openLibrary(toWorkspaceId),
      ])
      for (const pick of picks) {
        const id = pick || null
        // One id, resolved on both sides — so it is pinned for both or falls back on both.
        for (const scope of scopesFor(id, id)) {
          const [held, next] = await Promise.all([fromPolicy(id, scope), toPolicy(id, scope)])
          const refusal = refuseRiskPolicySelection({
            from: { policy: held, actor: fromActor },
            to: { policy: next, actor: toActor },
          })
          if (refusal) throw new ForbiddenError(MOVE_REFUSAL_MESSAGE[refusal], { reason: refusal })
        }
      }
    },
  }
}
