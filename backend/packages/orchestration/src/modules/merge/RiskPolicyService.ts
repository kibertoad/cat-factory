import type {
  Clock,
  CreateRiskPolicyInput,
  GroupCacheHandle,
  IdGenerator,
  RiskPolicyRepository,
  RiskPolicy,
  RiskPolicyCacheValue,
  UpdateRiskPolicyInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  requireWorkspace,
  riskPolicyFromSeed,
  riskPolicySeedRows,
  seedRiskPolicies,
  ValidationError,
} from '@cat-factory/kernel'

export interface RiskPolicyServiceDependencies {
  riskPolicyRepository: RiskPolicyRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Optional: the {@link AppCaches.riskPolicy} slice the engine reads a task's resolved preset
   * through. Every write below invalidates the workspace group so a preset edit is visible on the
   * very next gate evaluation. Absent → the engine reads live (tests / no cache wired).
   */
  riskPolicyCache?: GroupCacheHandle<RiskPolicyCacheValue>
}

/**
 * CRUD for a workspace's merge threshold presets (the library a task picks its auto-merge policy
 * from). Maintains the invariant that a workspace always has at least one preset, exactly one of
 * which is the default: the built-in catalog ({@link seedRiskPolicies}) is written when the board
 * is CREATED, `ensureSeeded` repairs a board that predates that, and the default cannot be
 * deleted. The single-default promotion is enforced in the repository. {@link reseed} restores a
 * built-in to the current catalog (adopting an update, repairing drift, or materialising a NEW
 * built-in that appeared after the workspace was created).
 */
export class RiskPolicyService {
  private readonly presets: RiskPolicyRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly cache?: GroupCacheHandle<RiskPolicyCacheValue>

  constructor(deps: RiskPolicyServiceDependencies) {
    this.presets = deps.riskPolicyRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.cache = deps.riskPolicyCache
  }

  /**
   * Drop the workspace's cached preset library after a write commits. Coarse (one group == one
   * workspace) because a write can flip which preset is the default, so a single edit's blast
   * radius is the whole library — over-invalidation is always safe (CLAUDE.md caching rule).
   */
  private async invalidate(workspaceId: string): Promise<void> {
    await this.cache?.invalidateGroup(workspaceId)
  }

  /** List a workspace's presets, repairing an empty library first (see `ensureSeeded`). */
  async list(workspaceId: string): Promise<RiskPolicy[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.ensureSeeded(workspaceId)
    return this.presets.list(workspaceId)
  }

  /** Create a new preset. The first one (or one flagged default) becomes the default. */
  async create(workspaceId: string, input: CreateRiskPolicyInput): Promise<RiskPolicy> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.list(workspaceId)
    const preset: RiskPolicy = {
      id: this.idGenerator.next('mp'),
      name: input.name,
      maxComplexity: input.maxComplexity,
      maxRisk: input.maxRisk,
      maxImpact: input.maxImpact,
      ciMaxAttempts: input.ciMaxAttempts,
      maxRequirementIterations: input.maxRequirementIterations,
      maxRequirementConcernAllowed: input.maxRequirementConcernAllowed,
      maxTesterQualityIterations: input.maxTesterQualityIterations,
      releaseWatchWindowMinutes: input.releaseWatchWindowMinutes,
      releaseMaxAttempts: input.releaseMaxAttempts,
      humanReviewGraceMinutes: input.humanReviewGraceMinutes,
      judgeMinScore: input.judgeMinScore,
      judgeMaxBounces: input.judgeMaxBounces,
      autoMergeEnabled: input.autoMergeEnabled,
      forkDecision: input.forkDecision ?? null,
      classRules: input.classRules,
      classRulesByRole: input.classRulesByRole,
      dryRunRoles: input.dryRunRoles,
      submissionClassesByRole: input.submissionClassesByRole,
      autonomy: input.autonomy,
      // The very first preset must be BOTH defaults; otherwise honour the request. A workspace
      // with exactly one policy has no other row either scope could resolve, and a scope with no
      // default falls through to `FALLBACK_RISK_POLICY`, which merges nothing: the empty-library
      // case must not leave a workspace unable to land anything through one of its two doors.
      isDefault: existing.length === 0 ? true : input.isDefault,
      isUnattendedDefault: existing.length === 0 ? true : input.isUnattendedDefault,
      createdAt: this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    await this.invalidate(workspaceId)
    return preset
  }

