// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import { parseStoredAccountSettingsConfig } from '@cat-factory/contracts'
import type {
  AccountSettingsConfig,
  AccountSettingsRecord,
  AccountSettingsRepository,
  AgentPromptRepository,
  AgentPromptRevision,
  KeyFingerprintStore,
  LocalSettingsRecord,
  LocalSettingsRepository,
  ModelPreset,
  ModelPresetRepository,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  ReviewQuestionPostClaimWindow,
  ReviewQuestionPostKey,
  ReviewQuestionPostRecord,
  ReviewQuestionPostRepository,
  ReviewQuestionPostStatus,
  TaskSourceKind,
  TaskTypeSuppressionRepository,
  TrackerCommentIngestClaimWindow,
  TrackerCommentIngestKey,
  TrackerCommentIngestRecord,
  TrackerCommentIngestRepository,
  TrackerCommentIngestStatus,
  TrackerSettings,
  TrackerSettingsRepository,
  TutorialDecision,
  TutorialProgress,
  TutorialProgressRepository,
  UserSettings,
  UserSettingsRepository,
  WorkspaceAgentSettings,
  WorkspaceAgentSettingsRepository,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  parseNotificationWebhookTypes,
  parsePlatformAlertEvents,
  parseProviderPreferenceColumn,
  parseRunLifecycleEvents,
  serializeProviderPreferenceColumn,
} from '@cat-factory/server'
import { and, desc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  accountSettings,
  agentPromptRevisions,
  keyFingerprint,
  localSettings,
  modelPresets,
  notificationWebhooks,
  reviewQuestionPosts,
  taskTypeSuppressions,
  trackerCommentIngests,
  trackerSettings,
  tutorialProgress,
  userSettings,
  workspaceAgentSettings,
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

/**
 * Parse a stored JSON id array LENIENTLY: anything that is not an array of strings reads as empty.
 *
 * The row is composed by a browser, so an unparseable value means a client wrote something
 * unexpected. Throwing would take down the workspace snapshot this is read as part of, over a
 * tutorial-progress list; forgetting the walkthroughs costs a re-offer, not the board. Byte-for-byte
 * the D1 repository's rule, per the runtime-symmetry requirement that both stores map a row the
 * same way.
 */
function parseTourIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // silent-catch-ok: a malformed list degrades to "no tours remembered"; the fallback IS the
    // report, and there is nothing an operator would do about one row of client-authored JSON.
    return []
  }
}

/** The stored decision, narrowed against the closed vocabulary; anything else = never answered. */
function parseTutorialDecision(raw: string | null): TutorialDecision | null {
  return raw === 'accepted' || raw === 'declined' ? raw : null
}

/** Postgres-backed per-user tutorial progress (mirror of D1 migration 0080). */
export class DrizzleTutorialProgressRepository implements TutorialProgressRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(userId: string): Promise<TutorialProgress | null> {
    const [row] = await this.db
      .select()
      .from(tutorialProgress)
      .where(eq(tutorialProgress.user_id, userId))
    return row
      ? {
          decision: parseTutorialDecision(row.decision),
          completedTourIds: parseTourIds(row.completed_tour_ids),
          nudgedTourIds: parseTourIds(row.nudged_tour_ids),
        }
      : null
  }

  async upsert(userId: string, progress: TutorialProgress): Promise<void> {
    const values = {
      decision: progress.decision,
      completed_tour_ids: JSON.stringify(progress.completedTourIds),
      nudged_tour_ids: JSON.stringify(progress.nudgedTourIds),
      updated_at: Date.now(),
    }
    await this.db
      .insert(tutorialProgress)
      .values({ user_id: userId, ...values })
      .onConflictDoUpdate({ target: tutorialProgress.user_id, set: values })
  }

  async remove(userId: string): Promise<void> {
    await this.db.delete(tutorialProgress).where(eq(tutorialProgress.user_id, userId))
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
  const providerPreference = parseProviderPreferenceColumn(row.provider_preference)
  return {
    id: row.id,
    name: row.name,
    baseModelId: row.base_model_id,
    overrides,
    isDefault: row.is_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    ...(providerPreference ? { providerPreference } : {}),
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
      provider_preference: serializeProviderPreferenceColumn(preset.providerPreference),
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
            provider_preference: values.provider_preference,
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
      writebackQuestionsOnPark: row.writeback_questions_on_park === 1,
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
        writeback_questions_on_park: settings.writebackQuestionsOnPark ? 1 : 0,
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
          writeback_questions_on_park: settings.writebackQuestionsOnPark ? 1 : 0,
          updated_at: settings.updatedAt,
        },
      })
  }
}

