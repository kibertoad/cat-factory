// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  AccountSettingsRecord,
  AccountSettingsRepository,
  KeyFingerprintStore,
  LocalSettingsRecord,
  LocalSettingsRepository,
  ModelPreset,
  ModelPresetRepository,
  TrackerSettings,
  TrackerSettingsRepository,
  UserSettings,
  UserSettingsRepository,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  accountSettings,
  keyFingerprint,
  localSettings,
  modelPresets,
  trackerSettings,
  userSettings,
  workspaceSettings,
} from '../../db/schema.js'

/** The fixed singleton-row id for the deployment's key fingerprint (ADR 0026 D6.1). */
const KEY_FINGERPRINT_ID = 'key'

export class DrizzleKeyFingerprintStore implements KeyFingerprintStore {
  constructor(
    private readonly db: DrizzleDb,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(keyFingerprint)
      .where(eq(keyFingerprint.id, KEY_FINGERPRINT_ID))
      .limit(1)
    return row?.fingerprint ?? null
  }

  async set(fingerprint: string): Promise<void> {
    // Seed-once: never clobber an existing (possibly-mismatching) value — the boot check
    // relies on the stored fingerprint staying pinned to what secrets were sealed under.
    await this.db
      .insert(keyFingerprint)
      .values({ id: KEY_FINGERPRINT_ID, fingerprint, created_at: this.now() })
      .onConflictDoNothing({ target: keyFingerprint.id })
  }
}

export class DrizzleUserSettingsRepository implements UserSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(userId: string): Promise<UserSettings | null> {
    const [row] = await this.db.select().from(userSettings).where(eq(userSettings.user_id, userId))
    return row ? { spendMonthlyLimit: row.spend_monthly_limit } : null
  }

  async upsert(userId: string, settings: UserSettings): Promise<void> {
    await this.db
      .insert(userSettings)
      .values({
        user_id: userId,
        spend_monthly_limit: settings.spendMonthlyLimit ?? null,
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: userSettings.user_id,
        set: { spend_monthly_limit: settings.spendMonthlyLimit ?? null, updated_at: Date.now() },
      })
  }
}

type ModelPresetRow = typeof modelPresets.$inferSelect

function rowToModelPreset(row: ModelPresetRow): ModelPreset {
  let overrides: Record<string, string> = {}
  try {
    const parsed = JSON.parse(row.overrides) as unknown
    if (parsed && typeof parsed === 'object') overrides = parsed as Record<string, string>
  } catch {
    // A malformed JSON column degrades to no overrides (base model applies to all).
  }
  return {
    id: row.id,
    name: row.name,
    baseModelId: row.base_model_id,
    overrides,
    isDefault: row.is_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Per-workspace model presets over Postgres (the Drizzle mirror of the Worker's
 * `D1ModelPresetRepository`, migration 0006). A preset is one `base_model_id` applied
 * to every agent kind plus per-kind `overrides` (a JSON column). Enforces the
 * single-default invariant: promoting a preset to default demotes every other in the
 * workspace before the upsert. The default preset cannot be removed. Behaviourally
 * identical to the D1 repo so the cross-runtime conformance suite asserts the same
 * preset resolution.
 */

export class DrizzleModelPresetRepository implements ModelPresetRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<ModelPreset | null> {
    const rows = await this.db
      .select()
      .from(modelPresets)
      .where(and(eq(modelPresets.workspace_id, workspaceId), eq(modelPresets.id, id)))
      .limit(1)
    return rows[0] ? rowToModelPreset(rows[0]) : null
  }

  async list(workspaceId: string): Promise<ModelPreset[]> {
    const rows = await this.db
      .select()
      .from(modelPresets)
      .where(eq(modelPresets.workspace_id, workspaceId))
      .orderBy(modelPresets.created_at)
    return rows.map(rowToModelPreset)
  }

  async getDefault(workspaceId: string): Promise<ModelPreset | null> {
    const rows = await this.db
      .select()
      .from(modelPresets)
      .where(and(eq(modelPresets.workspace_id, workspaceId), eq(modelPresets.is_default, 1)))
      .orderBy(modelPresets.created_at)
      .limit(1)
    return rows[0] ? rowToModelPreset(rows[0]) : null
  }

  async upsert(workspaceId: string, preset: ModelPreset): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: preset.id,
      name: preset.name,
      base_model_id: preset.baseModelId,
      overrides: JSON.stringify(preset.overrides),
      is_default: preset.isDefault ? 1 : 0,
      version: preset.version ?? null,
      created_at: preset.createdAt,
    }
    // Demote + upsert run in one transaction so the single-default invariant can never
    // be observed broken (zero or two defaults) by a concurrent reader or partial failure.
    await this.db.transaction(async (tx) => {
      if (preset.isDefault) {
        await tx
          .update(modelPresets)
          .set({ is_default: 0 })
          .where(
            and(
              eq(modelPresets.workspace_id, workspaceId),
              sql`${modelPresets.id} <> ${preset.id}`,
            ),
          )
      }
      await tx
        .insert(modelPresets)
        .values(values)
        .onConflictDoUpdate({
          target: [modelPresets.workspace_id, modelPresets.id],
          set: {
            name: values.name,
            base_model_id: values.base_model_id,
            overrides: values.overrides,
            is_default: values.is_default,
            version: values.version,
          },
        })
    })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(modelPresets)
      .where(
        and(
          eq(modelPresets.workspace_id, workspaceId),
          eq(modelPresets.id, id),
          eq(modelPresets.is_default, 0),
        ),
      )
  }
}

