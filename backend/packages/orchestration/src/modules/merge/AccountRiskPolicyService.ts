import type {
  AccountRiskPolicy,
  AccountRiskPolicyRepository,
  Clock,
  CreateRiskPolicyInput,
  GroupCacheHandle,
  IdGenerator,
  RiskPolicyCacheValue,
  RiskPolicyLibraryEntry,
  UpdateRiskPolicyInput,
} from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'

export interface AccountRiskPolicyServiceDependencies {
  accountRiskPolicyRepository: AccountRiskPolicyRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The {@link AppCaches.riskPolicy} slice every board's engine reads its resolved policy through.
   * An account write invalidates ALL of it (see {@link AccountRiskPolicyService.invalidate}).
   */
  riskPolicyCache?: GroupCacheHandle<RiskPolicyCacheValue>
}

/**
 * CRUD for an ACCOUNT's risk policy library (ADR 0055): the postures an org authors once, which
 * every board under it inherits read-only and may clone or hide.
 *
 * Three things it deliberately does NOT do, each mirroring a fact about the tier:
 *
 * - **No default claims.** `isDefault` / `isUnattendedDefault` are refused here rather than stored,
 *   because which policy governs a task that pinned none is a per-BOARD question (see
 *   `AccountRiskPolicy`). Refused loudly, not dropped: a create that silently ignored the flag would
 *   report success for a request whose whole point was to set an org-wide default.
 * - **No seeding.** The built-in catalog is copied into BOARDS at creation, so an account library
 *   starts empty and holds exactly what an admin authored. There is nothing to repair and nothing to
 *   reseed.
 * - **No suppression.** An account is the top tier here, so it inherits nothing to opt out of.
 */
export class AccountRiskPolicyService {
  constructor(private readonly deps: AccountRiskPolicyServiceDependencies) {}

  /** The account's own policies, tagged with the tier that owns them. */
  async list(accountId: string): Promise<RiskPolicyLibraryEntry[]> {
    return (await this.deps.accountRiskPolicyRepository.list(accountId)).map(accountEntry)
  }

  /** Author a new account-wide policy. */
  async create(accountId: string, input: CreateRiskPolicyInput): Promise<RiskPolicyLibraryEntry> {
    assertNoDefaultClaim(input)
    const policy: AccountRiskPolicy = {
      id: this.deps.idGenerator.next('mp'),
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
      createdAt: this.deps.clock.now(),
    }
    await this.deps.accountRiskPolicyRepository.upsert(accountId, policy)
    await this.invalidate()
    return accountEntry(policy)
  }

  /**
   * Patch an account policy. Every field replaces wholesale, exactly as at the board tier — an
   * editor that submits the full role/class maps on every save depends on it.
   */
  async update(
    accountId: string,
    id: string,
    patch: UpdateRiskPolicyInput,
  ): Promise<RiskPolicyLibraryEntry> {
    assertNoDefaultClaim(patch)
    const existing = assertFound(
      await this.deps.accountRiskPolicyRepository.get(accountId, id),
      'RiskPolicy',
      id,
    )
    const updated: AccountRiskPolicy = {
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
    }
    await this.deps.accountRiskPolicyRepository.upsert(accountId, updated)
    await this.invalidate()
    return accountEntry(updated)
  }

  /**
   * Withdraw an account policy.
   *
   * Nothing here refuses a policy some board's task has PINNED, which is the same disposition a
   * board's own delete takes: a dangling pin falls back to that board's default for the run's scope
   * (`resolveRiskPolicy`). Refusing instead would need a deployment-wide scan of every board's tasks
   * and would leave an account unable to retire a posture because one board once pinned it.
   */
  async remove(accountId: string, id: string): Promise<void> {
    await this.deps.accountRiskPolicyRepository.remove(accountId, id)
    await this.invalidate()
  }

  /**
   * Drop the cached resolved policies for EVERY board.
   *
   * Coarse on purpose. An account write changes what every board under it resolves, and enumerating
   * those boards would be a read per invalidation; over-invalidation is always safe, so this takes
   * the same `invalidateAll` the account-tier fragment and foundational-service writes take.
   */
  private async invalidate(): Promise<void> {
    await this.deps.riskPolicyCache?.invalidateAll()
  }
}

/** An account row → the library entry the wire carries (`isDefault` stated false, never stored). */
function accountEntry(policy: AccountRiskPolicy): RiskPolicyLibraryEntry {
  return { ...policy, isDefault: false, isUnattendedDefault: false, tier: 'account' }
}

/**
 * Refuse a default claim on an account write.
 *
 * A 422 rather than a silent drop: the request states an intent the tier cannot honour, and the
 * caller that sent it would otherwise reload to find the flag missing with nothing explaining why.
 * The message names where the claim does belong, since that is a real place to go.
 */
function assertNoDefaultClaim(input: { isDefault?: boolean; isUnattendedDefault?: boolean }): void {
  if (!input.isDefault && !input.isUnattendedDefault) return
  throw new ValidationError(
    'An account risk policy cannot be a default. Which policy governs a task that pinned none is a per-board setting: promote the policy (or a clone of it) on the board itself.',
    { reason: 'risk_policy_account_default' },
  )
}
