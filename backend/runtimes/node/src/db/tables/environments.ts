import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// The EPHEMERAL-ENVIRONMENT tables, extracted from `schema.ts` to keep that module inside its
// size budget: the per-provision-type infra handlers a workspace binds, the registry of
// environments provisioned through them, and the developer-triggered self-test runs that
// exercise one frame's provisioning config end to end. One cohesive group, re-exported from
// `schema.ts` so every `from '../db/schema.js'` importer is unaffected and drizzle-kit still sees
// the tables through that entry point.

// Ephemeral-environment integration (mirror of D1 migration 0025). A workspace's per-
// provision-type infra HANDLERS (how a service's declared provision type is stood up) and
// the registry of environments provisioned from them. Keyed by (workspace_id,
// provision_type, manifest_id): one handler per type, plus one per pinned custom manifest
// id ('' for non-custom). `handler_json` carries the engine connection (sans secrets); the
// manifests to apply come from the service at provision time. Credentials are opaque
// ciphertext (SecretCipher envelopes), never plaintext. See
// docs/initiatives/per-service-provision-types.md.
export const environmentConnections = pgTable(
  'environment_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    provision_type: text('provision_type').notNull(),
    manifest_id: text('manifest_id').notNull().default(''),
    engine: text('engine').notNull(),
    backend_kind: text('backend_kind').notNull(),
    provider_id: text('provider_id').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    handler_json: text('handler_json').notNull(),
    accepts_manifest_id: text('accepts_manifest_id'),
    secrets_cipher: text('secrets_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.provision_type, t.manifest_id] }),
    index('idx_environment_conn_workspace')
      .on(t.workspace_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// One row per provisioned environment. `access_cipher` holds the env's own access
// creds (what the tester uses); `provision_fields_cipher` holds the fields captured at
// provision time that status/teardown calls interpolate.
export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id'),
    // The service FRAME this env belongs to (the deployer block walked up to its frame). The
    // cross-frame discovery key: a `frontend` frame's `service` binding resolves the live env
    // by the bound service FRAME id, not the task the deployer ran on (`block_id`).
    frame_id: text('frame_id'),
    execution_id: text('execution_id'),
    provider_id: text('provider_id').notNull(),
    external_id: text('external_id'),
    url: text('url'),
    status: text('status').notNull(),
    access_cipher: text('access_cipher'),
    provision_fields_cipher: text('provision_fields_cipher'),
    // The serialized `EnvironmentReachability` (ADR 0062), in the clear: a list of addresses for a
    // host already published in plaintext beside it is neither a credential nor provider state.
    reachability: text('reachability'),
    // When the provider last answered a status poll WITHOUT failing, and how many such answers
    // there have been. Mirror of D1 migration 0099. The provisioning log records only a poll that
    // threw or one that turned the env `failed`, so before these a clean four-minute readiness
    // wait and no polling at all were the same data; see the kernel `EnvironmentRecord`.
    last_polled_at: bigint('last_polled_at', { mode: 'number' }),
    poll_count: bigint('poll_count', { mode: 'number' }).notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    last_error: text('last_error'),
    // The provider's account of a state it has not left yet (why the env is not ready), written
    // on every provision and poll regardless of status, where `last_error` is written only on
    // `failed`. Mirror of D1 migration 0098; see the kernel `EnvironmentRecord`.
    status_note: text('status_note'),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
    // The service's declared provision type + the resolved engine that handled it,
    // recorded at provision time so run details can show exactly what ran where.
    provision_type: text('provision_type'),
    engine: text('engine'),
  },
  (t) => [
    index('idx_environments_block')
      .on(t.workspace_id, t.block_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_environments_expiry')
      .on(t.expires_at)
      .where(sql`${t.deleted_at} IS NULL AND ${t.expires_at} IS NOT NULL`),
  ],
)

// Ephemeral-environment self-test runs (mirror of D1 migration 0050). A developer-triggered
// diagnostic that exercises a service frame's provisioning config end to end against a
// throwaway branch (create branch → provision → tear down → delete branch). Its own table
// (not agent_runs) because it carries a `stage` state machine and is not a container agent.
export const environmentTestRuns = pgTable(
  'environment_test_runs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id').notNull(),
    status: text('status').notNull(),
    stage: text('stage').notNull(),
    initiated_by: text('initiated_by'),
    // The frame's provisioning config, pinned at dispatch (JSON); see the kernel port.
    provisioning: text('provisioning').notNull(),
    branch: text('branch'),
    environment_id: text('environment_id'),
    env_url: text('env_url'),
    error: text('error'),
    failed_stage: text('failed_stage'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_environment_test_runs_ws_status').on(t.workspace_id, t.status),
    // The cross-workspace stale-run sweep (`listStale`) scans running runs by lease age.
    index('idx_environment_test_runs_status_updated').on(t.status, t.updated_at),
  ],
)