  /** Patch a preset. Demoting the only default is rejected (one must remain). */
  async update(workspaceId: string, id: string, patch: UpdateRiskPolicyInput): Promise<RiskPolicy> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.presets.get(workspaceId, id), 'RiskPolicy', id)
    if (existing.isDefault && patch.isDefault === false) {
      throw new ConflictError('Cannot unset the default preset; promote another preset instead.')
    }
    // The same rule for the second scope, and it needs its own check rather than sharing the one
    // above: a scope left with no default resolves `FALLBACK_RISK_POLICY`, which auto-merges
    // nothing, so demoting the unattended default silently stops every API-started task landing.
    if (existing.isUnattendedDefault && patch.isUnattendedDefault === false) {
      throw new ConflictError(
        'Cannot unset the unattended default preset; promote another preset instead.',
      )
    }
    const updated: RiskPolicy = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.maxComplexity !== undefined ? { maxComplexity: patch.maxComplexity } : {}),
      ...(patch.maxRisk !== undefined ? { maxRisk: patch.maxRisk } : {}),
      ...(patch.maxImpact !== undefined ? { maxImpact: patch.maxImpact } : {}),
      ...(patch.ciMaxAttempts !== undefined ? { ciMaxAttempts: patch.ciMaxAttempts } : {}),
      ...(patch.maxRequirementIterations !== undefined
        ? { maxRequirementIterations: patch.maxRequirementIterations }
        : {}),
      ...(patch.maxRequirementConcernAllowed !== undefined
        ? { maxRequirementConcernAllowed: patch.maxRequirementConcernAllowed }
        : {}),
      ...(patch.maxTesterQualityIterations !== undefined
        ? { maxTesterQualityIterations: patch.maxTesterQualityIterations }
        : {}),
      ...(patch.releaseWatchWindowMinutes !== undefined
        ? { releaseWatchWindowMinutes: patch.releaseWatchWindowMinutes }
        : {}),
      ...(patch.releaseMaxAttempts !== undefined
        ? { releaseMaxAttempts: patch.releaseMaxAttempts }
        : {}),
      ...(patch.humanReviewGraceMinutes !== undefined
        ? { humanReviewGraceMinutes: patch.humanReviewGraceMinutes }
        : {}),
      ...(patch.judgeMinScore !== undefined ? { judgeMinScore: patch.judgeMinScore } : {}),
      ...(patch.judgeMaxBounces !== undefined ? { judgeMaxBounces: patch.judgeMaxBounces } : {}),
      ...(patch.autoMergeEnabled !== undefined ? { autoMergeEnabled: patch.autoMergeEnabled } : {}),
      ...(patch.forkDecision !== undefined ? { forkDecision: patch.forkDecision } : {}),
      // Each of the three role/class maps replaces the whole stored value rather than merging,
      // so clearing one entry is a plain omission from the submitted set (there is no "delete
      // this one key" wire shape). All three are applied here, and an editor that submits the
      // full map every save depends on it: a patch field the service drops is indistinguishable
      // from a save that worked, right up until the operator reloads the settings panel.
      ...(patch.classRules !== undefined ? { classRules: patch.classRules } : {}),
      ...(patch.classRulesByRole !== undefined ? { classRulesByRole: patch.classRulesByRole } : {}),
      ...(patch.dryRunRoles !== undefined ? { dryRunRoles: patch.dryRunRoles } : {}),
      ...(patch.submissionClassesByRole !== undefined
        ? { submissionClassesByRole: patch.submissionClassesByRole }
        : {}),
      ...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
      ...(patch.isUnattendedDefault !== undefined
        ? { isUnattendedDefault: patch.isUnattendedDefault }
        : {}),
    }
    await this.presets.upsert(workspaceId, updated)
    await this.invalidate(workspaceId)
    return updated
  }

  /** Remove a preset. Neither scope's default preset can be removed. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.get(workspaceId, id)
    if (existing?.isDefault) {
      throw new ConflictError('Cannot delete the default preset; promote another preset first.')
    }
    if (existing?.isUnattendedDefault) {
      throw new ConflictError(
        'Cannot delete the unattended default preset; promote another preset first.',
      )
    }
    await this.presets.remove(workspaceId, id)
    await this.invalidate(workspaceId)
  }

  /**
   * Restore a built-in preset to its current catalog definition ({@link seedRiskPolicies}).
   * Used to adopt an improved built-in, repair one whose persisted copy drifted, or
   * materialise a NEW built-in that appeared after this workspace was seeded (so it has the
   * old presets but not the new one). The canonical thresholds / `autoMergeEnabled` / `version`
   * overwrite (or create) the stored row; an existing copy's `isDefault` + `createdAt` are
   * preserved so reseeding never silently changes which preset is the default or its ordering.
   * When re-materialising a built-in the workspace had deleted, it only (re)claims the default
   * if the workspace currently has none, so reseeding a default-flagged built-in (e.g.
   * `mp_balanced`) can never steal the default away from the user's chosen preset.
   * Rejects an id not in the catalog (a custom preset — delete it instead).
   */
  async reseed(workspaceId: string, id: string): Promise<RiskPolicy> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const seed = seedRiskPolicies().find((p) => p.id === id)
    if (!seed) {
      throw new ValidationError(
        `Risk policy '${id}' is not a built-in (or is no longer in the catalog), so it cannot be reseeded. Delete it instead.`,
      )
    }
    const existing = await this.presets.get(workspaceId, id)
    // Keep the user's default choice when the preset already exists. When re-creating a
    // deleted built-in, only let it reclaim default if the workspace has none right now;
    // otherwise the seed's `isDefault` would silently demote the user's chosen default.
    const isDefault = existing
      ? existing.isDefault
      : seed.isDefault && (await this.presets.getDefault(workspaceId, 'interactive')) === null
    // The same rule per scope, asked separately: a workspace can have an in-app default and no
    // unattended one (its library predates the unattended scope), and re-materialising
    // `mp_unattended` there SHOULD claim the empty scope while still not touching the other.
    const isUnattendedDefault = existing
      ? existing.isUnattendedDefault
      : seed.isUnattendedDefault &&
        (await this.presets.getDefault(workspaceId, 'unattended')) === null
    const preset: RiskPolicy = {
      ...riskPolicyFromSeed(seed, existing?.createdAt ?? this.clock.now()),
      isDefault,
      isUnattendedDefault,
    }
    await this.presets.upsert(workspaceId, preset)
    await this.invalidate(workspaceId)
    return preset
  }

  /**
   * REPAIR a workspace whose preset library is empty, by writing the built-in catalog.
   *
   * Creating a board is what normally seeds the library ({@link WorkspaceService.create}), and
   * that is where the invariant belongs: the engine resolves a task's governing preset without
   * listing anything, so a library that only existed once somebody had READ it made the merge
   * posture of an identical run depend on whether a board had been opened.
   *
   * This stays as the repair for the two states creation cannot reach backwards into: a board
   * made before creation seeded presets, and one whose facade wired the preset repository only
   * later. Both currently resolve `FALLBACK_RISK_POLICY`, which auto-merges nothing, so the
   * repair can only move a workspace from refusing everything to its configured default.
   * Idempotent, and a no-op on every board created since.
   */
  private async ensureSeeded(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    for (const preset of riskPolicySeedRows(this.clock.now())) {
      await this.presets.upsert(workspaceId, preset)
    }
    // A gate that resolved before the repair cached the null default; drop it so the
    // freshly-seeded default (not the built-in fallback) is read on the very next evaluation.
    await this.invalidate(workspaceId)
  }
}