/**
 * A workspace's outbound notification webhooks — keyed by (workspace, endpoint id) in
 * `notification_webhooks` (mirror of the D1 `D1NotificationWebhookRepository`). The filters are
 * JSON arrays decoded through the SHARED parsers both runtimes use, so the columns can't drift.
 */
export class DrizzleNotificationWebhookRepository implements NotificationWebhookRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<NotificationWebhookRecord | null> {
    const [row] = await this.db
      .select()
      .from(notificationWebhooks)
      .where(
        and(eq(notificationWebhooks.workspace_id, workspaceId), eq(notificationWebhooks.id, id)),
      )
    return row ? rowToNotificationWebhook(row) : null
  }

  async list(workspaceId: string): Promise<NotificationWebhookRecord[]> {
    const rows = await this.db
      .select()
      .from(notificationWebhooks)
      .where(eq(notificationWebhooks.workspace_id, workspaceId))
      .orderBy(notificationWebhooks.id)
    return rows.map(rowToNotificationWebhook)
  }

  async put(record: NotificationWebhookRecord): Promise<void> {
    const values = {
      name: record.name,
      url: record.url,
      types: JSON.stringify(record.types),
      run_events: JSON.stringify(record.runEvents),
      alert_events: JSON.stringify(record.alertEvents),
      enabled: record.enabled ? 1 : 0,
      secret_sealed: record.secretSealed,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(notificationWebhooks)
      .values({ workspace_id: record.workspaceId, id: record.id, ...values })
      .onConflictDoUpdate({
        target: [notificationWebhooks.workspace_id, notificationWebhooks.id],
        set: values,
      })
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(notificationWebhooks)
      .where(
        and(eq(notificationWebhooks.workspace_id, workspaceId), eq(notificationWebhooks.id, id)),
      )
  }
}