/**
 * A workspace's default service-fragment selection — one row per workspace in
 * `workspace_fragment_defaults`, the fragment ids stored as a JSON array (mirror of the
 * D1 `D1ServiceFragmentDefaultsRepository`). `set` upserts the whole list.
 */

export class DrizzleTrackerSettingsRepository implements TrackerSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<TrackerSettings | null> {
    const [row] = await this.db
      .select()
      .from(trackerSettings)
      .where(eq(trackerSettings.workspace_id, workspaceId))
    if (!row) return null
    return {
      tracker: (row.tracker as TrackerSettings['tracker']) ?? null,
      jiraProjectKey: row.jira_project_key,
      linearTeamId: row.linear_team_id,
      writebackCommentOnPrOpen: row.writeback_comment_on_pr_open === 1,
      writebackResolveOnMerge: row.writeback_resolve_on_merge === 1,
      updatedAt: row.updated_at,
    }
  }

  async put(workspaceId: string, settings: TrackerSettings): Promise<void> {
    await this.db
      .insert(trackerSettings)
      .values({
        workspace_id: workspaceId,
        tracker: settings.tracker,
        jira_project_key: settings.jiraProjectKey,
        linear_team_id: settings.linearTeamId,
        writeback_comment_on_pr_open: settings.writebackCommentOnPrOpen ? 1 : 0,
        writeback_resolve_on_merge: settings.writebackResolveOnMerge ? 1 : 0,
        updated_at: settings.updatedAt,
      })
      .onConflictDoUpdate({
        target: trackerSettings.workspace_id,
        set: {
          tracker: settings.tracker,
          jira_project_key: settings.jiraProjectKey,
          linear_team_id: settings.linearTeamId,
          writeback_comment_on_pr_open: settings.writebackCommentOnPrOpen ? 1 : 0,
          writeback_resolve_on_merge: settings.writebackResolveOnMerge ? 1 : 0,
          updated_at: settings.updatedAt,
        },
      })
  }
}

function rowToWorkspaceSettings(row: typeof workspaceSettings.$inferSelect): WorkspaceSettings {
  let perType: WorkspaceSettings['taskLimitPerType'] = null
  if (row.task_limit_per_type) {
    try {
      perType = JSON.parse(row.task_limit_per_type) as WorkspaceSettings['taskLimitPerType']
    } catch {
      perType = null
    }
  }
  return {
    waitingEscalationMinutes: row.waiting_escalation_minutes,
    taskLimitMode: row.task_limit_mode as WorkspaceSettings['taskLimitMode'],
    taskLimitShared: row.task_limit_shared,
    taskLimitPerType: perType,
    storeAgentContext: row.store_agent_context === 1,
    artifactRetentionDays: row.artifact_retention_days,
    kaizenEnabled: row.kaizen_enabled === 1,
    delegateAgentsToRunnerPool: row.delegate_agents_to_runner_pool === 1,
    reviewFrictionMode: row.review_friction_mode as WorkspaceSettings['reviewFrictionMode'],
    reviewFrictionWarnCount: row.review_friction_warn_count,
    reviewFrictionBlockCount: row.review_friction_block_count,
    reviewFrictionBlockStuckMinutes: row.review_friction_block_stuck_minutes,
    spendCurrency: row.spend_currency,
    spendMonthlyLimit: row.spend_monthly_limit,
  }
}

/**
 * Per-workspace runtime settings over Postgres (the Drizzle mirror of the Worker's
 * `D1WorkspaceSettingsRepository`, migration 0004). One row per workspace; the service
 * lazily seeds the default, so an absent row reads as null. Per-type task limits are a
 * JSON column.
 */

