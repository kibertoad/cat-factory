import {
  decodeFindingsStoragePolicy,
  decodeResearchMode,
  parseResearchDefinition,
  type FindingsStorageOwnerKind,
  type FindingsStoragePolicy,
  type ResearchProject,
} from '@cat-factory/contracts'
import type {
  FindingsRevisionRepository,
  FindingsRevisionRow,
  FindingsStoragePolicyRepository,
  ResearchDefinitionRepository,
  ResearchProjectRepository,
  StoredResearchDefinition,
} from '@cat-factory/kernel'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  findingsRevisions,
  findingsStoragePolicies,
  researchTaskSeqs,
  researchDefinitions,
  researchProjects,
} from '../../db/schema.js'

const CHUNK = 500

function rowToDefinition(row: typeof researchDefinitions.$inferSelect): StoredResearchDefinition {
  const parsed = parseResearchDefinition(JSON.parse(row.body))
  if (!parsed.ok) {
    throw new Error(`stored research definition ${row.key} v${row.version} is unreadable`)
  }
  return {
    accountId: row.account_id,
    definition: parsed.definition,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** Account-published research definitions, immutable per version. */
export class DrizzleResearchDefinitionRepository implements ResearchDefinitionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(accountId: string, key: string, version: number) {
    const [row] = await this.db
      .select()
      .from(researchDefinitions)
      .where(
        and(
          eq(researchDefinitions.account_id, accountId),
          eq(researchDefinitions.key, key),
          eq(researchDefinitions.version, version),
        ),
      )
    return row ? rowToDefinition(row) : null
  }

  async listByAccount(accountId: string) {
    const rows = await this.db
      .select()
      .from(researchDefinitions)
      .where(eq(researchDefinitions.account_id, accountId))
      .orderBy(asc(researchDefinitions.key), asc(researchDefinitions.version))
    return rows.map(rowToDefinition)
  }

  async insert(stored: StoredResearchDefinition): Promise<boolean> {
    const inserted = await this.db
      .insert(researchDefinitions)
      .values({
        account_id: stored.accountId,
        key: stored.definition.key,
        version: stored.definition.version,
        body: JSON.stringify(stored.definition),
        content_hash: stored.contentHash,
        created_at: stored.createdAt,
      })
      .onConflictDoNothing({
        target: [
          researchDefinitions.account_id,
          researchDefinitions.key,
          researchDefinitions.version,
        ],
      })
      .returning({ key: researchDefinitions.key })
    return inserted.length > 0
  }
}

/** What each research project pins, and its findings sequence. */
export class DrizzleResearchProjectRepository implements ResearchProjectRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(projectId: string): Promise<ResearchProject | null> {
    const [row] = await this.db
      .select()
      .from(researchProjects)
      .where(eq(researchProjects.project_id, projectId))
    if (!row) return null
    return {
      projectId: row.project_id,
      definitionKey: row.definition_key,
      definitionVersion: row.definition_version,
      definitionHash: row.definition_hash,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    }
  }

  async insert(project: ResearchProject): Promise<void> {
    await this.db.insert(researchProjects).values({
      project_id: project.projectId,
      definition_key: project.definitionKey,
      definition_version: project.definitionVersion,
      definition_hash: project.definitionHash,
      inputs: JSON.stringify(project.inputs),
    })
  }

  async reserveTaskSeq(projectId: string, taskId: string): Promise<number> {
    const existing = await this.taskSeq(taskId)
    if (existing !== null) return existing
    const [row] = await this.db
      .update(researchProjects)
      .set({ next_seq: sql`${researchProjects.next_seq} + 1` })
      .where(eq(researchProjects.project_id, projectId))
      .returning({ next: researchProjects.next_seq })
    if (!row) throw new Error(`research project '${projectId}' not found`)
    await this.db
      .insert(researchTaskSeqs)
      .values({ task_id: taskId, project_id: projectId, seq: row.next - 1 })
      .onConflictDoNothing({ target: researchTaskSeqs.task_id })
    const claimed = await this.taskSeq(taskId)
    if (claimed === null) throw new Error(`research task '${taskId}' lost its sequence claim`)
    return claimed
  }

  private async taskSeq(taskId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ seq: researchTaskSeqs.seq })
      .from(researchTaskSeqs)
      .where(eq(researchTaskSeqs.task_id, taskId))
    return row?.seq ?? null
  }

  async deleteMany(projectIds: string[]): Promise<void> {
    for (let i = 0; i < projectIds.length; i += CHUNK) {
      const chunk = projectIds.slice(i, i + CHUNK)
      await this.db.transaction(async (tx) => {
        await tx.delete(findingsRevisions).where(inArray(findingsRevisions.project_id, chunk))
        await tx.delete(researchTaskSeqs).where(inArray(researchTaskSeqs.project_id, chunk))
        await tx
          .delete(findingsStoragePolicies)
          .where(
            and(
              eq(findingsStoragePolicies.owner_kind, 'project'),
              inArray(findingsStoragePolicies.owner_id, chunk),
            ),
          )
        await tx.delete(researchProjects).where(inArray(researchProjects.project_id, chunk))
      })
    }
  }
}

