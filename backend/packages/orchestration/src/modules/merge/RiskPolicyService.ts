import type {
  Clock,
  CloneRiskPolicyInput,
  CreateRiskPolicyInput,
  GroupCacheHandle,
  IdGenerator,
  RiskPolicyRepository,
  RiskPolicy,
  RiskPolicyCacheValue,
  RiskPolicyLibraryEntry,
  RiskPolicySuppression,
  RiskPolicySuppressionRepository,
  UpdateRiskPolicyInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  NotFoundError,
  requireWorkspace,
  riskPolicyFromSeed,
  riskPolicySeedRows,
  seedRiskPolicies,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'
import type { WorkspaceRiskPolicyLibrary } from './WorkspaceRiskPolicyLibrary.js'

export interface RiskPolicyServiceDependencies {
  riskPolicyRepository: RiskPolicyRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The board's merged library (ADR 0055): its own rows plus the account policies it inherits.
   * Every READ below answers from it, so the editor lists exactly what the engine will resolve.
   * Absent ⇒ the workspace tier alone, which is what a facade with no account tier wired sees.
   */
  library?: WorkspaceRiskPolicyLibrary
  /**
   * Which inherited policies the board hides. Absent ⇒ suppression is unavailable, and the routes
   * that need it refuse rather than reporting a hide that was never stored.
   */
  riskPolicySuppressionRepository?: RiskPolicySuppressionRepository
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
 * is CREATED, {@link seedOwnTier} repairs a board that predates that, and the default cannot be
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
  private readonly library?: WorkspaceRiskPolicyLibrary
  private readonly suppressions?: RiskPolicySuppressionRepository

  constructor(deps: RiskPolicyServiceDependencies) {
    this.presets = deps.riskPolicyRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.cache = deps.riskPolicyCache
    this.library = deps.library
    this.suppressions = deps.riskPolicySuppressionRepository
  }

  /**
   * Drop the workspace's cached preset library after a write commits. Coarse (one group == one
   * workspace) because a write can flip which preset is the default, so a single edit's blast
   * radius is the whole library — over-invalidation is always safe (CLAUDE.md caching rule).
   */
  private async invalidate(workspaceId: string): Promise<void> {
    await this.cache?.invalidateGroup(workspaceId)
  }

  /**
   * The board's visible library, repairing an empty own-tier on the way (see {@link seedOwnTier}):
   * its own policies plus the account policies it inherits, each tagged with the tier that owns it.
   *
   * The MERGED view rather than the board's rows, because this list feeds the settings editor, the
   * snapshot and therefore every picker — and the engine resolves a pin through the same merge. A
   * read that showed only local rows would hide postures a task can legitimately be filed against.
   *
   * The seeding CHECK is read out of the merged list rather than made as its own query: an entry
   * tagged `workspace` is a row the board owns, so its presence answers "has this tier been
   * materialised" exactly. Asking separately made this — the board SNAPSHOT's read, the hottest in
   * the app — pay a full own-tier list before the merge that lists the same rows again.
   */
  async list(workspaceId: string): Promise<RiskPolicyLibraryEntry[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    if (!this.library) {
      const own = await this.presets.list(workspaceId)
      if (own.length > 0) return own.map(ownEntry)
      await this.seedOwnTier(workspaceId)
      return (await this.presets.list(workspaceId)).map(ownEntry)
    }
    const merged = await this.library.list(workspaceId)
    if (merged.some((entry) => entry.tier === 'workspace')) return merged
    // Only ever the two states creation cannot reach backwards into, so the re-read costs nothing
    // on any board made since.
    await this.seedOwnTier(workspaceId)
    return this.library.list(workspaceId)
  }

  /**
   * Copy an inherited ACCOUNT policy into this board's own tier, under a FRESH id.
   *
   * The fresh id is the whole design (see `cloneRiskPolicySchema`): an override sharing the account
   * id would re-point every task already filed against the account's posture the moment the board
   * edited its copy. The copy claims neither default — promoting it is a separate, deliberate act,
   * and a clone that silently became the board's default would change how every unpinned task lands.
   *
   * Refuses an id the board already owns (`risk_policy_not_inherited`): that is a duplicate, not a
   * clone, and the two need different copy.
   */
  async clone(
    workspaceId: string,
    presetId: string,
    input: CloneRiskPolicyInput,
  ): Promise<RiskPolicyLibraryEntry> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    // The whole own tier in ONE read, because both questions below are about it: whether this id is
    // already the board's, and whether the board holds anything at all.
    const existing = await this.presets.list(workspaceId)
    if (existing.some((policy) => policy.id === presetId)) {
      throw new ConflictError(
        `Risk policy '${presetId}' already belongs to this board, so there is nothing to clone in.`,
        'risk_policy_not_inherited',
        { presetId },
      )
    }
    const source = await this.requireInherited(workspaceId, presetId)
    // The FIRST own policy must claim both defaults, exactly as in `create` and for the same reason:
    // a scope with no default resolves `FALLBACK_RISK_POLICY`, which merges nothing. A board whose
    // own tier was never materialised (the population {@link seedOwnTier} repairs) can reach this as
    // its first own row, and hard-coding false there left it holding a library it could land nothing
    // through, with no badge on screen and nothing explaining why.
    const isFirstOwnPolicy = existing.length === 0
    const preset: RiskPolicy = {
      ...source,
      id: this.idGenerator.next('mp'),
      name: input.name ?? source.name,
      // A CLONE is a new policy, never a reseedable built-in: dropping the catalog version is what
      // stops the copy of an account policy that happens to carry a built-in id being offered a
      // reseed that would overwrite it with catalog values it never came from.
      version: undefined,
      isDefault: isFirstOwnPolicy,
      isUnattendedDefault: isFirstOwnPolicy,
      createdAt: this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    await this.invalidate(workspaceId)
    return ownEntry(preset)
  }

  /**
   * HIDE an inherited account policy from this board: it leaves the merged library, so no task here
   * can pin it and no picker offers it.
   *
   * A task that ALREADY pinned it falls back to the board's default for its scope, which is exactly
   * what a deleted local policy does (`resolveRiskPolicy` documents the dangling pin). The two acts
   * are deliberately alike: hiding is the opt-out a board has for a row it cannot delete.
   *
   * Refuses an id the board owns (`risk_policy_not_inherited`) — delete that instead — and an id
   * nothing inherits, which would otherwise write a suppression that shadows nothing today and
   * silently swallows whatever the account defines under it tomorrow.
   */
  async suppress(workspaceId: string, presetId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const { suppressions, library } = this.requireSuppressionSupport()
    const own = await this.presets.get(workspaceId, presetId)
    if (own) {
      throw new ConflictError(
        `Risk policy '${presetId}' belongs to this board, so hiding it would only be an obscure way to delete it.`,
        'risk_policy_not_inherited',
        { presetId },
      )
    }
    // What the ACCOUNT defines, not what this board currently inherits: hiding is idempotent, and
    // asking the suppression-aware question would 404 the second click on the grounds that the first
    // one worked.
    if (!(await library.accountPolicy(workspaceId, presetId))) {
      throw new NotFoundError('RiskPolicy', presetId)
    }
    await suppressions.add(workspaceId, presetId, this.clock.now())
    await this.invalidate(workspaceId)
  }

  /**
   * Stop hiding an inherited policy, so the board offers it again.
   *
   * Deliberately permissive about what it lifts: a suppression whose account policy has since been
   * withdrawn hides nothing, and clearing it is still the right answer (it is listed, so it has to
   * be dismissable). The refusal that matters is the one above, at the moment the row is written.
   */
  async restoreInherited(workspaceId: string, presetId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const { suppressions } = this.requireSuppressionSupport()
    await suppressions.remove(workspaceId, presetId)
    await this.invalidate(workspaceId)
  }

  /**
   * What this board is hiding, and whether each suppression still shadows anything.
   *
   * Gated on the same store the WRITES are, so an unwired facade REFUSES here rather than answering
   * an empty list: "this board hides nothing" and "this deployment cannot say what it hides" are
   * different facts, and only the refusal states the second one (CLAUDE.md's absent-≠-zero rule).
   * Answering `[]` positively claimed the first while the very next `suppress` returned a 503.
   */
  async listSuppressions(workspaceId: string): Promise<RiskPolicySuppression[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const { library } = this.requireSuppressionSupport()
    return library.listSuppressions(workspaceId)
  }

  /**
   * The account policy this board INHERITS under an id, or a 404.
   *
   * Suppression-aware (see `WorkspaceRiskPolicyLibrary.inheritedPolicy`), so the three states that
   * are not "the board may clone this" collapse into one refusal: nothing defines the id, the
   * account withdrew it, or this board hid it. Cloning is the only caller, and none of the three
   * leaves it anything to copy — a board that opted out of a posture asking for a copy of it is a
   * stale screen, not a request to honour.
   */
  private async requireInherited(workspaceId: string, presetId: string) {
    const inherited = await this.library?.inheritedPolicy(workspaceId, presetId)
    if (!inherited) throw new NotFoundError('RiskPolicy', presetId)
    return inherited
  }

  /**
   * Everything hiding takes: the suppression store AND the merged library that names what it holds,
   * or a 503 naming what is not wired.
   *
   * A total accessor rather than a silent no-op: reporting success for a hide that was never stored
   * would leave the operator looking at a policy they had just been told was hidden. Both halves are
   * checked together, and the reads gate on it as well as the writes, so no caller can end up
   * answering from one of the two while the other is missing.
   */
  private requireSuppressionSupport(): {
    suppressions: RiskPolicySuppressionRepository
    library: WorkspaceRiskPolicyLibrary
  } {
    if (!this.suppressions || !this.library) {
      // Its OWN reason rather than the `risk_policies_unwired` the pin guard raises: the policies
      // ARE configured here, and sending an operator to wire a library they can already see would
      // be the misattribution that reason exists to avoid.
      throw new UnavailableError(
        'Hiding an inherited risk policy is not configured',
        'risk_policy_suppressions_unwired',
      )
    }
    return { suppressions: this.suppressions, library: this.library }
  }

  /** Create a new preset. The first one (or one flagged default) becomes the default. */
  async create(workspaceId: string, input: CreateRiskPolicyInput): Promise<RiskPolicyLibraryEntry> {
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
      companionMaxReworks: input.companionMaxReworks,
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
      minAutoAnswerConfidence: input.minAutoAnswerConfidence,
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
    return ownEntry(preset)
  }

  /** Patch a preset. Demoting the only default is rejected (one must remain). */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateRiskPolicyInput,
  ): Promise<RiskPolicyLibraryEntry> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const own = await this.presets.get(workspaceId, id)
    await this.assertNotInherited(workspaceId, id, own)
    const existing = assertFound(own, 'RiskPolicy', id)
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
      ...(patch.companionMaxReworks !== undefined
        ? { companionMaxReworks: patch.companionMaxReworks }
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
      ...(patch.minAutoAnswerConfidence !== undefined
        ? { minAutoAnswerConfidence: patch.minAutoAnswerConfidence }
        : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
      ...(patch.isUnattendedDefault !== undefined
        ? { isUnattendedDefault: patch.isUnattendedDefault }
        : {}),
    }
    await this.presets.upsert(workspaceId, updated)
    await this.invalidate(workspaceId)
    return ownEntry(updated)
  }

  /** Remove a preset. Neither scope's default preset can be removed. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.get(workspaceId, id)
    await this.assertNotInherited(workspaceId, id, existing)
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
  async reseed(workspaceId: string, id: string): Promise<RiskPolicyLibraryEntry> {
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
    return ownEntry(preset)
  }

  /**
   * Refuse a write aimed at a policy the ACCOUNT owns, naming the remedy (`risk_policy_inherited`).
   *
   * Checked BEFORE the board's own row is read, because the two failures need different copy and the
   * bare 404 the read would produce is the misleading one: an inherited policy is visible in the
   * board's editor and in every picker, so "no such policy" reads as a bug in the app rather than as
   * "this one is not yours to change". The clone action is what leaves the board a row it can edit.
   *
   * Silent when no account tier is wired: there is nothing to inherit, so the caller's own 404 is
   * then the honest answer.
   *
   * Takes the board's own row rather than re-reading it. The caller needs that row anyway (to patch,
   * or to check the default flags before deleting), and the guard needs only to know whether it
   * exists, so reading it here made every policy edit and delete pay two identical point queries.
   */
  private async assertNotInherited(
    workspaceId: string,
    id: string,
    own: RiskPolicy | null,
  ): Promise<void> {
    if (own) return
    const inherited = await this.library?.inheritedPolicy(workspaceId, id)
    if (!inherited) return
    throw new ConflictError(
      `Risk policy '${id}' is defined by the account, so this board cannot change it. Clone it to edit a copy here.`,
      'risk_policy_inherited',
      { presetId: id },
    )
  }

  /**
   * REPAIR a workspace whose own preset tier is empty, by writing the built-in catalog.
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
   *
   * The emptiness TEST belongs to the caller, which has just read the library and therefore already
   * knows the answer; this only writes.
   */
  private async seedOwnTier(workspaceId: string): Promise<void> {
    for (const preset of riskPolicySeedRows(this.clock.now())) {
      await this.presets.upsert(workspaceId, preset)
    }
    // A gate that resolved before the repair cached the null default; drop it so the
    // freshly-seeded default (not the built-in fallback) is read on the very next evaluation.
    await this.invalidate(workspaceId)
  }
}

/**
 * A row this board OWNS → the library entry the wire carries.
 *
 * Every write on this service lands in the workspace tier by construction, so the tier is stated
 * here rather than re-derived: a response that echoed a just-written policy without it would leave
 * the SPA upserting an untagged row into a tier-tagged list, and the editor would render the board's
 * own new policy with the inherited tier's read-only affordances until the next full reload.
 */
function ownEntry(preset: RiskPolicy): RiskPolicyLibraryEntry {
  return { ...preset, tier: 'workspace' }
}
