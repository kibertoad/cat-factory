import type {
  AcceptanceCriterionRecord,
  AcceptanceCriterionRepository,
  BlockRepository,
  Clock,
  IdGenerator,
} from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import type {
  ServiceAcceptanceCriterion,
  AcceptanceCriterionDraft,
  CreateAcceptanceCriterionInput,
  ResolvedAcceptanceCriteria,
  ServiceAcceptanceCriteria,
  UpdateAcceptanceCriterionInput,
} from '@cat-factory/contracts'
import {
  ACCEPTANCE_CRITERIA_MAX_PER_EXTRACTION,
  ACCEPTANCE_CRITERIA_MAX_PER_FRAME,
  normalizeCriterionTitle,
} from '@cat-factory/contracts'

export interface AcceptanceCriteriaServiceDependencies {
  acceptanceCriterionRepository: AcceptanceCriterionRepository
  /** Reads the target block so a write can reject a non-frame (criteria are keyed by frame). */
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * Owns a service's ACCEPTANCE CRITERIA — the durable given/when/outcome statements of required
 * behaviour a service accumulates (see `docs/initiatives/acceptance-criteria-store.md`).
 *
 * Three surfaces, deliberately separated:
 *  - CRUD ({@link listForFrame} / {@link create} / {@link update} / {@link deleteCriterion}) —
 *    the service inspector's editing + triage, operating on the exact SERVICE FRAME block.
 *  - RESOLUTION ({@link resolveForFrame}) — the SINGLE seam a dispatch resolves criteria
 *    through, returning only the CONFIRMED ones. Adding a second source later (a checked-in
 *    `acceptance/*.md` manifest, say) is a change inside that method, not a new path through
 *    the engine.
 *  - ACCRETION ({@link recordDerived}) — the write the engine's post-review extraction hook
 *    uses. It only ever adds `proposed` rows, never mutates a human's decision.
 *
 * Nothing here is secret: criteria are product knowledge a member curates, which is also why
 * the controller above it carries no admin permission gate (the RBAC viewer write floor is the
 * whole authorization story).
 */
export class AcceptanceCriteriaService {
  private readonly repo: AcceptanceCriterionRepository
  private readonly blocks: BlockRepository
  private readonly ids: IdGenerator
  private readonly clock: Clock

  constructor(deps: AcceptanceCriteriaServiceDependencies) {
    this.repo = deps.acceptanceCriterionRepository
    this.blocks = deps.blockRepository
    this.ids = deps.idGenerator
    this.clock = deps.clock
  }

  /** The criteria configured for a service frame (an empty list when it has none). */
  async listForFrame(workspaceId: string, blockId: string): Promise<ServiceAcceptanceCriteria> {
    // The batch read even for one frame: one code path, and no temptation to grow a
    // point-read-per-frame caller later.
    const rows = await this.repo.listByFrameBlocks(workspaceId, [blockId])
    return { blockId, criteria: rows.map(toView) }
  }

  /** Every service frame's criteria in the workspace, grouped by frame (the store's hydrate). */
  async list(workspaceId: string): Promise<ServiceAcceptanceCriteria[]> {
    const rows = await this.repo.listByWorkspace(workspaceId)
    const byBlock = new Map<string, ServiceAcceptanceCriterion[]>()
    for (const row of rows) {
      const list = byBlock.get(row.blockId)
      if (list) list.push(toView(row))
      else byBlock.set(row.blockId, [toView(row)])
    }
    return [...byBlock].map(([blockId, criteria]) => ({ blockId, criteria }))
  }

