import type {
  ApiContractFormat,
  FoundationalServiceOwnerKind,
  FoundationalServiceSourceMode,
} from '@cat-factory/contracts'
import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
} from '@cat-factory/kernel'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { apiContracts, foundationalServiceSources, foundationalServices } from '../db/schema.js'

// Drizzle/Postgres mirrors of the foundational-services D1 repositories
// (docs/initiatives/foundational-services.md; D1 migration 0073). Behaviourally identical to
// the D1 repos, so the cross-runtime conformance suite asserts the same catalog against both.

/**
 * How many service ids ride ONE `IN (…)` of the lazy contract read — the same chunking the D1
 * repo applies, so a design that declared many services costs the same bounded number of
 * queries on either runtime rather than the banned per-id N+1.
 */
const ID_CHUNK = 50

/**
 * A JSON `string[]` column, read LENIENTLY (the D1 repo does the same). A malformed value
 * degrades to `[]` rather than throwing: these columns are written only by our own repos, so a
 * bad value means a hand edit, and failing the whole catalog read over one row's tags would take
 * down every design dispatch in the workspace.
 */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // silent-catch-ok: see the note above — a malformed list reads as empty and its row is served.
    return []
  }
}

// ---- foundational services ------------------------------------------------

type ServiceRow = typeof foundationalServices.$inferSelect

