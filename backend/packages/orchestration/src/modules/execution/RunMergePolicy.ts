import type {
  Block,
  ChangeClass,
  GroupCacheHandle,
  ReviewEffort,
  RiskPolicyCacheValue,
  WorkspaceRiskPolicyReader,
} from '@cat-factory/kernel'
import { runDefaultScopeFor } from '@cat-factory/contracts'
import type { MergeTrackRecordService } from '../merge/MergeTrackRecordService.js'
import { cachedRiskPolicyRead, resolveRiskPolicy } from '../merge/riskPolicyResolution.js'
import type { ResolvedRunRiskPolicy, RunPolicyScope } from './policy-types.js'

/** The collaborators the merge-policy layer needs; nothing else on the engine. */
export interface RunMergePolicyDeps {
  /**
   * Optional: resolves a task's merge threshold preset (auto-merge ceilings, the per-class
   * rules, and the CI-fixer attempt budget). Absent → the built-in `FALLBACK_RISK_POLICY`, which
   * auto-merges nothing.
   *
   * The board's whole visible LIBRARY, which since ADR 0055 includes the account policies it
   * inherits, not the workspace tier's own rows: a task may pin an inherited policy, and the run
   * has to be governed by the same posture the picker offered.
   */
  riskPolicyReader?: WorkspaceRiskPolicyReader
  /**
   * Optional: the `AppCaches.riskPolicy` slice — read-through for {@link RunMergePolicy.resolve}
   * so the slow-moving merge-preset row isn't re-fetched on every gate evaluation. Absent →
   * every resolve hits the repository. Invalidated by `RiskPolicyService` on every preset write.
   */
  riskPolicyCache?: GroupCacheHandle<RiskPolicyCacheValue>
  /**
   * Optional: the merge track record (classification + the persisted evidence). Absent ⇒ the
   * recording methods below are no-ops and the merge path behaves exactly as it did before.
   */
  mergeTrackRecord?: MergeTrackRecordService
}

/**
 * The task's effective MERGE POLICY plus the EVIDENCE behind it, extracted out of
 * `ExecutionService` as a cohesive collaborator (the `RunDispatcher` controller extractions are
 * the model): resolving which merge-threshold preset governs a run, and settling that run's merge
 * track record when a human merges or declines.
 *
 * The two belong together — the preset is the policy, the track record is what the policy is
 * eventually judged against — and neither needs anything else the engine owns, so keeping them
 * here stops the engine god-file re-growing.
 *
 * Every recording method is a **best-effort side channel of the merge path**: it swallows its own
 * failures, because the merge has already landed and must never be reported as failed on account
 * of bookkeeping.
 */
export class RunMergePolicy {
  constructor(private readonly deps: RunMergePolicyDeps) {}

  /**
   * Resolve the merge threshold preset that governs a RUN: its task's explicitly-picked preset,
   * else the workspace default for the run's intake scope, else the built-in
   * `FALLBACK_RISK_POLICY`. Returns the thresholds the engine compares against, the per-class
   * rules, the CI attempt budget and the autonomy posture.
   *
   * It takes the RUN and not just the block because a workspace has two defaults and only the run
   * says which one applies: a task pinning nothing is governed by the in-app policy when somebody
   * started it in the app and by the unattended one when nothing is watching
   * (`runDefaultScopeFor`). The block alone cannot answer that, and answering it from the
   * block alone is what left an API-started run parked on a cap nobody would come to.
   *
   * Reads through the `riskPolicy` cache slice when wired: the row is slow-moving admin config
   * re-read on every gate evaluation. The resolution itself is shared with the board's preset
   * SELECTION guard (`resolveRiskPolicy`), so the policy a swap is judged against is the same one
   * this will apply when the run settles.
   */
  async resolve(
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ): Promise<ResolvedRunRiskPolicy> {
    return resolveRiskPolicy({
      repository: this.deps.riskPolicyReader,
      workspaceId,
      riskPolicyId: block.riskPolicyId,
      scope: runDefaultScopeFor(run.intakeOrigin),
      read: cachedRiskPolicyRead(this.deps.riskPolicyCache, workspaceId),
    })
  }

  /**
   * The DETERMINISTIC change class of a block's open pull request, for a policy decision that
   * needs it outside the merger step (the manual-merge guard).
   *
   * One VCS call, and `unknown` whenever the class cannot be established: no repository wired,
   * no PR number, a provider outage. That degradation is the whole reason this is worth a named
   * method rather than an inline `?.classify(...)`: every consumer of a class MUST treat
   * `unknown` as inert, and a call site that reached for the classification directly would be
   * one `??` away from reading an outage as a policy verdict.
   *
   * Deliberately re-classifies rather than reading the class back off the recorded merge
   * decision: a decision row is not guaranteed to exist on every path that reaches the merge
   * route (a pipeline with no `merger` step raises `pipeline_complete` and records nothing).
   */
  async classifyChangeClass(workspaceId: string, block: Block): Promise<ChangeClass> {
    const svc = this.deps.mergeTrackRecord
    if (!svc) return 'unknown'
    // `classify` is best-effort by construction and already degrades to `unknown` on any fault.
    return (await svc.classify(workspaceId, block)).changeClass
  }

  /**
   * Settle the block's latest merge track record as `human_merged`, tagging the reviewer effort
   * when one was supplied. Resolved by BLOCK (not by run) because the merge controls that reach
   * here are block-scoped — a single point-read, never inside a loop.
   */
  async recordHumanMerge(
    workspaceId: string,
    blockId: string,
    reviewEffort?: ReviewEffort | null,
  ): Promise<void> {
    const svc = this.deps.mergeTrackRecord
    if (!svc) return
    try {
      const record = await svc.getLatestByBlock(workspaceId, blockId)
      if (!record || !record.executionId) return
      await svc.resolveDecision(workspaceId, record.executionId, 'human_merged', reviewEffort)
    } catch {
      // Best-effort (see the class doc).
    }
  }

  /**
   * Record that a human DECLINED to merge — they dismissed the review card rather than acting on
   * it. The counterpart of {@link recordHumanMerge}: without it a class's rollup would leave
   * rejections as forever-`pending_review` and overstate the auto-merge-share denominator.
   */
  async recordRejection(workspaceId: string, executionId: string): Promise<void> {
    try {
      await this.deps.mergeTrackRecord?.resolveDecision(workspaceId, executionId, 'rejected')
    } catch {
      // Best-effort (see the class doc).
    }
  }
}