  /**
   * Add a criterion to a service frame by hand.
   *
   * Rejects a non-frame block for the same reason the validation-check store does: resolution
   * only ever walks UP to the service frame, so a criterion stored on a module/task would look
   * saved and then silently never reach a prompt.
   */
  async create(
    workspaceId: string,
    blockId: string,
    input: CreateAcceptanceCriterionInput,
  ): Promise<ServiceAcceptanceCriterion> {
    const block = await this.blocks.get(workspaceId, blockId)
    if (!block) throw new NotFoundError('block', blockId)
    if (block.level !== 'frame') {
      throw new ValidationError('Acceptance criteria can only be set on a service frame')
    }
    const existing = await this.repo.listByFrameBlocks(workspaceId, [blockId])
    if (existing.length >= ACCEPTANCE_CRITERIA_MAX_PER_FRAME) {
      throw new ValidationError(
        `A service may hold at most ${ACCEPTANCE_CRITERIA_MAX_PER_FRAME} acceptance criteria. ` +
          'Retire the ones that no longer apply before adding more.',
      )
    }
    const now = this.clock.now()
    const record: AcceptanceCriterionRecord = {
      id: this.ids.next('ac'),
      workspaceId,
      blockId,
      title: input.title,
      given: input.given ?? '',
      when: input.when,
      outcome: input.outcome,
      tags: input.tags ?? [],
      // A human typing a criterion into the inspector has, by that act, confirmed it.
      status: input.status ?? 'confirmed',
      provenance: 'authored',
      sourceReviewId: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.repo.upsertMany([record])
    return toView(record)
  }

  /**
   * Patch a criterion. The common call is a status flip from the inspector's triage list
   * (`proposed` → `confirmed` / `retired`), which is what turns an extracted candidate into
   * something that steers agents.
   */
  async update(
    workspaceId: string,
    criterionId: string,
    input: UpdateAcceptanceCriterionInput,
  ): Promise<ServiceAcceptanceCriterion> {
    const existing = await this.repo.get(workspaceId, criterionId)
    if (!existing) throw new NotFoundError('acceptance criterion', criterionId)
    const updated: AcceptanceCriterionRecord = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.given !== undefined ? { given: input.given } : {}),
      ...(input.when !== undefined ? { when: input.when } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: this.clock.now(),
    }
    await this.repo.upsertMany([updated])
    return toView(updated)
  }

  async deleteCriterion(workspaceId: string, criterionId: string): Promise<void> {
    await this.repo.delete(workspaceId, criterionId)
  }

  /**
   * Drop every criterion on the given frames. Called by the board's delete cascade
   * (`BoardService.removeBlock`) so removing a service doesn't leave its criteria behind: the
   * rows are keyed by a block id that no longer exists, and `listByWorkspace` — the inspector's
   * hydrate read — would keep returning them forever.
   */
  async deleteForFrames(workspaceId: string, blockIds: readonly string[]): Promise<void> {
    await this.repo.deleteByBlocks(workspaceId, blockIds)
  }

  /**
   * The criteria that apply to a run dispatched against SERVICE FRAME `frameId`: the CONFIRMED
   * ones only. This is what the engine folds onto the agent run context and the prompts render.
   * `null` when the frame has none, which is what keeps an unadopting deployment byte-for-byte
   * on the old prompts.
   *
   * `proposed` is excluded on purpose. It came from a model extraction pass no human has read,
   * and a hallucinated "requirement" steering the coder would be worse than having no store at
   * all. `retired` is excluded because that is what retiring means — the row survives only so a
   * later extraction can't cheerfully re-propose it.
   *
   * Takes the frame the CALLER already resolved rather than a run block, deliberately: the
   * engine's `AgentContextBuilder` walks the frame→module→task ancestry exactly ONCE per
   * dispatch and threads the result into every frame-scoped resolver.
   */
  async resolveForFrame(
    workspaceId: string,
    frameId: string,
  ): Promise<ResolvedAcceptanceCriteria | null> {
    const rows = await this.repo.listByFrameBlocks(workspaceId, [frameId])
    const confirmed = rows.filter((row) => row.status === 'confirmed')
    if (confirmed.length === 0) return null
    return {
      criteria: confirmed.map((row) => ({
        id: row.id,
        title: row.title,
        given: row.given,
        when: row.when,
        outcome: row.outcome,
        tags: row.tags,
      })),
    }
  }

