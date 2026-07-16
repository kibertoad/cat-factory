import type {
  AccountSkillRecord,
  AccountSkillRepository,
  GroupCacheHandle,
} from '@cat-factory/kernel'
import type { AccountSkill } from '@cat-factory/contracts'

export interface SkillCatalogServiceDependencies {
  accountSkillRepository: AccountSkillRepository
  /**
   * Read-through cache for an account's resolved skill catalog
   * (`AppCaches.skillCatalog`), grouped AND keyed by account id. This service owns its
   * coherence: {@link SkillSourceService} invalidates through {@link invalidate} on
   * every sync/unlink that changes a skill. Absent (direct test construction) ⇒ every
   * resolve loads from the repository.
   */
  catalogCache?: GroupCacheHandle<AccountSkillRecord[]>
}

/**
 * Reads an account's repo-sourced skill catalog (docs/initiatives/repo-skills.md).
 * Skills live in ONE tier (the account), so there is no cross-tier merge — the catalog
 * is simply the account's live `account_skills` rows, served through the skill-catalog
 * cache when wired (a hit skips the DB read the execution path would otherwise run on
 * every skill-step dispatch). The management surface reads the same catalog as wire
 * {@link AccountSkill}s.
 */
export class SkillCatalogService {
  private readonly repo: AccountSkillRepository
  private readonly cache?: GroupCacheHandle<AccountSkillRecord[]>

  constructor(deps: SkillCatalogServiceDependencies) {
    this.repo = deps.accountSkillRepository
    this.cache = deps.catalogCache
  }

  /** The account's live skills as records (the execution/read path), cached when wired. */
  async resolveCatalog(accountId: string): Promise<AccountSkillRecord[]> {
    if (!this.cache) return this.repo.listByAccount(accountId)
    return this.cache.get(accountId, accountId, () => this.repo.listByAccount(accountId))
  }

  /** A single skill by id, or null when absent/tombstoned. */
  async get(accountId: string, skillId: string): Promise<AccountSkillRecord | null> {
    const catalog = await this.resolveCatalog(accountId)
    return catalog.find((s) => s.skillId === skillId) ?? null
  }

  /** The account's skills as wire {@link AccountSkill}s for the management surface. */
  async list(accountId: string): Promise<AccountSkill[]> {
    const rows = await this.resolveCatalog(accountId)
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt).map(recordToWire)
  }

  /** Drop an account's cached catalog after a skill write. Peers drop via the bus. */
  async invalidate(accountId: string): Promise<void> {
    if (!this.cache) return
    await this.cache.invalidateGroup(accountId)
  }
}

function recordToWire(record: AccountSkillRecord): AccountSkill {
  return {
    id: record.skillId,
    name: record.name,
    description: record.description,
    instructions: record.instructions,
    resources: record.resources,
    source: { sourceId: record.sourceId, path: record.sourcePath, sha: record.sourceSha },
    pinnedCommit: record.pinnedCommit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
