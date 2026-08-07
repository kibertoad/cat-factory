import type {
  Block,
  ChangeClass,
  Clock,
  MergeAssessment,
  MergeClassRollup,
  MergeTrackDecision,
  MergeTrackRecord,
  MergeTrackRecordRepository,
  ResolveRunRepoContext,
  ReviewEffort,
  VcsProvider,
  WorkspaceRepository,
  Logger,
} from '@cat-factory/kernel'
import { CHANGE_CLASSES, emptyMergeClassRollup } from '@cat-factory/contracts'
import {
  assertFound,
  classifyChangedFiles,
  describeError,
  noopLogger,
  requireWorkspace,
} from '@cat-factory/kernel'

/** The repo identity a record carries, in the provider-neutral VCS vocabulary. */
export interface MergeTrackRepoRef {
  repoId?: string | null
  provider?: VcsProvider | null
}

/** Everything the merge path knows at the moment a merger step's decision is made. */
export interface RecordMergeDecisionInput {
  block: Block
  executionId: string
  decision: MergeTrackDecision
  /** The merger's scores, when it produced a parseable assessment. */
  assessment?: MergeAssessment | null
  /** The preset the decision was made against (its id is absent for the built-in fallback). */
  riskPolicyId?: string | null
  riskPolicyName?: string | null
  /**
   * The pre-computed classification, when the caller already ran it (the merge resolver needs
   * the class BEFORE it decides, so it classifies first and passes the result down rather than
   * paying for a second VCS call). It carries the run's repo identity too, so the record is
   * attributable without a second resolution — see {@link RunClassification}.
   */
  classification?: RunClassification
  /** Explicit override for the repo identity; normally it rides `classification`. */
  repo?: MergeTrackRepoRef
}

/**
 * What classifying a run's pull request yields: the change class, how many files it covered,
 * and WHICH REPO the PR belongs to.
 *
 * The repo identity is not incidental — it is the key external-merge attribution looks a record
 * up by (`getByPullRequest(repoId, prNumber)`), because a webhook delivery knows only
 * `(repoId, prNumber)`. It is captured here because `classify` already resolves the run's repo
 * context to read the changed files, so recording it costs nothing extra; resolving it later
 * would be a second walk of the same linkage.
 */
export interface RunClassification {
  changeClass: ChangeClass
  fileCount: number
  repoId?: string | null
  provider?: VcsProvider | null
}

export interface MergeTrackRecordServiceDependencies {
  mergeTrackRecordRepository: MergeTrackRecordRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Resolve the run's repo so the changed-file list can be read (`RepoFiles.listChangedFiles`).
   * Absent (tests / no VCS connected) ⇒ classification yields `unknown`, which never matches a
   * per-class rule, so the merge policy falls back to the score thresholds untouched.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Where this side channel reports its own failures. Every method below swallows by design —
   * a track-record fault must never block a merge — which previously meant the whole feature
   * could be dead in production (a revoked token, a missing table) while every merge looked
   * healthy. Absent ⇒ `noopLogger`.
   */
  logger?: Logger
}

/**
 * The merge TRACK RECORD: one persisted row per merge decision carrying the run's
 * deterministic change class, the merger's scores, what happened, and the reviewer-effort tag a
 * human left — plus the per-class rollups that justify widening a preset's per-class rule.
 *
 * Every write here is a **best-effort side channel of the merge path**: `classify` and
 * `recordDecision` swallow their own failures and return a degraded-but-valid result, because a
 * classification or persistence fault must NEVER block or fail a merge. The read paths
 * (`rollups`, `tag`) are ordinary request-scoped operations and do throw.
 *
 * Full design: `backend/docs/adr/0046-merge-track-record.md`.
 */
export class MergeTrackRecordService {
  private readonly log: Logger

