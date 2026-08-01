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
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed stores for the foundational-services catalog (migration 0073). The Drizzle mirrors
// live in `runtimes/node/src/repositories/foundationalServices.ts`; the two are kept honest by
// the conformance suite's foundational-services assertions.

/**
 * How many service ids ride ONE `IN (…)` of the lazy contract read. D1 binds parameters
 * positionally with a per-statement ceiling, so a design that declared many services is chunked
 * rather than issued as a query per id (which is the banned N+1) or as one over-long statement.
 */
const ID_CHUNK = 50

interface ServiceRow {
  service_id: string
  owner_kind: string
  owner_id: string
  name: string
  summary: string
  description: string
  capabilities: string
  source_id: string | null
  source_path: string | null
  pinned_commit: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

function toServiceRecord(row: ServiceRow): FoundationalServiceRecord {
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

/**
 * A JSON `string[]` column, read LENIENTLY. A malformed value degrades to `[]` rather than
 * throwing: these columns are written only by our own repos, so a bad value means a hand edit or
 * a partially-applied migration, and failing the whole catalog read over one row's tags would
 * take down every design dispatch in the workspace.
 */
function parseStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // silent-catch-ok: see the note above — a malformed tag list reads as no tags, and the row
    // it belongs to is still served.
    return []
  }
}

export class D1FoundationalServiceRepository implements FoundationalServiceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    includeDeleted = false,
  ): Promise<FoundationalServiceRecord[]> {
    const where = includeDeleted ? '' : ' AND deleted_at IS NULL'
    const { results } = await this.db
      .prepare(
        `SELECT * FROM foundational_services WHERE owner_kind = ? AND owner_id = ?${where} ORDER BY service_id`,
      )
      .bind(ownerKind, ownerId)
      .all<ServiceRow>()
    return results.map(toServiceRecord)
  }

  async get(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<FoundationalServiceRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM foundational_services WHERE owner_kind = ? AND owner_id = ? AND service_id = ?',
      )
      .bind(ownerKind, ownerId, serviceId)
      .first<ServiceRow>()
    return row ? toServiceRecord(row) : null
  }

  async upsert(record: FoundationalServiceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO foundational_services
          (service_id, owner_kind, owner_id, name, summary, description, capabilities,
           source_id, source_path, pinned_commit, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_kind, owner_id, service_id) DO UPDATE SET
           name = excluded.name,
           summary = excluded.summary,
           description = excluded.description,
           capabilities = excluded.capabilities,
           source_id = excluded.source_id,
           source_path = excluded.source_path,
           pinned_commit = excluded.pinned_commit,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.serviceId,
        record.ownerKind,
        record.ownerId,
        record.name,
        record.summary,
        record.description,
        JSON.stringify(record.capabilities),
        record.sourceId,
        record.sourcePath,
        record.pinnedCommit,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      )
      .run()
  }

  async softDelete(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    at: number,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE foundational_services SET deleted_at = ?, updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND service_id = ?',
      )
      .bind(at, at, ownerKind, ownerId, serviceId)
      .run()
  }

  async hardDelete(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM foundational_services WHERE owner_kind = ? AND owner_id = ? AND service_id = ?',
      )
      .bind(ownerKind, ownerId, serviceId)
      .run()
  }

  async listBySource(sourceId: string): Promise<FoundationalServiceRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM foundational_services WHERE source_id = ? AND deleted_at IS NULL ORDER BY service_id',
      )
      .bind(sourceId)
      .all<ServiceRow>()
    return results.map(toServiceRecord)
  }

  async softDeleteBySource(sourceId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE foundational_services SET deleted_at = ?, updated_at = ? WHERE source_id = ? AND deleted_at IS NULL',
      )
      .bind(at, at, sourceId)
      .run()
  }
}

interface ContractRow {
  owner_kind: string
  owner_id: string
  service_id: string
  contract_id: string
  format: string
  title: string
  body: string
  operations: string
  omitted_operations: number
  source_path: string | null
  source_sha: string | null
  created_at: number
  updated_at: number
}