  /**
   * Whether the accretion pass has ALREADY written criteria for this `(frame, review)` pair —
   * the guard the engine consults BEFORE spending a model call on extraction.
   *
   * The marker is the rows themselves (`provenance: 'derived'` carries `sourceReviewId`), not a
   * separate claim table: the question "did this review already accrete here" has an exact answer
   * in the store, and the read is the same indexed frame read the write path performs anyway.
   */
  async hasDerivedFrom(
    workspaceId: string,
    frameId: string,
    sourceReviewId: string,
  ): Promise<boolean> {
    const rows = await this.repo.listByFrameBlocks(workspaceId, [frameId])
    return rows.some((row) => row.sourceReviewId === sourceReviewId)
  }

  /**
   * Persist criteria the ACCRETION pass extracted from a settled requirements review, as
   * `proposed` candidates awaiting a human.
   *
   * Dedupe is by NORMALISED TITLE within the frame, because every run of a similar task
   * re-extracts near-identical criteria and without it the triage list grows a duplicate per
   * run. A draft whose title matches an existing row is DROPPED rather than merged, whatever
   * that row's status: re-proposing something a human already retired is a treadmill, and
   * silently rewriting something they confirmed would let a model overwrite a human decision.
   *
   * Returns the criteria actually added (empty when everything was a duplicate, the frame is
   * full, or the drafts were unusable) so the caller can log what the pass achieved.
   */
  async recordDerived(
    workspaceId: string,
    frameId: string,
    sourceReviewId: string,
    drafts: readonly AcceptanceCriterionDraft[],
  ): Promise<ServiceAcceptanceCriterion[]> {
    const usable = drafts.filter(isUsableDraft).slice(0, ACCEPTANCE_CRITERIA_MAX_PER_EXTRACTION)
    if (usable.length === 0) return []
    const existing = await this.repo.listByFrameBlocks(workspaceId, [frameId])
    // Second line of the replay guard the engine already applies before extracting: if this
    // review has written here before, a re-entry (a replayed durable step, a retried request) must
    // add nothing, whatever the model returned the second time.
    if (existing.some((row) => row.sourceReviewId === sourceReviewId)) return []
    const seen = new Set(existing.map((row) => normalizeCriterionTitle(row.title)))
    const room = ACCEPTANCE_CRITERIA_MAX_PER_FRAME - existing.length
    if (room <= 0) return []
    const now = this.clock.now()
    const fresh: AcceptanceCriterionRecord[] = []
    for (const draft of usable) {
      if (fresh.length >= room) break
      const key = normalizeCriterionTitle(draft.title)
      // Also guards against a single extraction batch containing two drafts with the same
      // title — the model does that when a document repeats a requirement.
      if (!key || seen.has(key)) continue
      seen.add(key)
      fresh.push({
        id: this.ids.next('ac'),
        workspaceId,
        blockId: frameId,
        title: draft.title.trim(),
        given: draft.given.trim(),
        when: draft.when.trim(),
        outcome: draft.outcome.trim(),
        tags: draft.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== ''),
        status: 'proposed',
        provenance: 'derived',
        sourceReviewId,
        createdAt: now,
        updatedAt: now,
      })
    }
    if (fresh.length === 0) return []
    await this.repo.upsertMany(fresh)
    return fresh.map(toView)
  }
}

/**
 * A draft is usable only if it states a title, a trigger and an observable outcome. A criterion
 * with no `outcome` is not verifiable, so it could never earn a tester verdict or an evidence row
 * — dropping it here keeps the human's triage list free of things they can only delete.
 */
function isUsableDraft(draft: AcceptanceCriterionDraft): boolean {
  return draft.title.trim() !== '' && draft.when.trim() !== '' && draft.outcome.trim() !== ''
}

/** Project a stored record into the wire view. */
function toView(record: AcceptanceCriterionRecord): ServiceAcceptanceCriterion {
  return {
    id: record.id,
    blockId: record.blockId,
    title: record.title,
    given: record.given,
    when: record.when,
    outcome: record.outcome,
    tags: record.tags,
    status: record.status,
    provenance: record.provenance,
    sourceReviewId: record.sourceReviewId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