  constructor(private readonly deps: MergeTrackRecordServiceDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'mergeTrackRecord' })
  }

  /**
   * Classify a block's pull request from the files it changed — ONE VCS call, then the pure
   * `classifyChangedFiles` precedence rule (highest-ranked class present wins).
   *
   * Returns `unknown` (never throws) when there is no repo context, the bound client cannot
   * enumerate a PR's files, the block has no PR number, or the call fails. `unknown` is inert by
   * design: `resolveMergeClassRule` never matches it, so a transient VCS outage can neither
   * widen nor tighten the merge policy.
   */
  async classify(workspaceId: string, block: Block): Promise<RunClassification> {
    const absent: RunClassification = { changeClass: 'unknown', fileCount: 0 }
    const prNumber = block.pullRequest?.number
    if (prNumber == null) return absent
    // `repo` is DECLARED outside the try so the catch can still see it. The comment below
    // always claimed the identity survived an unreadable file list — but while it was bound
    // inside the try, a THROWING `listChangedFiles` (403 / 404 / rate limit: the common
    // failure, not the rare one) fell through to a bare `absent` and lost it, so
    // external-merge attribution by `(repoId, prNumber)` failed permanently for that record.
    let repo: Pick<RunClassification, 'repoId' | 'provider'> | undefined
    try {
      const ctx = await this.deps.resolveRunRepoContext?.(workspaceId, block.id)
      if (!ctx) return absent
      // Capture the repo identity even when the changed-file list is unreadable: the class then
      // degrades to `unknown` (inert by design), but the record stays ATTRIBUTABLE, so a PR later
      // merged on the provider is still matched by `(repoId, prNumber)`.
      repo = { repoId: ctx.repoId, provider: ctx.provider ?? null }
      const files = await ctx.repo.listChangedFiles?.(prNumber)
      if (!files) return { ...absent, ...repo }
      return { ...classifyChangedFiles(files.map((f) => f.path)), ...repo }
    } catch (error) {
      this.log.warn('merge classification failed; recording an unclassified row', {
        workspaceId,
        blockId: block.id,
        prNumber,
        attributable: repo !== undefined,
        ...describeError(error),
      })
      return { ...absent, ...repo }
    }
  }

  /**
   * Record a merger step's decision. Idempotent by construction: the id is derived from the
   * run (`mtr_<executionId>`) and the insert is first-write-wins, so the durable driver
   * re-resolving a step whose merge already landed cannot duplicate the row — nor clobber an
   * effort tag a human has since added.
   *
   * Returns the stored record, or null when nothing could be written (no repository, or the
   * write threw). Callers treat null as "no record" and carry on: the merge is what matters.
   */
  async recordDecision(
    workspaceId: string,
    input: RecordMergeDecisionInput,
  ): Promise<MergeTrackRecord | null> {
    try {
      const now = this.deps.clock.now()
      const classification = input.classification ?? (await this.classify(workspaceId, input.block))
      const terminal = input.decision !== 'pending_review'
      const record: MergeTrackRecord = {
        id: `mtr_${input.executionId}`,
        blockId: input.block.id,
        executionId: input.executionId,
        changeClass: classification.changeClass,
        changedFileCount: classification.fileCount > 0 ? classification.fileCount : null,
        complexity: input.assessment?.complexity ?? null,
        risk: input.assessment?.risk ?? null,
        impact: input.assessment?.impact ?? null,
        riskPolicyId: input.riskPolicyId ?? null,
        riskPolicyName: input.riskPolicyName ?? null,
        decision: input.decision,
        reviewEffort: null,
        prNumber: input.block.pullRequest?.number ?? null,
        prUrl: input.block.pullRequest?.url ?? null,
        repoId: input.repo?.repoId ?? classification.repoId ?? null,
        provider: input.repo?.provider ?? classification.provider ?? null,
        createdAt: now,
        resolvedAt: terminal ? now : null,
        taggedAt: null,
      }
      return await this.deps.mergeTrackRecordRepository.insertIfAbsent(workspaceId, record)
    } catch (error) {
      this.log.warn('merge track record write failed; the merge itself is unaffected', {
        workspaceId,
        executionId: input.executionId,
        blockId: input.block.id,
        ...describeError(error),
      })
      return null
    }
  }

  /**
   * Settle a record that was left `pending_review` once a human resolved it — merged it through
   * cat-factory, merged it on the provider, or declined. Optionally tags the review effort in
   * the same write (the merge card's one-tap confirm-and-tag).
   *
   * Best-effort and silent: a run with no record (classification never ran, or the merge came
   * from a pipeline with no `merger` step) is simply skipped. Returns the record's id when one
   * was updated, so a caller can put it on a notification payload.
   *
   * Only a still-`pending_review` record is SETTLED here, mirroring {@link recordExternalMerge}:
   * a landed PR must never be re-decided by a late action on a stale card. The concrete case is
   * a PR merged on the provider (recorded `external_merged`) whose merge-review card is then
   * dismissed — without this guard that dismissal would rewrite a merged PR as `rejected` and
   * corrupt the very rollup the record exists to produce. A later EFFORT TAG is still applied,
   * because tagging is orthogonal to the decision and is welcome whenever it arrives.
   */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decision: Exclude<MergeTrackDecision, 'pending_review'>,
    reviewEffort?: ReviewEffort | null,
  ): Promise<string | null> {
    try {
      const existing = await this.deps.mergeTrackRecordRepository.getByExecution(
        workspaceId,
        executionId,
      )
      if (!existing) return null
      const now = this.deps.clock.now()
      const settled = existing.decision !== 'pending_review'
      const tag =
        reviewEffort !== undefined ? { reviewEffort, taggedAt: reviewEffort ? now : null } : {}
      if (settled && Object.keys(tag).length === 0) return existing.id
      await this.deps.mergeTrackRecordRepository.patch(workspaceId, existing.id, {
        // An already-terminal decision stands; only the tag is folded in.
        ...(settled ? {} : { decision, resolvedAt: now }),
        ...tag,
      })
      return existing.id
    } catch (error) {
      this.log.warn('merge track record resolve failed', {
        workspaceId,
        executionId,
        decision,
        ...describeError(error),
      })
      return null
    }
  }

  /**
   * Attribute an EXTERNAL merge: a human merged a PR directly on the VCS provider, bypassing
   * cat-factory's merge card. Looks the record up by `(repoId, prNumber)` — which a merger-step
   * record already carries — so no unindexed scan of the blocks' JSON PR column is needed, and
   * the feature is correctly scoped to PRs cat-factory opened and was waiting on.
   *
   * Returns the settled record when this delivery is the one that flipped it (so the caller
   * raises exactly ONE tag-request nudge), and null when there is nothing to attribute or the
   * record was already resolved — webhook deliveries are re-sent, so this must be idempotent.
   */
  async recordExternalMerge(
    workspaceId: string,
    repoId: string,
    prNumber: number,
  ): Promise<MergeTrackRecord | null> {
    try {
      const existing = await this.deps.mergeTrackRecordRepository.getByPullRequest(
        workspaceId,
        repoId,
        prNumber,
      )
      // Only a still-pending record is attributable. An already-resolved one either merged
      // through cat-factory (this delivery is the echo of our own merge) or was already
      // attributed by an earlier redelivery.
      if (!existing || existing.decision !== 'pending_review') return null
      const now = this.deps.clock.now()
      await this.deps.mergeTrackRecordRepository.patch(workspaceId, existing.id, {
        decision: 'external_merged',
        resolvedAt: now,
      })
      return { ...existing, decision: 'external_merged', resolvedAt: now }
    } catch (error) {
      this.log.warn('external merge attribution failed', {
        workspaceId,
        repoId,
        prNumber,
        ...describeError(error),
      })
      return null
    }
  }

  /** A record by id (for the tag surface and the notification card's context). */
  async get(workspaceId: string, id: string): Promise<MergeTrackRecord | null> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return this.deps.mergeTrackRecordRepository.get(workspaceId, id)
  }

  /** The most recent record for a block — the seam the block-scoped merge controls tag through. */
  async getLatestByBlock(workspaceId: string, blockId: string): Promise<MergeTrackRecord | null> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return this.deps.mergeTrackRecordRepository.getLatestByBlock(workspaceId, blockId)
  }

  /**
   * Tag (or clear) how much review effort a human spent. Unlike the write paths above this is a
   * deliberate user action, so an unknown id is a real 404 rather than a silent skip.
   */
  async tag(
    workspaceId: string,
    id: string,
    reviewEffort: ReviewEffort | null,
  ): Promise<MergeTrackRecord> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const existing = assertFound(
      await this.deps.mergeTrackRecordRepository.get(workspaceId, id),
      'MergeTrackRecord',
      id,
    )
    const taggedAt = reviewEffort ? this.deps.clock.now() : null
    await this.deps.mergeTrackRecordRepository.patch(workspaceId, id, { reviewEffort, taggedAt })
    return { ...existing, reviewEffort, taggedAt }
  }

  /**
   * Per-change-class rollups for the workspace: ONE SQL aggregate, then every class the query
   * returned nothing for is filled in as an empty rollup so the caller always gets the full,
   * stably-ordered set (the preset editor renders a row per class whether or not it has data).
   */
  async rollups(workspaceId: string): Promise<MergeClassRollup[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const rows = await this.deps.mergeTrackRecordRepository.rollupByClass(workspaceId)
    const byClass = new Map(rows.map((r) => [r.changeClass, r]))
    return CHANGE_CLASSES.map((c) => byClass.get(c) ?? emptyMergeClassRollup(c))
  }
}
