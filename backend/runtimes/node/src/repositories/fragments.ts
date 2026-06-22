import type {
  FragmentAppliesTo,
  FragmentOwnerKind,
  FragmentSourceRecord,
  FragmentSourceRepository,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { fragmentSources, promptFragments } from '../db/schema.js'

// Drizzle/Postgres mirrors of the prompt-fragment library D1 repositories (ADR 0006;
// migration 0020). Rows are scoped by an (owner_kind, owner_id) pair so one table
// backs both tiers. Behaviourally identical to the D1 repos so the cross-runtime
// conformance suite asserts the same fragment library against both stores.

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ---- prompt fragments -----------------------------------------------------

type PromptFragmentRow = typeof promptFragments.$inferSelect

function rowToFragment(row: PromptFragmentRow): PromptFragmentRecord {
  return {
    fragmentId: row.fragment_id,
    ownerKind: row.owner_kind as FragmentOwnerKind,
    ownerId: row.owner_id,
    version: row.version,
    title: row.title,
    category: row.category,
    summary: row.summary,
    body: row.body,
    appliesTo: parseJson<FragmentAppliesTo>(row.applies_to),
    tags: parseJson<string[]>(row.tags),
    sourceId: row.source_id,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Managed prompt-fragment rows over Postgres, both tiers (migration 0020). */
export class DrizzlePromptFragmentRepository implements PromptFragmentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByOwner(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    includeDeleted = false,
  ): Promise<PromptFragmentRecord[]> {
    const base = and(
      eq(promptFragments.owner_kind, ownerKind),
      eq(promptFragments.owner_id, ownerId),
    )
    const rows = await this.db
      .select()
      .from(promptFragments)
      .where(includeDeleted ? base : and(base, isNull(promptFragments.deleted_at)))
    return rows.map(rowToFragment)
  }

  async get(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
  ): Promise<PromptFragmentRecord | null> {
    const rows = await this.db
      .select()
      .from(promptFragments)
      .where(
        and(
          eq(promptFragments.owner_kind, ownerKind),
          eq(promptFragments.owner_id, ownerId),
          eq(promptFragments.fragment_id, fragmentId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToFragment(rows[0]) : null
  }

  async upsert(record: PromptFragmentRecord): Promise<void> {
    const values = {
      fragment_id: record.fragmentId,
      owner_kind: record.ownerKind,
      owner_id: record.ownerId,
      version: record.version,
      title: record.title,
      category: record.category,
      summary: record.summary,
      body: record.body,
      applies_to: record.appliesTo ? JSON.stringify(record.appliesTo) : null,
      tags: record.tags ? JSON.stringify(record.tags) : null,
      source_id: record.sourceId,
      source_path: record.sourcePath,
      source_sha: record.sourceSha,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(promptFragments)
      .values(values)
      .onConflictDoUpdate({
        target: [promptFragments.owner_kind, promptFragments.owner_id, promptFragments.fragment_id],
        set: {
          version: values.version,
          title: values.title,
          category: values.category,
          summary: values.summary,
          body: values.body,
          applies_to: values.applies_to,
          tags: values.tags,
          source_id: values.source_id,
          source_path: values.source_path,
          source_sha: values.source_sha,
          updated_at: values.updated_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  async softDelete(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
    at: number,
  ): Promise<void> {
    await this.db
      .update(promptFragments)
      .set({ deleted_at: at, updated_at: at })
      .where(
        and(
          eq(promptFragments.owner_kind, ownerKind),
          eq(promptFragments.owner_id, ownerId),
          eq(promptFragments.fragment_id, fragmentId),
        ),
      )
  }

  async listBySource(sourceId: string): Promise<PromptFragmentRecord[]> {
    const rows = await this.db
      .select()
      .from(promptFragments)
      .where(and(eq(promptFragments.source_id, sourceId), isNull(promptFragments.deleted_at)))
    return rows.map(rowToFragment)
  }
}

// ---- fragment sources -----------------------------------------------------

type FragmentSourceRow = typeof fragmentSources.$inferSelect

function rowToSource(row: FragmentSourceRow): FragmentSourceRecord {
  return {
    id: row.id,
    ownerKind: row.owner_kind as FragmentOwnerKind,
    ownerId: row.owner_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    gitRef: row.git_ref,
    dirPath: row.dir_path,
    lastSyncedSha: row.last_synced_sha,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** Fragment-source repo linkages over Postgres (migration 0020). */
export class DrizzleFragmentSourceRepository implements FragmentSourceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByOwner(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<FragmentSourceRecord[]> {
    const rows = await this.db
      .select()
      .from(fragmentSources)
      .where(
        and(
          eq(fragmentSources.owner_kind, ownerKind),
          eq(fragmentSources.owner_id, ownerId),
          isNull(fragmentSources.deleted_at),
        ),
      )
      .orderBy(desc(fragmentSources.created_at))
    return rows.map(rowToSource)
  }

  async get(id: string): Promise<FragmentSourceRecord | null> {
    const rows = await this.db
      .select()
      .from(fragmentSources)
      .where(eq(fragmentSources.id, id))
      .limit(1)
    return rows[0] ? rowToSource(rows[0]) : null
  }

  async upsert(record: FragmentSourceRecord): Promise<void> {
    const values = {
      id: record.id,
      owner_kind: record.ownerKind,
      owner_id: record.ownerId,
      repo_owner: record.repoOwner,
      repo_name: record.repoName,
      git_ref: record.gitRef,
      dir_path: record.dirPath,
      last_synced_sha: record.lastSyncedSha,
      last_synced_at: record.lastSyncedAt,
      created_at: record.createdAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(fragmentSources)
      .values(values)
      .onConflictDoUpdate({
        target: fragmentSources.id,
        set: {
          repo_owner: values.repo_owner,
          repo_name: values.repo_name,
          git_ref: values.git_ref,
          dir_path: values.dir_path,
          last_synced_sha: values.last_synced_sha,
          last_synced_at: values.last_synced_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  async updateSyncState(id: string, lastSyncedSha: string, lastSyncedAt: number): Promise<void> {
    await this.db
      .update(fragmentSources)
      .set({ last_synced_sha: lastSyncedSha, last_synced_at: lastSyncedAt })
      .where(eq(fragmentSources.id, id))
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db.update(fragmentSources).set({ deleted_at: at }).where(eq(fragmentSources.id, id))
  }
}