export class D1ApiContractRepository implements ApiContractRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listManifestByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<ApiContractManifestEntry[]> {
    // `length(body)` rather than `body`: the whole point of the manifest is that a catalog read
    // never transfers a document. SQLite's `length()` on TEXT counts characters, which is what
    // the size is compared against everywhere else (`body.length` in JS).
    const { results } = await this.db
      .prepare(
        `SELECT service_id, contract_id, format, title, length(body) AS size,
                operations, omitted_operations, source_path
           FROM api_contracts
          WHERE owner_kind = ? AND owner_id = ?
          ORDER BY service_id, contract_id`,
      )
      .bind(ownerKind, ownerId)
      .all<{
        service_id: string
        contract_id: string
        format: string
        title: string
        size: number
        operations: string
        omitted_operations: number
        source_path: string | null
      }>()
    return results.map((row) => ({
      serviceId: row.service_id,
      contractId: row.contract_id,
      format: row.format as ApiContractFormat,
      title: row.title,
      size: row.size,
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
      const chunk = ids.slice(i, i + ID_CHUNK)
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM api_contracts
            WHERE owner_kind = ? AND owner_id = ? AND service_id IN (${placeholders})
            ORDER BY service_id, contract_id`,
        )
        .bind(ownerKind, ownerId, ...chunk)
        .all<ContractRow>()
      for (const row of results) out.push(toContractRecord(row))
    }
    return out
  }

  async replaceForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    contracts: ApiContractRecord[],
  ): Promise<void> {
    // One BATCH so the delete and the inserts land together: a reader between the two would
    // otherwise see a service whose contracts had vanished, which the catalog renders as a
    // service with no interface rather than as a write in progress.
    const statements = [
      this.db
        .prepare(
          'DELETE FROM api_contracts WHERE owner_kind = ? AND owner_id = ? AND service_id = ?',
        )
        .bind(ownerKind, ownerId, serviceId),
      ...contracts.map((contract) =>
        this.db
          .prepare(
            `INSERT INTO api_contracts
              (owner_kind, owner_id, service_id, contract_id, format, title, body,
               operations, omitted_operations, source_path, source_sha, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            ownerKind,
            ownerId,
            serviceId,
            contract.contractId,
            contract.format,
            contract.title,
            contract.body,
            JSON.stringify(contract.operations),
            contract.omittedOperations,
            contract.sourcePath,
            contract.sourceSha,
            contract.createdAt,
            contract.updatedAt,
          ),
      ),
    ]
    await this.db.batch(statements)
  }

  async deleteForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    await this.db
      .prepare('DELETE FROM api_contracts WHERE owner_kind = ? AND owner_id = ? AND service_id = ?')
      .bind(ownerKind, ownerId, serviceId)
      .run()
  }
}

function toContractRecord(row: ContractRow): ApiContractRecord {
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

interface SourceRow {
  id: string
  owner_kind: string
  owner_id: string
  repo_owner: string
  repo_name: string
  git_ref: string
  mode: string
  dir_path: string
  file_paths: string
  service_id: string | null
  service_name: string | null
  service_summary: string | null
  last_synced_commit: string | null
  last_synced_at: number | null
  created_at: number
  deleted_at: number | null
}

function toSourceRecord(row: SourceRow): FoundationalServiceSourceRecord {
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

export class D1FoundationalServiceSourceRepository implements FoundationalServiceSourceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalServiceSourceRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM foundational_service_sources WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(ownerKind, ownerId)
      .all<SourceRow>()
    return results.map(toSourceRecord)
  }

  async listByRepo(
    repoOwner: string,
    repoName: string,
  ): Promise<FoundationalServiceSourceRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM foundational_service_sources WHERE repo_owner = ? AND repo_name = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(repoOwner, repoName)
      .all<SourceRow>()
    return results.map(toSourceRecord)
  }

  async get(id: string): Promise<FoundationalServiceSourceRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM foundational_service_sources WHERE id = ?')
      .bind(id)
      .first<SourceRow>()
    return row ? toSourceRecord(row) : null
  }

  async upsert(record: FoundationalServiceSourceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO foundational_service_sources
          (id, owner_kind, owner_id, repo_owner, repo_name, git_ref, mode, dir_path, file_paths,
           service_id, service_name, service_summary, last_synced_commit, last_synced_at,
           created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           git_ref = excluded.git_ref,
           mode = excluded.mode,
           dir_path = excluded.dir_path,
           file_paths = excluded.file_paths,
           service_id = excluded.service_id,
           service_name = excluded.service_name,
           service_summary = excluded.service_summary,
           last_synced_commit = excluded.last_synced_commit,
           last_synced_at = excluded.last_synced_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.id,
        record.ownerKind,
        record.ownerId,
        record.repoOwner,
        record.repoName,
        record.gitRef,
        record.mode,
        record.dirPath,
        JSON.stringify(record.filePaths),
        record.serviceId,
        record.serviceName,
        record.serviceSummary,
        record.lastSyncedCommit,
        record.lastSyncedAt,
        record.createdAt,
        record.deletedAt,
      )
      .run()
  }

  async updateSyncState(
    id: string,
    lastSyncedCommit: string | null,
    lastSyncedAt: number,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE foundational_service_sources SET last_synced_commit = ?, last_synced_at = ? WHERE id = ?',
      )
      .bind(lastSyncedCommit, lastSyncedAt, id)
      .run()
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE foundational_service_sources SET deleted_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }

  async listStale(staleBefore: number, limit: number): Promise<FoundationalServiceSourceRecord[]> {
    // `last_synced_at IS NULL` first: a source linked but never synced is the stalest thing there
    // is, and ordering by a nullable column alone would sort it unpredictably across engines.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM foundational_service_sources
          WHERE deleted_at IS NULL AND (last_synced_at IS NULL OR last_synced_at < ?)
          ORDER BY (last_synced_at IS NULL) DESC, last_synced_at ASC
          LIMIT ?`,
      )
      .bind(staleBefore, limit)
      .all<SourceRow>()
    return results.map(toSourceRecord)
  }
}
