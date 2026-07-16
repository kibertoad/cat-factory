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
  seedRiskPolicies,
  ValidationError,
} from '@cat-factory/kernel'
import type { RiskPolicySeed } from '@cat-factory/kernel'

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
 * CRUD for a workspace's merge threshold presets (the library a task picks its
 * auto-merge policy from). Maintains the invariant that a workspace always has at
 * least one preset, exactly one of which is the default: {@link list} lazily seeds
 * the built-in catalog ({@link seedRiskPolicies}) on first use, and the default cannot
 * be deleted. The single-default promotion is enforced in the repository. {@link reseed}
 * restores a built-in to the current catalog (adopting an update, repairing drift, or
 * materialising a NEW built-in that appeared after the workspace was created).
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

  /** List a workspace's presets, seeding the built-in catalog if none exist yet. */
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
      autoMergeEnabled: input.autoMergeEnabled,
      forkDecision: input.forkDecision ?? null,
      // The very first preset must be the default; otherwise honour the request.
      isDefault: existing.length === 0 ? true : input.isDefault,
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
      ...(patch.autoMergeEnabled !== undefined ? { autoMergeEnabled: patch.autoMergeEnabled } : {}),
      ...(patch.forkDecision !== undefined ? { forkDecision: patch.forkDecision } : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
    }
    await this.presets.upsert(workspaceId, updated)
    await this.invalidate(workspaceId)
    return updated
  }

  /** Remove a preset. The default preset cannot be removed. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.get(workspaceId, id)
    if (existing?.isDefault) {
      throw new ConflictError('Cannot delete the default preset; promote another preset first.')
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
      : seed.isDefault && (await this.presets.getDefault(workspaceId)) === null
    const preset: RiskPolicy = {
      ...this.fromSeed(seed),
      isDefault,
      createdAt: existing?.createdAt ?? this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    await this.invalidate(workspaceId)
    return preset
  }

  /** Seed the built-in preset catalog for a workspace that has none yet. Idempotent. */
  private async ensureSeeded(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    const now = this.clock.now()
    // Stamp createdAt by catalog order so `list` (ordered by created_at) preserves it.
    let offset = 0
    for (const seed of seedRiskPolicies()) {
      await this.presets.upsert(workspaceId, {
        ...this.fromSeed(seed),
        createdAt: now + offset++,
      })
    }
    // A gate that resolved before first-use seeding cached the null default; drop it so the
    // freshly-seeded default (not the built-in fallback) is read on the very next evaluation.
    await this.invalidate(workspaceId)
  }

  /** A catalog seed as a persisted preset (its stable id + version, without `createdAt`). */
  private fromSeed(seed: RiskPolicySeed): Omit<RiskPolicy, 'createdAt'> {
    return {
      id: seed.id,
      name: seed.name,
      maxComplexity: seed.maxComplexity,
      maxRisk: seed.maxRisk,
      maxImpact: seed.maxImpact,
      ciMaxAttempts: seed.ciMaxAttempts,
      maxRequirementIterations: seed.maxRequirementIterations,
      maxRequirementConcernAllowed: seed.maxRequirementConcernAllowed,
      maxTesterQualityIterations: seed.maxTesterQualityIterations,
      releaseWatchWindowMinutes: seed.releaseWatchWindowMinutes,
      releaseMaxAttempts: seed.releaseMaxAttempts,
      humanReviewGraceMinutes: seed.humanReviewGraceMinutes,
      autoMergeEnabled: seed.autoMergeEnabled,
      forkDecision: seed.forkDecision,
      isDefault: seed.isDefault,
      version: seed.version,
    }
  }
}