function rowToRevision(row: typeof findingsRevisions.$inferSelect): FindingsRevisionRow {
  const body =
    row.body_inline !== null
      ? { kind: 'inline' as const, json: row.body_inline }
      : row.body_artifact_id !== null
        ? { kind: 'offloaded' as const, artifactId: row.body_artifact_id }
        : null
  if (!body) throw new Error(`findings revision '${row.id}' has no body`)
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    seq: row.seq,
    mode: decodeResearchMode(row.mode),
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    createdAt: row.created_at,
    body,
    bodyBytes: row.body_bytes,
  }
}

/** Findings revisions, written once each. */
export class DrizzleFindingsRevisionRepository implements FindingsRevisionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(row: FindingsRevisionRow): Promise<boolean> {
    const inserted = await this.db
      .insert(findingsRevisions)
      .values({
        id: row.id,
        project_id: row.projectId,
        task_id: row.taskId,
        seq: row.seq,
        mode: row.mode,
        definition_key: row.definitionKey,
        definition_version: row.definitionVersion,
        created_at: row.createdAt,
        body_inline: row.body.kind === 'inline' ? row.body.json : null,
        body_artifact_id: row.body.kind === 'offloaded' ? row.body.artifactId : null,
        body_bytes: row.bodyBytes,
      })
      .onConflictDoNothing({ target: findingsRevisions.id })
      .returning({ id: findingsRevisions.id })
    return inserted.length > 0
  }

  async get(projectId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(findingsRevisions)
      .where(and(eq(findingsRevisions.project_id, projectId), eq(findingsRevisions.id, id)))
    return row ? rowToRevision(row) : null
  }

  async listByProject(projectId: string) {
    const rows = await this.db
      .select()
      .from(findingsRevisions)
      .where(eq(findingsRevisions.project_id, projectId))
      .orderBy(asc(findingsRevisions.seq))
    return rows.map(rowToRevision)
  }
}

/** The findings-storage policy tiers. */
export class DrizzleFindingsStoragePolicyRepository implements FindingsStoragePolicyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(ownerKind: FindingsStorageOwnerKind, ownerId: string) {
    const [row] = await this.db
      .select({ policy: findingsStoragePolicies.policy })
      .from(findingsStoragePolicies)
      .where(
        and(
          eq(findingsStoragePolicies.owner_kind, ownerKind),
          eq(findingsStoragePolicies.owner_id, ownerId),
        ),
      )
    return row ? decodeFindingsStoragePolicy(row.policy) : null
  }

  async set(
    ownerKind: FindingsStorageOwnerKind,
    ownerId: string,
    policy: FindingsStoragePolicy | null,
  ): Promise<void> {
    const where = and(
      eq(findingsStoragePolicies.owner_kind, ownerKind),
      eq(findingsStoragePolicies.owner_id, ownerId),
    )
    if (!policy) {
      await this.db.delete(findingsStoragePolicies).where(where)
      return
    }
    await this.db
      .insert(findingsStoragePolicies)
      .values({ owner_kind: ownerKind, owner_id: ownerId, policy: JSON.stringify(policy) })
      .onConflictDoUpdate({
        target: [findingsStoragePolicies.owner_kind, findingsStoragePolicies.owner_id],
        set: { policy: JSON.stringify(policy) },
      })
  }
}
