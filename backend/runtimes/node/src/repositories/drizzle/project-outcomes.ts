import {
  decodeOutcomeStoragePolicy,
  encodeOutcomeStoragePolicy,
  encodeProjectDefinition,
  parseProjectDefinition,
  type OutcomeStorageOwnerKind,
  type OutcomeStoragePolicy,
  type ProjectPin,
} from '@cat-factory/contracts'
import type {
  OutcomeStoragePolicyRepository,
  ProjectDefinitionRepository,
  ProjectOutcomeRow,
  ProjectRecordRepository,
  StoredProjectDefinition,
} from '@cat-factory/kernel'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  outcomeStoragePolicies,
  projectDefinitions,
  projectOutcomeSeqs,
  projectOutcomes,
  projectPins,
  projectTaskSeqs,
} from '../../db/schema.js'

const CHUNK = 500

function rowToDefinition(row: typeof projectDefinitions.$inferSelect): StoredProjectDefinition {
  const parsed = parseProjectDefinition(JSON.parse(row.body))
  if (!parsed.ok) {
    throw new Error(`stored ${row.kind} definition ${row.key} v${row.version} is unreadable`)
  }
  return {
    accountId: row.account_id,
    definition: parsed.value,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** Account-published project definitions, immutable per version. */
export class DrizzleProjectDefinitionRepository implements ProjectDefinitionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(accountId: string, kind: string, key: string, version: number) {
    const [row] = await this.db
      .select()
      .from(projectDefinitions)
      .where(
        and(
          eq(projectDefinitions.account_id, accountId),
          eq(projectDefinitions.kind, kind),
          eq(projectDefinitions.key, key),
          eq(projectDefinitions.version, version),
        ),
      )
    return row ? rowToDefinition(row) : null
  }

  async listByAccount(accountId: string, kind: string) {
    const rows = await this.db
      .select()
      .from(projectDefinitions)
      .where(and(eq(projectDefinitions.account_id, accountId), eq(projectDefinitions.kind, kind)))
      .orderBy(sql`${projectDefinitions.key} COLLATE "C"`, asc(projectDefinitions.version))
    return rows.map(rowToDefinition)
  }

  async insert(stored: StoredProjectDefinition): Promise<boolean> {
    const { definition } = stored
    const inserted = await this.db
      .insert(projectDefinitions)
      .values({
        account_id: stored.accountId,
        kind: definition.kind,
        key: definition.key,
        version: definition.version,
        body: encodeProjectDefinition(definition),
        content_hash: stored.contentHash,
        created_at: stored.createdAt,
      })
      .onConflictDoNothing({
        target: [
          projectDefinitions.account_id,
          projectDefinitions.kind,
          projectDefinitions.key,
          projectDefinitions.version,
        ],
      })
      .returning({ key: projectDefinitions.key })
    return inserted.length > 0
  }
}

function rowToOutcome(row: typeof projectOutcomes.$inferSelect): ProjectOutcomeRow {
  const body =
    row.body_inline !== null
      ? { kind: 'inline' as const, json: row.body_inline }
      : row.body_artifact_id !== null
        ? { kind: 'offloaded' as const, artifactId: row.body_artifact_id }
        : null
  if (!body) throw new Error(`project outcome '${row.id}' has no body`)
  return {
    id: row.id,
    projectId: row.project_id,
    stream: row.stream,
    seq: row.seq,
    intent: row.intent,
    schemaVersion: row.schema_version,
    taskId: row.task_id,
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    artifactRefs: JSON.parse(row.artifact_refs) as string[],
    createdAt: row.created_at,
    body,
    bodyBytes: row.body_bytes,
  }
}

/**
 * Reclaim every record of `projectIds` on `tx`. The board delete calls it inside its own
 * transaction, so a table added here is reclaimed by both.
 */
export async function deleteProjectRecords(
  tx: Pick<DrizzleDb, 'delete'>,
  projectIds: string[],
): Promise<void> {
  await tx.delete(projectOutcomes).where(inArray(projectOutcomes.project_id, projectIds))
  await tx.delete(projectOutcomeSeqs).where(inArray(projectOutcomeSeqs.project_id, projectIds))
  await tx.delete(projectTaskSeqs).where(inArray(projectTaskSeqs.project_id, projectIds))
  await tx.delete(projectPins).where(inArray(projectPins.project_id, projectIds))
  await tx
    .delete(outcomeStoragePolicies)
    .where(
      and(
        eq(outcomeStoragePolicies.owner_kind, 'project'),
        inArray(outcomeStoragePolicies.owner_id, projectIds),
      ),
    )
}

function rowToPin(row: typeof projectPins.$inferSelect): ProjectPin {
  return {
    projectId: row.project_id,
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    definitionHash: row.definition_hash,
    inputs: JSON.parse(row.inputs) as Record<string, unknown>,
  }
}

/** A project's pin, outcome sequence and outcome revisions. */
export class DrizzleProjectRecordRepository implements ProjectRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getPin(projectId: string): Promise<ProjectPin | null> {
    const [row] = await this.db
      .select()
      .from(projectPins)
      .where(eq(projectPins.project_id, projectId))
    return row ? rowToPin(row) : null
  }

  async listPins(projectIds: string[]): Promise<ProjectPin[]> {
    const pins: ProjectPin[] = []
    for (let i = 0; i < projectIds.length; i += CHUNK) {
      const rows = await this.db
        .select()
        .from(projectPins)
        .where(inArray(projectPins.project_id, projectIds.slice(i, i + CHUNK)))
      pins.push(...rows.map(rowToPin))
    }
    return pins
  }

  async insertPin(pin: ProjectPin): Promise<void> {
    await this.db.insert(projectPins).values({
      project_id: pin.projectId,
      definition_key: pin.definitionKey,
      definition_version: pin.definitionVersion,
      definition_hash: pin.definitionHash,
      inputs: JSON.stringify(pin.inputs),
    })
  }

  async reserveSeq(projectId: string): Promise<number> {
    const [row] = await this.db
      .insert(projectOutcomeSeqs)
      .values({ project_id: projectId, next_seq: 2 })
      .onConflictDoUpdate({
        target: projectOutcomeSeqs.project_id,
        set: { next_seq: sql`${projectOutcomeSeqs.next_seq} + 1` },
      })
      .returning({ next: projectOutcomeSeqs.next_seq })
    if (!row) throw new Error(`could not reserve an outcome sequence for project '${projectId}'`)
    return row.next - 1
  }

  async reserveTaskSeq(projectId: string, taskId: string): Promise<number> {
    const existing = await this.taskSeq(taskId)
    if (existing !== null) return existing
    const seq = await this.reserveSeq(projectId)
    await this.db
      .insert(projectTaskSeqs)
      .values({ task_id: taskId, project_id: projectId, seq })
      .onConflictDoNothing({ target: projectTaskSeqs.task_id })
    const claimed = await this.taskSeq(taskId)
    if (claimed === null) throw new Error(`project task '${taskId}' lost its sequence claim`)
    return claimed
  }

  private async taskSeq(taskId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ seq: projectTaskSeqs.seq })
      .from(projectTaskSeqs)
      .where(eq(projectTaskSeqs.task_id, taskId))
    return row?.seq ?? null
  }

  async insertOutcome(row: ProjectOutcomeRow): Promise<boolean> {
    const inserted = await this.db
      .insert(projectOutcomes)
      .values({
        id: row.id,
        project_id: row.projectId,
        stream: row.stream,
        seq: row.seq,
        intent: row.intent,
        schema_version: row.schemaVersion,
        task_id: row.taskId,
        definition_key: row.definitionKey,
        definition_version: row.definitionVersion,
        artifact_refs: JSON.stringify(row.artifactRefs),
        created_at: row.createdAt,
        body_inline: row.body.kind === 'inline' ? row.body.json : null,
        body_artifact_id: row.body.kind === 'offloaded' ? row.body.artifactId : null,
        body_bytes: row.bodyBytes,
      })
      .onConflictDoNothing({ target: projectOutcomes.id })
      .returning({ id: projectOutcomes.id })
    return inserted.length > 0
  }

  async getOutcome(projectId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(projectOutcomes)
      .where(and(eq(projectOutcomes.project_id, projectId), eq(projectOutcomes.id, id)))
    return row ? rowToOutcome(row) : null
  }

  async listOutcomes(projectId: string, stream?: string) {
    const rows = await this.db
      .select()
      .from(projectOutcomes)
      .where(
        stream === undefined
          ? eq(projectOutcomes.project_id, projectId)
          : and(eq(projectOutcomes.project_id, projectId), eq(projectOutcomes.stream, stream)),
      )
      .orderBy(asc(projectOutcomes.seq))
    return rows.map(rowToOutcome)
  }

  async deleteByProjects(projectIds: string[]): Promise<void> {
    for (let i = 0; i < projectIds.length; i += CHUNK) {
      const chunk = projectIds.slice(i, i + CHUNK)
      await this.db.transaction((tx) => deleteProjectRecords(tx, chunk))
    }
  }
}

