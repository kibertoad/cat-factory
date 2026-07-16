import type {
  AccountSkillRecord,
  AccountSkillRepository,
  SkillResource,
  SkillSourceRecord,
  SkillSourceRepository,
} from '@cat-factory/kernel'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { accountSkills, skillSources } from '../db/schema.js'

// Drizzle/Postgres mirrors of the Claude Skills library D1 repositories
// (docs/initiatives/repo-skills.md; migration 0052). Behaviourally identical to the
// D1 repos so the cross-runtime conformance suite asserts the same skill library
// against both stores.

function parseResources(raw: string | null): SkillResource[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SkillResource[]) : []
  } catch {
    return []
  }
}

// ---- account skills -------------------------------------------------------

type AccountSkillRow = typeof accountSkills.$inferSelect

function rowToSkill(row: AccountSkillRow): AccountSkillRecord {
  return {
    skillId: row.skill_id,
    accountId: row.account_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    resources: parseResources(row.resources),
    sourceId: row.source_id,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    pinnedCommit: row.pinned_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Account skill rows over Postgres (migration 0052). */
export class DrizzleAccountSkillRepository implements AccountSkillRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByAccount(accountId: string, includeDeleted = false): Promise<AccountSkillRecord[]> {
    const base = eq(accountSkills.account_id, accountId)
    const rows = await this.db
      .select()
      .from(accountSkills)
      .where(includeDeleted ? base : and(base, isNull(accountSkills.deleted_at)))
    return rows.map(rowToSkill)
  }

  async get(accountId: string, skillId: string): Promise<AccountSkillRecord | null> {
    const rows = await this.db
      .select()
      .from(accountSkills)
      .where(and(eq(accountSkills.account_id, accountId), eq(accountSkills.skill_id, skillId)))
      .limit(1)
    return rows[0] ? rowToSkill(rows[0]) : null
  }

  async upsert(record: AccountSkillRecord): Promise<void> {
    const values = {
      skill_id: record.skillId,
      account_id: record.accountId,
      name: record.name,
      description: record.description,
      instructions: record.instructions,
      resources: JSON.stringify(record.resources),
      source_id: record.sourceId,
      source_path: record.sourcePath,
      source_sha: record.sourceSha,
      pinned_commit: record.pinnedCommit,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(accountSkills)
      .values(values)
      .onConflictDoUpdate({
        target: [accountSkills.account_id, accountSkills.skill_id],
        set: {
          name: values.name,
          description: values.description,
          instructions: values.instructions,
          resources: values.resources,
          source_id: values.source_id,
          source_path: values.source_path,
          source_sha: values.source_sha,
          pinned_commit: values.pinned_commit,
          updated_at: values.updated_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  async softDelete(accountId: string, skillId: string, at: number): Promise<void> {
    await this.db
      .update(accountSkills)
      .set({ deleted_at: at, updated_at: at })
      .where(and(eq(accountSkills.account_id, accountId), eq(accountSkills.skill_id, skillId)))
  }

  async softDeleteBySource(sourceId: string, at: number): Promise<void> {
    await this.db
      .update(accountSkills)
      .set({ deleted_at: at, updated_at: at })
      .where(and(eq(accountSkills.source_id, sourceId), isNull(accountSkills.deleted_at)))
  }

  async listBySource(sourceId: string): Promise<AccountSkillRecord[]> {
    const rows = await this.db
      .select()
      .from(accountSkills)
      .where(and(eq(accountSkills.source_id, sourceId), isNull(accountSkills.deleted_at)))
    return rows.map(rowToSkill)
  }
}

// ---- skill sources --------------------------------------------------------

type SkillSourceRow = typeof skillSources.$inferSelect

function rowToSource(row: SkillSourceRow): SkillSourceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    gitRef: row.git_ref,
    dirPath: row.dir_path,
    lastSyncedCommit: row.last_synced_commit,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** Skill-source repo linkages over Postgres (migration 0052). */
export class DrizzleSkillSourceRepository implements SkillSourceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByAccount(accountId: string): Promise<SkillSourceRecord[]> {
    const rows = await this.db
      .select()
      .from(skillSources)
      .where(and(eq(skillSources.account_id, accountId), isNull(skillSources.deleted_at)))
      .orderBy(desc(skillSources.created_at))
    return rows.map(rowToSource)
  }

  async get(id: string): Promise<SkillSourceRecord | null> {
    const rows = await this.db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
    return rows[0] ? rowToSource(rows[0]) : null
  }

  async upsert(record: SkillSourceRecord): Promise<void> {
    const values = {
      id: record.id,
      account_id: record.accountId,
      repo_owner: record.repoOwner,
      repo_name: record.repoName,
      git_ref: record.gitRef,
      dir_path: record.dirPath,
      last_synced_commit: record.lastSyncedCommit,
      last_synced_at: record.lastSyncedAt,
      created_at: record.createdAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(skillSources)
      .values(values)
      .onConflictDoUpdate({
        target: skillSources.id,
        set: {
          repo_owner: values.repo_owner,
          repo_name: values.repo_name,
          git_ref: values.git_ref,
          dir_path: values.dir_path,
          last_synced_commit: values.last_synced_commit,
          last_synced_at: values.last_synced_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  async updateSyncState(
    id: string,
    lastSyncedCommit: string | null,
    lastSyncedAt: number,
  ): Promise<void> {
    await this.db
      .update(skillSources)
      .set({ last_synced_commit: lastSyncedCommit, last_synced_at: lastSyncedAt })
      .where(eq(skillSources.id, id))
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db.update(skillSources).set({ deleted_at: at }).where(eq(skillSources.id, id))
  }
}