function rowToService(row: ServiceRow): FoundationalServiceRecord {
  return {
    serviceId: row.service_id,
    ownerKind: row.owner_kind as FoundationalServiceOwnerKind,
    ownerId: row.owner_id,
    name: row.name,
    summary: row.summary,
    description: row.description,
    capabilities: parseStringArray(row.capabilities),
    sourceId: row.source_id,
    sourcePath: row.source_path,
    pinnedCommit: row.pinned_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export class DrizzleFoundationalServiceRepository implements FoundationalServiceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    includeDeleted = false,
  ): Promise<FoundationalServiceRecord[]> {
    const base = and(
      eq(foundationalServices.owner_kind, ownerKind),
      eq(foundationalServices.owner_id, ownerId),
    )
    const rows = await this.db
      .select()
      .from(foundationalServices)
      .where(includeDeleted ? base : and(base, isNull(foundationalServices.deleted_at)))
      .orderBy(asc(foundationalServices.service_id))
    return rows.map(rowToService)
  }

  async get(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<FoundationalServiceRecord | null> {
    const [row] = await this.db
      .select()
      .from(foundationalServices)
      .where(
        and(
          eq(foundationalServices.owner_kind, ownerKind),
          eq(foundationalServices.owner_id, ownerId),
          eq(foundationalServices.service_id, serviceId),
        ),
      )
      .limit(1)
    return row ? rowToService(row) : null
  }

  async upsert(record: FoundationalServiceRecord): Promise<void> {
    const values = {
      service_id: record.serviceId,
      owner_kind: record.ownerKind,
      owner_id: record.ownerId,
      name: record.name,
      summary: record.summary,
      description: record.description,
      capabilities: JSON.stringify(record.capabilities),
      source_id: record.sourceId,
      source_path: record.sourcePath,
      pinned_commit: record.pinnedCommit,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(foundationalServices)
      .values(values)
      .onConflictDoUpdate({
        target: [
          foundationalServices.owner_kind,
          foundationalServices.owner_id,
          foundationalServices.service_id,
        ],
        set: {
          name: values.name,
          summary: values.summary,
          description: values.description,
          capabilities: values.capabilities,
          source_id: values.source_id,
          source_path: values.source_path,
          pinned_commit: values.pinned_commit,
          updated_at: values.updated_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  async softDelete(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    at: number,
  ): Promise<void> {
    await this.db
      .update(foundationalServices)
      .set({ deleted_at: at, updated_at: at })
      .where(
        and(
          eq(foundationalServices.owner_kind, ownerKind),
          eq(foundationalServices.owner_id, ownerId),
          eq(foundationalServices.service_id, serviceId),
        ),
      )
  }

  async listBySource(sourceId: string): Promise<FoundationalServiceRecord[]> {
    const rows = await this.db
      .select()
      .from(foundationalServices)
      .where(
        and(eq(foundationalServices.source_id, sourceId), isNull(foundationalServices.deleted_at)),
      )
      .orderBy(asc(foundationalServices.service_id))
    return rows.map(rowToService)
  }

  async softDeleteBySource(sourceId: string, at: number): Promise<void> {
    await this.db
      .update(foundationalServices)
      .set({ deleted_at: at, updated_at: at })
      .where(
        and(eq(foundationalServices.source_id, sourceId), isNull(foundationalServices.deleted_at)),
      )
  }
}

// ---- API contract documents -----------------------------------------------

type ContractRow = typeof apiContracts.$inferSelect

function rowToContract(row: ContractRow): ApiContractRecord {
  return {
    ownerKind: row.owner_kind as FoundationalServiceOwnerKind,
    ownerId: row.owner_id,
    serviceId: row.service_id,
    contractId: row.contract_id,
    format: row.format as ApiContractFormat,
    title: row.title,
    body: row.body,
    operations: parseStringArray(row.operations),
    omittedOperations: row.omitted_operations,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DrizzleApiContractRepository implements ApiContractRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listManifestByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<ApiContractManifestEntry[]> {
    // `length(body)` rather than `body`: the whole point of the manifest is that a catalog read
    // transfers no document. Postgres `length()` on text counts CHARACTERS, matching both the
    // SQLite side and the `body.length` the service compares against.
    const rows = await this.db
      .select({
        service_id: apiContracts.service_id,
        contract_id: apiContracts.contract_id,
        format: apiContracts.format,
        title: apiContracts.title,
        size: sql<number>`length(${apiContracts.body})`,
        operations: apiContracts.operations,
        omitted_operations: apiContracts.omitted_operations,
        source_path: apiContracts.source_path,
      })
      .from(apiContracts)
      .where(and(eq(apiContracts.owner_kind, ownerKind), eq(apiContracts.owner_id, ownerId)))
      .orderBy(asc(apiContracts.service_id), asc(apiContracts.contract_id))
    return rows.map((row) => ({
      serviceId: row.service_id,
      contractId: row.contract_id,
      format: row.format as ApiContractFormat,
      title: row.title,
      size: Number(row.size),
      operations: parseStringArray(row.operations),
      omittedOperations: row.omitted_operations,
      sourcePath: row.source_path,
    }))
  }

  async listByServiceIds(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceIds: string[],
  ): Promise<ApiContractRecord[]> {
    const ids = [...new Set(serviceIds)].filter(Boolean)
    if (ids.length === 0) return []
    const out: ApiContractRecord[] = []
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const rows = await this.db
        .select()
        .from(apiContracts)
        .where(
          and(
            eq(apiContracts.owner_kind, ownerKind),
            eq(apiContracts.owner_id, ownerId),
            inArray(apiContracts.service_id, ids.slice(i, i + ID_CHUNK)),
          ),
        )
        .orderBy(asc(apiContracts.service_id), asc(apiContracts.contract_id))
      for (const row of rows) out.push(rowToContract(row))
    }
    return out
  }

  async replaceForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    contracts: ApiContractRecord[],
  ): Promise<void> {
    // One TRANSACTION so the delete and the inserts land together: a reader between the two would
    // otherwise see a service whose contracts had vanished, which the catalog renders as a service
    // with no interface rather than as a write in progress (the D1 repo uses a batch for this).
    await this.db.transaction(async (tx) => {
      await tx
        .delete(apiContracts)
        .where(
          and(
            eq(apiContracts.owner_kind, ownerKind),
            eq(apiContracts.owner_id, ownerId),
            eq(apiContracts.service_id, serviceId),
          ),
        )
      if (contracts.length === 0) return
      await tx.insert(apiContracts).values(
        contracts.map((contract) => ({
          owner_kind: ownerKind,
          owner_id: ownerId,
          service_id: serviceId,
          contract_id: contract.contractId,
          format: contract.format,
          title: contract.title,
          body: contract.body,
          operations: JSON.stringify(contract.operations),
          omitted_operations: contract.omittedOperations,
          source_path: contract.sourcePath,
          source_sha: contract.sourceSha,
          created_at: contract.createdAt,
          updated_at: contract.updatedAt,
        })),
      )
    })
  }

  async deleteForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    await this.db
      .delete(apiContracts)
      .where(
        and(
          eq(apiContracts.owner_kind, ownerKind),
          eq(apiContracts.owner_id, ownerId),
          eq(apiContracts.service_id, serviceId),
        ),
      )
  }
}

// ---- repo sources ---------------------------------------------------------

type SourceRow = typeof foundationalServiceSources.$inferSelect

function rowToSource(row: SourceRow): FoundationalServiceSourceRecord {
  return {
    id: row.id,
    ownerKind: row.owner_kind as FoundationalServiceOwnerKind,
    ownerId: row.owner_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    gitRef: row.git_ref,
    mode: row.mode as FoundationalServiceSourceMode,
    dirPath: row.dir_path,
    filePaths: parseStringArray(row.file_paths),
    serviceId: row.service_id,
    serviceName: row.service_name,
    serviceSummary: row.service_summary,
    lastSyncedCommit: row.last_synced_commit,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

export class DrizzleFoundationalServiceSourceRepository implements FoundationalServiceSourceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalServiceSourceRecord[]> {
    const rows = await this.db
      .select()
      .from(foundationalServiceSources)
      .where(
        and(
          eq(foundationalServiceSources.owner_kind, ownerKind),
          eq(foundationalServiceSources.owner_id, ownerId),
          isNull(foundationalServiceSources.deleted_at),
        ),
      )
      .orderBy(desc(foundationalServiceSources.created_at))
    return rows.map(rowToSource)
  }

  async get(id: string): Promise<FoundationalServiceSourceRecord | null> {
    const [row] = await this.db
      .select()
      .from(foundationalServiceSources)
      .where(eq(foundationalServiceSources.id, id))
      .limit(1)
    return row ? rowToSource(row) : null
  }

  async upsert(record: FoundationalServiceSourceRecord): Promise<void> {
    const values = {
      id: record.id,
      owner_kind: record.ownerKind,
      owner_id: record.ownerId,
      repo_owner: record.repoOwner,
      repo_name: record.repoName,
      git_ref: record.gitRef,
      mode: record.mode,
      dir_path: record.dirPath,
      file_paths: JSON.stringify(record.filePaths),
      service_id: record.serviceId,
      service_name: record.serviceName,
      service_summary: record.serviceSummary,
      last_synced_commit: record.lastSyncedCommit,
      last_synced_at: record.lastSyncedAt,
      created_at: record.createdAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(foundationalServiceSources)
      .values(values)
      .onConflictDoUpdate({
        target: foundationalServiceSources.id,
        set: {
          repo_owner: values.repo_owner,
          repo_name: values.repo_name,
          git_ref: values.git_ref,
          mode: values.mode,
          dir_path: values.dir_path,
          file_paths: values.file_paths,
          service_id: values.service_id,
          service_name: values.service_name,
          service_summary: values.service_summary,
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
      .update(foundationalServiceSources)
      .set({ last_synced_commit: lastSyncedCommit, last_synced_at: lastSyncedAt })
      .where(eq(foundationalServiceSources.id, id))
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db
      .update(foundationalServiceSources)
      .set({ deleted_at: at })
      .where(eq(foundationalServiceSources.id, id))
  }

  async listStale(staleBefore: number, limit: number): Promise<FoundationalServiceSourceRecord[]> {
    // A source linked but NEVER synced is the stalest thing there is, so it is matched
    // explicitly and ordered first — `ORDER BY last_synced_at` alone puts NULLs last on
    // Postgres and first on SQLite, which would make the two runtimes drain different sources.
    const rows = await this.db
      .select()
      .from(foundationalServiceSources)
      .where(
        and(
          isNull(foundationalServiceSources.deleted_at),
          or(
            isNull(foundationalServiceSources.last_synced_at),
            lt(foundationalServiceSources.last_synced_at, staleBefore),
          ),
        ),
      )
      .orderBy(
        sql`${foundationalServiceSources.last_synced_at} IS NULL DESC`,
        asc(foundationalServiceSources.last_synced_at),
      )
      .limit(limit)
    return rows.map(rowToSource)
  }
}
