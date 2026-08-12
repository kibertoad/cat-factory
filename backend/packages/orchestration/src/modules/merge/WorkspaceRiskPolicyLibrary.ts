import type {
  AccountRiskPolicy,
  AccountRiskPolicyRepository,
  RiskPolicy,
  RiskPolicyLibraryEntry,
  RiskPolicyRepository,
  RiskPolicySuppression,
  RiskPolicySuppressionRepository,
  RunDefaultScope,
  WorkspaceRepository,
  WorkspaceRiskPolicyReader,
} from '@cat-factory/kernel'
import {
  describeRiskPolicySuppressions,
  mergeRiskPolicyTiers,
  resolveRiskPolicyTier,
} from '@cat-factory/kernel'

export interface WorkspaceRiskPolicyLibraryDeps {
  /** The board's own policies: the built-in catalog copied in at creation, plus whatever it authored. */
  riskPolicyRepository: RiskPolicyRepository
  /**
   * The account tier. Optional, and its absence is a PASS-THROUGH rather than a hole to guard: with
   * no account tier wired every read below answers exactly what the workspace repository answers,
   * which is byte-for-byte the behaviour before ADR 0055.
   */
  accountRiskPolicyRepository?: AccountRiskPolicyRepository
  /**
   * What the board hides from the account tier. Optional for the same reason, and absent it hides
   * nothing — the direction that OFFERS a posture rather than silently withdrawing one, so a facade
   * mid-migration can only ever show too much, never resolve a policy the editor called hidden.
   */
  riskPolicySuppressionRepository?: RiskPolicySuppressionRepository
  /** Resolves the board's account, which is what makes an inherited tier addressable. */
  workspaceRepository: WorkspaceRepository
}

/**
 * A board's risk-policy library: its OWN policies merged with the account policies it inherits
 * (ADR 0055), behind the same three reads every consumer already made of the workspace tier.
 *
 * It is the {@link WorkspaceRiskPolicyReader} the engine's `resolveRiskPolicy`, the board's two
 * selection guards, the settings editor and the snapshot all hold, and that is the point: a
 * resolution that admitted an id the editor calls hidden — or refused one a picker offered — would
 * decide how much oversight a task's merge takes by a rule nobody can see. The PRECEDENCE itself
 * lives in kernel (`mergeRiskPolicyTiers` / `resolveRiskPolicyTier`), so this class is only the I/O
 * around it and the two cannot drift.
 */
/**
 * Build the library from a container's dependency bag, or `undefined` when no board tier is wired.
 *
 * Every consumer composes it through THIS factory rather than reaching for the repositories itself:
 * the board guards, the engine's wiring and the risk-policy module each need the same three-store
 * composition, and the one that assembled it by hand would be the one that forgot the suppression
 * store and quietly resolved a policy the editor calls hidden. Instances hold no state, so building
 * one per consumer costs nothing.
 */
export function createWorkspaceRiskPolicyLibrary(deps: {
  riskPolicyRepository?: RiskPolicyRepository
  accountRiskPolicyRepository?: AccountRiskPolicyRepository
  riskPolicySuppressionRepository?: RiskPolicySuppressionRepository
  workspaceRepository: WorkspaceRepository
}): WorkspaceRiskPolicyLibrary | undefined {
  if (!deps.riskPolicyRepository) return undefined
  return new WorkspaceRiskPolicyLibrary({
    riskPolicyRepository: deps.riskPolicyRepository,
    accountRiskPolicyRepository: deps.accountRiskPolicyRepository,
    riskPolicySuppressionRepository: deps.riskPolicySuppressionRepository,
    workspaceRepository: deps.workspaceRepository,
  })
}

export class WorkspaceRiskPolicyLibrary implements WorkspaceRiskPolicyReader {
  constructor(private readonly deps: WorkspaceRiskPolicyLibraryDeps) {}

  /** The merged library, account tier first, each entry tagged with the tier that owns it. */
  async list(workspaceId: string): Promise<RiskPolicyLibraryEntry[]> {
    const [workspacePolicies, inherited] = await Promise.all([
      this.deps.riskPolicyRepository.list(workspaceId),
      this.inheritedTier(workspaceId),
    ])
    return mergeRiskPolicyTiers({ ...inherited, workspacePolicies })
  }