function rowToNotificationWebhook(
  row: typeof notificationWebhooks.$inferSelect,
): NotificationWebhookRecord {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    name: row.name,
    url: row.url,
    types: parseNotificationWebhookTypes(row.types),
    runEvents: parseRunLifecycleEvents(row.run_events),
    alertEvents: parsePlatformAlertEvents(row.alert_events),
    enabled: row.enabled === 1,
    secretSealed: row.secret_sealed,
    updatedAt: row.updated_at,
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
  let metadata: WorkspaceSettings['metadata'] = {}
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as WorkspaceSettings['metadata']
    } catch {
      // An unparseable blob reads as "nothing filled in", never as a missing key — the
      // settings object is total, so every reader can index it without a null check.
      metadata = {}
    }
  }
  return {
    waitingEscalationMinutes: row.waiting_escalation_minutes,
    taskLimitMode: row.task_limit_mode as WorkspaceSettings['taskLimitMode'],
    taskLimitShared: row.task_limit_shared,
    taskLimitPerType: perType,
    storeAgentContext: row.store_agent_context === 1,
    publishPrVerificationReport: row.publish_pr_verification_report === 1,
    artifactRetentionDays: row.artifact_retention_days,
    kaizenEnabled: row.kaizen_enabled === 1,
    delegateAgentsToRunnerPool: row.delegate_agents_to_runner_pool === 1,
    inputGateMode: row.input_gate_mode as WorkspaceSettings['inputGateMode'],
    reviewFrictionMode: row.review_friction_mode as WorkspaceSettings['reviewFrictionMode'],
    reviewFrictionWarnCount: row.review_friction_warn_count,
    reviewFrictionBlockCount: row.review_friction_block_count,
    reviewFrictionBlockStuckMinutes: row.review_friction_block_stuck_minutes,
    spendCurrency: row.spend_currency,
    spendMonthlyLimit: row.spend_monthly_limit,
    defaultProvisionType:
      (row.default_provision_type as WorkspaceSettings['defaultProvisionType']) ?? null,
    defaultProvisionManifestId: row.default_provision_manifest_id,
    allowInitiatorPat: row.allow_initiator_pat === 1,
    metadata,
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
      publish_pr_verification_report: settings.publishPrVerificationReport ? 1 : 0,
      artifact_retention_days: settings.artifactRetentionDays,
      kaizen_enabled: settings.kaizenEnabled ? 1 : 0,
      delegate_agents_to_runner_pool: settings.delegateAgentsToRunnerPool ? 1 : 0,
      input_gate_mode: settings.inputGateMode,
      review_friction_mode: settings.reviewFrictionMode,
      review_friction_warn_count: settings.reviewFrictionWarnCount,
      review_friction_block_count: settings.reviewFrictionBlockCount,
      review_friction_block_stuck_minutes: settings.reviewFrictionBlockStuckMinutes,
      spend_currency: settings.spendCurrency,
      spend_monthly_limit: settings.spendMonthlyLimit,
      default_provision_type: settings.defaultProvisionType,
      default_provision_manifest_id: settings.defaultProvisionManifestId,
      allow_initiator_pat: settings.allowInitiatorPat ? 1 : 0,
      metadata: JSON.stringify(settings.metadata),
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
          publish_pr_verification_report: values.publish_pr_verification_report,
          artifact_retention_days: values.artifact_retention_days,
          kaizen_enabled: values.kaizen_enabled,
          delegate_agents_to_runner_pool: values.delegate_agents_to_runner_pool,
          input_gate_mode: values.input_gate_mode,
          review_friction_mode: values.review_friction_mode,
          review_friction_warn_count: values.review_friction_warn_count,
          review_friction_block_count: values.review_friction_block_count,
          review_friction_block_stuck_minutes: values.review_friction_block_stuck_minutes,
          spend_currency: values.spend_currency,
          spend_monthly_limit: values.spend_monthly_limit,
          default_provision_type: values.default_provision_type,
          default_provision_manifest_id: values.default_provision_manifest_id,
          allow_initiator_pat: values.allow_initiator_pat,
          metadata: values.metadata,
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

  // Selects the `config` COLUMN alone — never `secrets_cipher`. That is the whole reason this
  // method can be proxied to a mothership node while `getByAccount` cannot; see the port doc.
  async getConfigByAccount(accountId: string): Promise<AccountSettingsConfig> {
    const rows = await this.db
      .select({ config: accountSettings.config })
      .from(accountSettings)
      .where(eq(accountSettings.account_id, accountId))
      .limit(1)
    return parseStoredAccountSettingsConfig(rows[0]?.config)
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

/**
 * Idempotency markers for the headless clarification loop's question writeback — one row per
 * `(workspace, review, iteration, linked issue)` in `review_question_posts` (mirror of the D1
 * `D1ReviewQuestionPostRepository`).
 *
 * {@link claim} is a single atomic statement on purpose: an insert that, on conflict, only
 * updates a row already marked `failed` (or a `pending` one abandoned by a poster that died
 * mid-post), with `RETURNING` reporting whether either half fired. A read-then-write would let
 * two concurrent driver replays both decide to post.
 */
export class DrizzleReviewQuestionPostRepository implements ReviewQuestionPostRepository {
  constructor(private readonly db: DrizzleDb) {}

  private where(key: ReviewQuestionPostKey) {
    return and(
      eq(reviewQuestionPosts.workspace_id, key.workspaceId),
      eq(reviewQuestionPosts.review_id, key.reviewId),
      eq(reviewQuestionPosts.iteration, key.iteration),
      eq(reviewQuestionPosts.issue_ref, key.issueRef),
    )
  }

  async claim(key: ReviewQuestionPostKey, window: ReviewQuestionPostClaimWindow): Promise<boolean> {
    const claimed = await this.db
      .insert(reviewQuestionPosts)
      .values({
        workspace_id: key.workspaceId,
        review_id: key.reviewId,
        iteration: key.iteration,
        issue_ref: key.issueRef,
        status: 'pending',
        attempts: 1,
        error: null,
        updated_at: window.now,
      })
      .onConflictDoUpdate({
        target: [
          reviewQuestionPosts.workspace_id,
          reviewQuestionPosts.review_id,
          reviewQuestionPosts.iteration,
          reviewQuestionPosts.issue_ref,
        ],
        set: {
          status: 'pending',
          attempts: sql`${reviewQuestionPosts.attempts} + 1`,
          error: null,
          updated_at: window.now,
        },
        // `failed` retries a tracker outage; an old `pending` takes over from a poster that
        // died mid-post (see REVIEW_QUESTION_POST_CLAIM_TTL_MS). A fresh `pending` is a post
        // still in flight and must NOT be stolen.
        setWhere: or(
          eq(reviewQuestionPosts.status, 'failed'),
          and(
            eq(reviewQuestionPosts.status, 'pending'),
            lte(reviewQuestionPosts.updated_at, window.reclaimPendingBefore),
          ),
        ),
      })
      .returning({ issueRef: reviewQuestionPosts.issue_ref })
    return claimed.length > 0
  }

  async settle(
    key: ReviewQuestionPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .update(reviewQuestionPosts)
      .set({
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updated_at: now,
      })
      .where(this.where(key))
  }

  async get(key: ReviewQuestionPostKey): Promise<ReviewQuestionPostRecord | null> {
    const [row] = await this.db.select().from(reviewQuestionPosts).where(this.where(key)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      reviewId: row.review_id,
      iteration: row.iteration,
      issueRef: row.issue_ref,
      status: row.status as ReviewQuestionPostStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}

/**
 * Idempotency markers for INBOUND tracker comments — one row per
 * `(workspace, source, externalId, commentId)` in `tracker_comment_ingests` (mirror of the D1
 * `D1TrackerCommentIngestRepository`).
 *
 * Same atomic-claim shape as {@link DrizzleReviewQuestionPostRepository} above, for the same
 * reason: a read-then-write would let two concurrent deliveries of one comment both decide to
 * apply it, and each apply answers a finding a human is reading.
 */
export class DrizzleTrackerCommentIngestRepository implements TrackerCommentIngestRepository {
  constructor(private readonly db: DrizzleDb) {}

  private where(key: TrackerCommentIngestKey) {
    return and(
      eq(trackerCommentIngests.workspace_id, key.workspaceId),
      eq(trackerCommentIngests.source, key.source),
      eq(trackerCommentIngests.external_id, key.externalId),
      eq(trackerCommentIngests.comment_id, key.commentId),
    )
  }

  async claim(
    key: TrackerCommentIngestKey,
    window: TrackerCommentIngestClaimWindow,
  ): Promise<boolean> {
    const claimed = await this.db
      .insert(trackerCommentIngests)
      .values({
        workspace_id: key.workspaceId,
        source: key.source,
        external_id: key.externalId,
        comment_id: key.commentId,
        status: 'pending',
        attempts: 1,
        error: null,
        updated_at: window.now,
      })
      .onConflictDoUpdate({
        target: [
          trackerCommentIngests.workspace_id,
          trackerCommentIngests.source,
          trackerCommentIngests.external_id,
          trackerCommentIngests.comment_id,
        ],
        set: {
          status: 'pending',
          attempts: sql`${trackerCommentIngests.attempts} + 1`,
          error: null,
          updated_at: window.now,
        },
        // `failed` retries a transient failure; an old `pending` takes over from an ingester that
        // died mid-apply (see TRACKER_COMMENT_INGEST_CLAIM_TTL_MS). A fresh `pending` is an apply
        // still in flight and must NOT be stolen.
        setWhere: or(
          eq(trackerCommentIngests.status, 'failed'),
          and(
            eq(trackerCommentIngests.status, 'pending'),
            lte(trackerCommentIngests.updated_at, window.reclaimPendingBefore),
          ),
        ),
      })
      .returning({ commentId: trackerCommentIngests.comment_id })
    return claimed.length > 0
  }

  async settle(
    key: TrackerCommentIngestKey,
    outcome: { status: 'applied' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .update(trackerCommentIngests)
      .set({
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updated_at: now,
      })
      .where(this.where(key))
  }

  async get(key: TrackerCommentIngestKey): Promise<TrackerCommentIngestRecord | null> {
    const [row] = await this.db.select().from(trackerCommentIngests).where(this.where(key)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      externalId: row.external_id,
      commentId: row.comment_id,
      status: row.status as TrackerCommentIngestStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}

/** The row shape every read below projects, so the mapper is shared across the three queries. */
interface AgentPromptRow {
  agent_kind: string
  revision: number
  text: string | null
  restored_from: number | null
  created_at: number
  created_by: string | null
}

function rowToAgentPromptRevision(row: AgentPromptRow): AgentPromptRevision {
  return {
    agentKind: row.agent_kind,
    revision: row.revision,
    text: row.text,
    ...(row.restored_from != null ? { restoredFrom: row.restored_from } : {}),
    createdAt: row.created_at,
    ...(row.created_by != null ? { createdBy: row.created_by } : {}),
  }
}

/**
 * Per-workspace agent system-prompt overrides — the Drizzle mirror of
 * `D1AgentPromptRepository`. Append-only; the highest `revision` for a kind is live, and a
 * `text` of NULL is the "follow the shipped built-in" revision.
 *
 * `append` is a plain INSERT on purpose. The service allocates the next revision number from
 * what it read, so the primary-key collision IS the concurrency control and must reach the
 * caller (mapped to a 409) rather than being absorbed by an `onConflictDoUpdate`, which would
 * let a second editor's save silently overwrite the first's.
 */
export class DrizzleAgentPromptRepository implements AgentPromptRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listRevisions(workspaceId: string, agentKind: string): Promise<AgentPromptRevision[]> {
    const rows = await this.db
      .select()
      .from(agentPromptRevisions)
      .where(
        and(
          eq(agentPromptRevisions.workspace_id, workspaceId),
          eq(agentPromptRevisions.agent_kind, agentKind),
        ),
      )
      .orderBy(desc(agentPromptRevisions.revision))
    return rows.map(rowToAgentPromptRevision)
  }

  async listHeads(workspaceId: string): Promise<AgentPromptRevision[]> {
    // The per-kind MAX is computed in SQL and joined back, rather than reading the whole
    // workspace's log and reducing in JS: history only grows, and the pipeline builder asks
    // for this index every time it opens.
    const heads = this.db
      .select({
        agentKind: sql<string>`${agentPromptRevisions.agent_kind}`.as('head_agent_kind'),
        revision: sql<number>`max(${agentPromptRevisions.revision})`.as('head_revision'),
      })
      .from(agentPromptRevisions)
      .where(eq(agentPromptRevisions.workspace_id, workspaceId))
      .groupBy(agentPromptRevisions.agent_kind)
      .as('heads')

    const rows = await this.db
      .select({
        agent_kind: agentPromptRevisions.agent_kind,
        revision: agentPromptRevisions.revision,
        text: agentPromptRevisions.text,
        restored_from: agentPromptRevisions.restored_from,
        created_at: agentPromptRevisions.created_at,
        created_by: agentPromptRevisions.created_by,
      })
      .from(agentPromptRevisions)
      .innerJoin(
        heads,
        and(
          eq(agentPromptRevisions.agent_kind, heads.agentKind),
          eq(agentPromptRevisions.revision, heads.revision),
        ),
      )
      .where(eq(agentPromptRevisions.workspace_id, workspaceId))
      .orderBy(agentPromptRevisions.agent_kind)
    return rows.map(rowToAgentPromptRevision)
  }

  async listRevisionsByKinds(
    workspaceId: string,
    agentKinds: readonly string[],
  ): Promise<AgentPromptRevision[]> {
    // One IN query rather than a point read per kind (the sandbox asks about its whole catalog).
    // An empty list would make `inArray` match nothing on Postgres but is short-circuited anyway,
    // so the caller never pays for a round trip it cannot use.
    if (agentKinds.length === 0) return []
    const rows = await this.db
      .select()
      .from(agentPromptRevisions)
      .where(
        and(
          eq(agentPromptRevisions.workspace_id, workspaceId),
          inArray(agentPromptRevisions.agent_kind, [...agentKinds]),
        ),
      )
      .orderBy(agentPromptRevisions.agent_kind, desc(agentPromptRevisions.revision))
    return rows.map(rowToAgentPromptRevision)
  }

  async head(workspaceId: string, agentKind: string): Promise<AgentPromptRevision | null> {
    const [row] = await this.db
      .select()
      .from(agentPromptRevisions)
      .where(
        and(
          eq(agentPromptRevisions.workspace_id, workspaceId),
          eq(agentPromptRevisions.agent_kind, agentKind),
        ),
      )
      .orderBy(desc(agentPromptRevisions.revision))
      .limit(1)
    return row ? rowToAgentPromptRevision(row) : null
  }

  async append(workspaceId: string, revision: AgentPromptRevision): Promise<void> {
    await this.db.insert(agentPromptRevisions).values({
      workspace_id: workspaceId,
      agent_kind: revision.agentKind,
      revision: revision.revision,
      text: revision.text,
      restored_from: revision.restoredFrom ?? null,
      created_at: revision.createdAt,
      created_by: revision.createdBy ?? null,
    })
  }
}

/** The row shape both reads below project, so the mapper is shared across them. */
interface WorkspaceAgentSettingsRow {
  agent_kind: string
  max_output_tokens: number | null
  updated_at: number
}

function rowToWorkspaceAgentSettings(row: WorkspaceAgentSettingsRow): WorkspaceAgentSettings {
  return {
    agentKind: row.agent_kind,
    // Kept as an explicit null rather than folded away like the optional prompt fields: null is a
    // MEANINGFUL state here ("inheriting the deployment default"), which the settings UI shows.
    maxOutputTokens: row.max_output_tokens,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-workspace, per-agent-kind generation settings — the Drizzle mirror of
 * `D1WorkspaceAgentSettingsRepository`. One row per kind; no row (or a NULL
 * `max_output_tokens`) means the kind inherits the deployment routing default.
 *
 * `upsert` is conflict-targeted on the full primary key, the deliberate opposite of
 * `DrizzleAgentPromptRepository.append` above: see the port for why a scalar knob upserts
 * where an authored prompt appends.
 */
export class DrizzleWorkspaceAgentSettingsRepository implements WorkspaceAgentSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, agentKind: string): Promise<WorkspaceAgentSettings | null> {
    const [row] = await this.db
      .select()
      .from(workspaceAgentSettings)
      .where(
        and(
          eq(workspaceAgentSettings.workspace_id, workspaceId),
          eq(workspaceAgentSettings.agent_kind, agentKind),
        ),
      )
      .limit(1)
    return row ? rowToWorkspaceAgentSettings(row) : null
  }

  async list(workspaceId: string): Promise<WorkspaceAgentSettings[]> {
    const rows = await this.db
      .select()
      .from(workspaceAgentSettings)
      .where(eq(workspaceAgentSettings.workspace_id, workspaceId))
      .orderBy(workspaceAgentSettings.agent_kind)
    return rows.map(rowToWorkspaceAgentSettings)
  }

  async upsert(workspaceId: string, settings: WorkspaceAgentSettings): Promise<void> {
    await this.db
      .insert(workspaceAgentSettings)
      .values({
        workspace_id: workspaceId,
        agent_kind: settings.agentKind,
        max_output_tokens: settings.maxOutputTokens,
        updated_at: settings.updatedAt,
      })
      .onConflictDoUpdate({
        target: [workspaceAgentSettings.workspace_id, workspaceAgentSettings.agent_kind],
        set: {
          max_output_tokens: settings.maxOutputTokens,
          updated_at: settings.updatedAt,
        },
      })
  }

  async remove(workspaceId: string, agentKind: string): Promise<void> {
    await this.db
      .delete(workspaceAgentSettings)
      .where(
        and(
          eq(workspaceAgentSettings.workspace_id, workspaceId),
          eq(workspaceAgentSettings.agent_kind, agentKind),
        ),
      )
  }
}

/**
 * Per-workspace suppressions of registered custom task types: the Drizzle mirror of
 * `D1TaskTypeSuppressionRepository`. Tombstones: a row means the workspace hides that operation and
 * a restore deletes it. See the port for why absence is the default.
 */
export class DrizzleTaskTypeSuppressionRepository implements TaskTypeSuppressionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ taskType: taskTypeSuppressions.task_type })
      .from(taskTypeSuppressions)
      .where(eq(taskTypeSuppressions.workspace_id, workspaceId))
      .orderBy(taskTypeSuppressions.task_type)
    return rows.map((row) => row.taskType)
  }

  async suppress(workspaceId: string, taskType: string, createdAt: number): Promise<void> {
    await this.db
      .insert(taskTypeSuppressions)
      .values({ workspace_id: workspaceId, task_type: taskType, created_at: createdAt })
      .onConflictDoNothing({
        target: [taskTypeSuppressions.workspace_id, taskTypeSuppressions.task_type],
      })
  }

  async restore(workspaceId: string, taskType: string): Promise<void> {
    await this.db
      .delete(taskTypeSuppressions)
      .where(
        and(
          eq(taskTypeSuppressions.workspace_id, workspaceId),
          eq(taskTypeSuppressions.task_type, taskType),
        ),
      )
  }
}