/** The outcome-storage policy tiers. */
export class DrizzleOutcomeStoragePolicyRepository implements OutcomeStoragePolicyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(ownerKind: OutcomeStorageOwnerKind, ownerId: string) {
    const [row] = await this.db
      .select({ policy: outcomeStoragePolicies.policy })
      .from(outcomeStoragePolicies)
      .where(
        and(
          eq(outcomeStoragePolicies.owner_kind, ownerKind),
          eq(outcomeStoragePolicies.owner_id, ownerId),
        ),
      )
    return row ? decodeOutcomeStoragePolicy(row.policy) : null
  }

  async set(
    ownerKind: OutcomeStorageOwnerKind,
    ownerId: string,
    policy: OutcomeStoragePolicy | null,
  ): Promise<void> {
    const where = and(
      eq(outcomeStoragePolicies.owner_kind, ownerKind),
      eq(outcomeStoragePolicies.owner_id, ownerId),
    )
    if (!policy) {
      await this.db.delete(outcomeStoragePolicies).where(where)
      return
    }
    const encoded = encodeOutcomeStoragePolicy(policy)
    await this.db
      .insert(outcomeStoragePolicies)
      .values({ owner_kind: ownerKind, owner_id: ownerId, policy: encoded })
      .onConflictDoUpdate({
        target: [outcomeStoragePolicies.owner_kind, outcomeStoragePolicies.owner_id],
        set: { policy: encoded },
      })
  }
}