  /**
   * One policy by id, under the same precedence {@link list} applies.
   *
   * The board's own tier is read FIRST and answers alone when it hits, which is both the correct
   * precedence and the common case: a task usually pins a policy its own board holds, and paying
   * for the account reads only on a miss keeps the engine's per-gate resolution at one query where
   * it already was.
   */
  async get(workspaceId: string, id: string): Promise<RiskPolicyLibraryEntry | null> {
    const own = await this.deps.riskPolicyRepository.get(workspaceId, id)
    if (own)
      return resolveRiskPolicyTier({ workspacePolicy: own, accountPolicy: null, suppressed: false })
    const accountId = await this.accountOf(workspaceId)
    if (!accountId) return null
    const [accountPolicy, suppressedIds] = await Promise.all([
      this.deps.accountRiskPolicyRepository?.get(accountId, id) ?? Promise.resolve(null),
      this.suppressedIds(workspaceId),
    ])
    return resolveRiskPolicyTier({
      workspacePolicy: null,
      accountPolicy,
      suppressed: suppressedIds.includes(id),
    })
  }

  /**
   * The board's default for one scope — the WORKSPACE tier's own answer, unchanged by inheritance.
   *
   * A delegate rather than a merge, and deliberately so: an account row carries no default claim
   * (see `AccountRiskPolicy`), because which policy governs a task that pinned nothing is a
   * per-board question that no single account row could answer correctly for every board under it.
   * A board that wants an inherited posture as its default clones it and promotes the copy.
   */
  getDefault(workspaceId: string, scope: RunDefaultScope): Promise<RiskPolicy | null> {
    return this.deps.riskPolicyRepository.getDefault(workspaceId, scope)
  }

  /**
   * What this board hides, joined against the account tier for identity — including the entries
   * that now hide nothing because the account withdrew the policy (see
   * `describeRiskPolicySuppressions`).
   */
  async listSuppressions(workspaceId: string): Promise<RiskPolicySuppression[]> {
    const suppressedIds = await this.suppressedIds(workspaceId)
    if (suppressedIds.length === 0) return []
    const accountId = await this.accountOf(workspaceId)
    // Only the suppressed ids, in ONE batched read: a board hides a handful of policies out of a
    // tier that an account is free to grow, so listing the whole tier to name a few rows would
    // read more the larger the account got.
    const named =
      accountId && this.deps.accountRiskPolicyRepository
        ? await this.deps.accountRiskPolicyRepository.listByIds(accountId, suppressedIds)
        : []
    return describeRiskPolicySuppressions(suppressedIds, named)
  }

  /** Whether this board can see the account policy `id` at all (the write guards' question). */
  async inheritedPolicy(workspaceId: string, id: string): Promise<AccountRiskPolicy | null> {
    const accountId = await this.accountOf(workspaceId)
    if (!accountId || !this.deps.accountRiskPolicyRepository) return null
    return this.deps.accountRiskPolicyRepository.get(accountId, id)
  }

  /** The account tier as the merge wants it: its policies plus this board's suppressions. */
  private async inheritedTier(
    workspaceId: string,
  ): Promise<{ accountPolicies: AccountRiskPolicy[]; suppressedIds: string[] }> {
    const accountId = await this.accountOf(workspaceId)
    // A board with no account inherits nothing, so neither read is worth making.
    if (!accountId) return { accountPolicies: [], suppressedIds: [] }
    const [accountPolicies, suppressedIds] = await Promise.all([
      this.deps.accountRiskPolicyRepository?.list(accountId) ?? Promise.resolve([]),
      this.suppressedIds(workspaceId),
    ])
    return { accountPolicies, suppressedIds }
  }

  private suppressedIds(workspaceId: string): Promise<string[]> {
    return this.deps.riskPolicySuppressionRepository?.list(workspaceId) ?? Promise.resolve([])
  }

  private async accountOf(workspaceId: string): Promise<string | null> {
    // No account tier wired ⇒ nothing to address, so the lookup itself is skipped rather than
    // made and discarded. This is the pass-through: every read answers the workspace tier alone.
    if (!this.deps.accountRiskPolicyRepository) return null
    // The port answers `undefined` for a board it cannot place and `null` for one with no account;
    // both mean "inherits nothing here", and normalising once keeps every caller above from having
    // to know there are two spellings of it.
    return (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
  }
}