export class DrizzleWorkspaceSettingsRepository implements WorkspaceSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<WorkspaceSettings | null> {
    const rows = await this.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    return row ? rowToWorkspaceSettings(row) : null
  }

  async listByWorkspaceIds(workspaceIds: string[]): Promise<Map<string, WorkspaceSettings>> {
    const out = new Map<string, WorkspaceSettings>()
    if (workspaceIds.length === 0) return out
    for (let i = 0; i < workspaceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(workspaceSettings)
        .where(inArray(workspaceSettings.workspace_id, workspaceIds.slice(i, i + 500)))
      for (const row of rows) out.set(row.workspace_id, rowToWorkspaceSettings(row))
    }
    return out
  }

  async upsert(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      waiting_escalation_minutes: settings.waitingEscalationMinutes,
      task_limit_mode: settings.taskLimitMode,
      task_limit_shared: settings.taskLimitShared,
      task_limit_per_type: settings.taskLimitPerType
        ? JSON.stringify(settings.taskLimitPerType)
        : null,
      store_agent_context: settings.storeAgentContext ? 1 : 0,
      artifact_retention_days: settings.artifactRetentionDays,
      kaizen_enabled: settings.kaizenEnabled ? 1 : 0,
      delegate_agents_to_runner_pool: settings.delegateAgentsToRunnerPool ? 1 : 0,
      review_friction_mode: settings.reviewFrictionMode,
      review_friction_warn_count: settings.reviewFrictionWarnCount,
      review_friction_block_count: settings.reviewFrictionBlockCount,
      review_friction_block_stuck_minutes: settings.reviewFrictionBlockStuckMinutes,
      spend_currency: settings.spendCurrency,
      spend_monthly_limit: settings.spendMonthlyLimit,
    }
    await this.db
      .insert(workspaceSettings)
      .values(values)
      .onConflictDoUpdate({
        target: [workspaceSettings.workspace_id],
        set: {
          waiting_escalation_minutes: values.waiting_escalation_minutes,
          task_limit_mode: values.task_limit_mode,
          task_limit_shared: values.task_limit_shared,
          task_limit_per_type: values.task_limit_per_type,
          store_agent_context: values.store_agent_context,
          artifact_retention_days: values.artifact_retention_days,
          kaizen_enabled: values.kaizen_enabled,
          delegate_agents_to_runner_pool: values.delegate_agents_to_runner_pool,
          review_friction_mode: values.review_friction_mode,
          review_friction_warn_count: values.review_friction_warn_count,
          review_friction_block_count: values.review_friction_block_count,
          review_friction_block_stuck_minutes: values.review_friction_block_stuck_minutes,
          spend_currency: values.spend_currency,
          spend_monthly_limit: values.spend_monthly_limit,
        },
      })
  }
}

/**
 * A workspace's observability connection over Postgres (the Drizzle mirror of the Worker's
 * `D1ObservabilityConnectionRepository`, migration 0007). One row per workspace; the
 * provider-specific credentials are stored as a sealed JSON blob (encrypted by the caller),
 * with a non-secret `summary` blob for display.
 */

export class DrizzleAccountSettingsRepository implements AccountSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByAccount(accountId: string): Promise<AccountSettingsRecord | null> {
    const rows = await this.db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.account_id, accountId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      accountId: row.account_id,
      config: row.config,
      secretsCipher: row.secrets_cipher,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: AccountSettingsRecord): Promise<void> {
    const values = {
      account_id: record.accountId,
      config: record.config,
      secrets_cipher: record.secretsCipher,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(accountSettings)
      .values(values)
      .onConflictDoUpdate({
        target: accountSettings.account_id,
        set: {
          config: values.config,
          secrets_cipher: values.secrets_cipher,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async listAll(): Promise<AccountSettingsRecord[]> {
    const rows = await this.db.select().from(accountSettings)
    return rows.map((row) => ({
      accountId: row.account_id,
      config: row.config,
      secretsCipher: row.secrets_cipher,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
}

/** The fixed key for the local-mode settings singleton row (one developer's machine). */

const LOCAL_SETTINGS_ID = 'local'

/**
 * The local-mode operational settings singleton (warm-pool sizing + per-repo checkout
 * reuse), replacing the old `LOCAL_POOL_*` / `HARNESS_*` env vars. One row, addressed by a
 * fixed id. Local-mode-only — there is no D1 mirror (the warm pool is the local Docker
 * runner's differentiator).
 */

export class DrizzleLocalSettingsRepository implements LocalSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(): Promise<LocalSettingsRecord | null> {
    const rows = await this.db
      .select()
      .from(localSettings)
      .where(eq(localSettings.id, LOCAL_SETTINGS_ID))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { config: row.config, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  async upsert(record: LocalSettingsRecord): Promise<void> {
    await this.db
      .insert(localSettings)
      .values({
        id: LOCAL_SETTINGS_ID,
        config: record.config,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: localSettings.id,
        set: { config: record.config, updated_at: record.updatedAt },
      })
  }
}
