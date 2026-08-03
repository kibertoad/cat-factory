// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  IncidentEnrichmentConnectionRecord,
  IncidentEnrichmentConnectionRepository,
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  ObservabilityProviderKind,
  PackageRegistryConnectionRecord,
  PackageRegistryConnectionRepository,
  ReleaseHealthConfigRecord,
  ReleaseHealthConfigRepository,
  ValidationConfigRecord,
  ValidationConfigRepository,
  SubscriptionQuotaCycleRecord,
  SubscriptionQuotaCycleRepository,
  SubscriptionQuotaScope,
  SubscriptionQuotaWindowKind,
  TestSecretRecord,
  TestSecretsRepository,
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
} from '@cat-factory/kernel'
import type { SubscriptionVendor } from '@cat-factory/contracts'
import { subscriptionVendorSchema } from '@cat-factory/contracts'
import { decodeEnum } from '@cat-factory/server'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  incidentEnrichmentConnections,
  observabilityConnections,
  packageRegistryConnections,
  releaseHealthConfigs,
  validationConfigs,
  subscriptionQuotaCycles,
  testSecrets,
  capabilityCredentials,
} from '../../db/schema.js'

export class DrizzleObservabilityConnectionRepository implements ObservabilityConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<ObservabilityConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(observabilityConnections)
      .where(eq(observabilityConnections.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      provider: row.provider as ObservabilityProviderKind,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: ObservabilityConnectionRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      provider: record.provider,
      credentials: record.credentials,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(observabilityConnections)
      .values(values)
      .onConflictDoUpdate({
        target: observabilityConnections.workspace_id,
        set: {
          provider: values.provider,
          credentials: values.credentials,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .delete(observabilityConnections)
      .where(eq(observabilityConnections.workspace_id, workspaceId))
  }
}

/**
 * Postgres-backed modeled subscription quota-cycle counters (the Drizzle mirror of the
 * Worker's `D1SubscriptionQuotaCycleRepository`, migration 0047), column-for-column so
 * behaviour matches across stores.
 */

export class DrizzleSubscriptionQuotaCycleRepository implements SubscriptionQuotaCycleRepository {
  constructor(private readonly db: DrizzleDb) {}

  async recordUsage(
    key: {
      id: string
      scope: SubscriptionQuotaScope
      scopeId: string
      vendor: SubscriptionVendor
      windowKind: SubscriptionQuotaWindowKind
    },
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // Windowed UPSERT (mirrors the D1 repo): INSERT anchors a fresh window at `at`; on
    // conflict, an active window (younger than `windowMs`) accumulates and a stale one
    // resets to `at`. Every SET RHS reads the row's pre-update values, so referencing
    // `window_started_at` in the counter branches is safe though it's also reassigned.
    const cols = subscriptionQuotaCycles
    const active = sql`(${at} - ${cols.window_started_at} < ${windowMs})`
    await this.db
      .insert(cols)
      .values({
        id: key.id,
        scope: key.scope,
        scope_id: key.scopeId,
        vendor: key.vendor,
        window_kind: key.windowKind,
        window_started_at: at,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        request_count: 1,
        updated_at: at,
      })
      .onConflictDoUpdate({
        target: [cols.scope, cols.scope_id, cols.vendor, cols.window_kind],
        set: {
          window_started_at: sql`CASE WHEN ${active} THEN ${cols.window_started_at} ELSE ${at} END`,
          input_tokens: sql`CASE WHEN ${active} THEN ${cols.input_tokens} ELSE 0 END + ${usage.inputTokens}`,
          output_tokens: sql`CASE WHEN ${active} THEN ${cols.output_tokens} ELSE 0 END + ${usage.outputTokens}`,
          request_count: sql`CASE WHEN ${active} THEN ${cols.request_count} ELSE 0 END + 1`,
          updated_at: at,
        },
      })
  }

  async listByScopeVendor(
    scope: SubscriptionQuotaScope,
    scopeId: string,
    vendor: SubscriptionVendor,
  ): Promise<SubscriptionQuotaCycleRecord[]> {
    const rows = await this.db
      .select()
      .from(subscriptionQuotaCycles)
      .where(
        and(
          eq(subscriptionQuotaCycles.scope, scope),
          eq(subscriptionQuotaCycles.scope_id, scopeId),
          eq(subscriptionQuotaCycles.vendor, vendor),
        ),
      )
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope as SubscriptionQuotaScope,
      scopeId: row.scope_id,
      vendor: decodeEnum(subscriptionVendorSchema, row.vendor, {
        table: 'subscription_quota_cycles',
        column: 'vendor',
        id: row.id,
      }),
      windowKind: row.window_kind as SubscriptionQuotaWindowKind,
      windowStartedAt: row.window_started_at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      requestCount: row.request_count,
      updatedAt: row.updated_at,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(subscriptionQuotaCycles)
      .where(lt(subscriptionQuotaCycles.window_started_at, epochMs))
      .returning({ id: subscriptionQuotaCycles.id })
    return deleted.length
  }
}

/**
 * A workspace's private package-registry connection over Postgres (the Drizzle mirror
 * of the Worker's `D1PackageRegistryConnectionRepository`, migration 0034). One row per
 * workspace; the registry entries are stored as ONE sealed JSON array (encrypted by the
 * caller), with a non-secret `summary` blob for display.
 */

export class DrizzlePackageRegistryConnectionRepository implements PackageRegistryConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<PackageRegistryConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(packageRegistryConnections)
      .where(eq(packageRegistryConnections.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      entries: row.entries,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: PackageRegistryConnectionRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      entries: record.entries,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(packageRegistryConnections)
      .values(values)
      .onConflictDoUpdate({
        target: packageRegistryConnections.workspace_id,
        set: {
          entries: values.entries,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .delete(packageRegistryConnections)
      .where(eq(packageRegistryConnections.workspace_id, workspaceId))
  }
}

/**
 * A workspace's incident-enrichment connection over Postgres (the Drizzle mirror of the
 * Worker's `D1IncidentEnrichmentConnectionRepository`, migration 0013). One row per
 * workspace; both PagerDuty + incident.io credentials live in ONE sealed JSON blob
 * (encrypted by the caller), with a non-secret `summary` presence blob.
 */

export class DrizzleIncidentEnrichmentConnectionRepository implements IncidentEnrichmentConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<IncidentEnrichmentConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(incidentEnrichmentConnections)
      .where(eq(incidentEnrichmentConnections.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: IncidentEnrichmentConnectionRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      credentials: record.credentials,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(incidentEnrichmentConnections)
      .values(values)
      .onConflictDoUpdate({
        target: incidentEnrichmentConnections.workspace_id,
        set: {
          credentials: values.credentials,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .delete(incidentEnrichmentConnections)
      .where(eq(incidentEnrichmentConnections.workspace_id, workspaceId))
  }
}

/**
 * Per-account (deployment-wide) settings over Postgres (the Drizzle mirror of the Worker's
 * `D1AccountSettingsRepository`, migration 0014). One row per account; `config` + `summary`
 * are non-secret JSON, the ONE sealed `secrets_cipher` blob is encrypted by the caller.
 */

function parseReleaseIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

type ReleaseHealthConfigRow = typeof releaseHealthConfigs.$inferSelect

function rowToReleaseHealthConfig(row: ReleaseHealthConfigRow): ReleaseHealthConfigRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    monitorIds: parseReleaseIds(row.monitor_ids),
    sloIds: parseReleaseIds(row.slo_ids),
    envTag: row.env_tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-block monitor/SLO mapping for the post-release-health gate over Postgres (the
 * Drizzle mirror of the Worker's `D1ReleaseHealthConfigRepository`, migration 0003).
 */

export class DrizzleReleaseHealthConfigRepository implements ReleaseHealthConfigRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<ReleaseHealthConfigRecord | null> {
    const rows = await this.db
      .select()
      .from(releaseHealthConfigs)
      .where(
        and(
          eq(releaseHealthConfigs.workspace_id, workspaceId),
          eq(releaseHealthConfigs.block_id, blockId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToReleaseHealthConfig(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ReleaseHealthConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(releaseHealthConfigs)
      .where(eq(releaseHealthConfigs.workspace_id, workspaceId))
      .orderBy(releaseHealthConfigs.block_id)
    return rows.map(rowToReleaseHealthConfig)
  }

  async upsert(record: ReleaseHealthConfigRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      monitor_ids: JSON.stringify(record.monitorIds),
      slo_ids: JSON.stringify(record.sloIds),
      env_tag: record.envTag,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(releaseHealthConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [releaseHealthConfigs.workspace_id, releaseHealthConfigs.block_id],
        set: {
          monitor_ids: values.monitor_ids,
          slo_ids: values.slo_ids,
          env_tag: values.env_tag,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(releaseHealthConfigs)
      .where(
        and(
          eq(releaseHealthConfigs.workspace_id, workspaceId),
          eq(releaseHealthConfigs.block_id, blockId),
        ),
      )
  }
}

type ValidationConfigRow = typeof validationConfigs.$inferSelect

/**
 * Parse the persisted `checks` JSON array, tolerating a corrupt/legacy row: a malformed blob
 * degrades to "no checks configured" — the exact pre-feature behaviour — rather than throwing
 * inside a dispatch. Mirrors the D1 repository's parser.
 */
function parseValidationChecks(json: string): { label: string; command: string }[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .filter((x) => typeof x.command === 'string' && x.command !== '')
      .map((x) => ({
        label: typeof x.label === 'string' && x.label ? x.label : (x.command as string),
        command: x.command as string,
      }))
  } catch {
    return []
  }
}

function rowToValidationConfig(row: ValidationConfigRow): ValidationConfigRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    checks: parseValidationChecks(row.checks),
    maxAttempts: row.max_attempts,
    // Absent rather than empty — mirrors the D1 repository; a stored `''` would otherwise reach
    // the harness as a command to run.
    ...(row.dependency_install ? { dependencyInstall: row.dependency_install } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A service frame's PRE-PR VALIDATION CHECKS over Postgres (the Drizzle mirror of the Worker's
 * `D1ValidationConfigRepository`, migration 0061): the commands the harness runs against the
 * checkout before opening a PR. At most one row per (workspace, block); `checks` is a JSON array
 * of `{ label, command }`. See docs/initiatives/pre-pr-validation.md.
 */
export class DrizzleValidationConfigRepository implements ValidationConfigRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<ValidationConfigRecord | null> {
    const rows = await this.db
      .select()
      .from(validationConfigs)
      .where(
        and(
          eq(validationConfigs.workspace_id, workspaceId),
          eq(validationConfigs.block_id, blockId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToValidationConfig(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ValidationConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(validationConfigs)
      .where(eq(validationConfigs.workspace_id, workspaceId))
      .orderBy(validationConfigs.block_id)
    return rows.map(rowToValidationConfig)
  }

  async upsert(record: ValidationConfigRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      checks: JSON.stringify(record.checks),
      max_attempts: record.maxAttempts,
      dependency_install: record.dependencyInstall ?? null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(validationConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [validationConfigs.workspace_id, validationConfigs.block_id],
        set: {
          checks: values.checks,
          max_attempts: values.max_attempts,
          dependency_install: values.dependency_install,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(validationConfigs)
      .where(
        and(
          eq(validationConfigs.workspace_id, workspaceId),
          eq(validationConfigs.block_id, blockId),
        ),
      )
  }
}

/**
 * A service frame's sensitive test credentials over Postgres (the Drizzle mirror of the
 * Worker's `D1TestSecretsRepository`, migration 0044). At most one row per (workspace, block);
 * `credentials` is a sealed envelope of the `TestSecretEntry[]` JSON, `summary` a non-secret
 * `TestSecretRef[]` display blob.
 */

export class DrizzleTestSecretsRepository implements TestSecretsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<TestSecretRecord | null> {
    const rows = await this.db
      .select()
      .from(testSecrets)
      .where(and(eq(testSecrets.workspace_id, workspaceId), eq(testSecrets.block_id, blockId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      blockId: row.block_id,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async listByWorkspace(workspaceId: string): Promise<TestSecretRecord[]> {
    const rows = await this.db
      .select()
      .from(testSecrets)
      .where(eq(testSecrets.workspace_id, workspaceId))
      .orderBy(testSecrets.block_id)
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      blockId: row.block_id,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async upsert(record: TestSecretRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      credentials: record.credentials,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(testSecrets)
      .values(values)
      .onConflictDoUpdate({
        target: [testSecrets.workspace_id, testSecrets.block_id],
        set: {
          credentials: values.credentials,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(testSecrets)
      .where(and(eq(testSecrets.workspace_id, workspaceId), eq(testSecrets.block_id, blockId)))
  }
}

/**
 * A workspace's capability credentials — the sealed, tenant-scoped home for the secrets a
 * registered tool server or generative binary integration declares by name. One row per
 * workspace; `credentials` is the sealed `CapabilityCredentialEntry[]` blob, `summary` the
 * non-secret display list. The D1 mirror is `D1CapabilityCredentialRepository`.
 */
export class DrizzleCapabilityCredentialRepository implements CapabilityCredentialRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<CapabilityCredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(capabilityCredentials)
      .where(eq(capabilityCredentials.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: CapabilityCredentialRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      credentials: record.credentials,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(capabilityCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: capabilityCredentials.workspace_id,
        set: {
          credentials: values.credentials,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .delete(capabilityCredentials)
      .where(eq(capabilityCredentials.workspace_id, workspaceId))
  }
}
