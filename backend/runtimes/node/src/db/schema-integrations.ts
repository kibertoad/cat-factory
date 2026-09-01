import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// The opt-in INTEGRATION tables: a workspace's sealed third-party connections (observability,
// private package registries, incident enrichment) and the per-SERVICE-FRAME configuration that
// drives them (release-health monitor/SLO mappings, sensitive test credentials, pre-PR validation
// checks). Split out of `schema.ts` — which is the drizzle-kit entry point and re-exports these —
// because they form a self-contained family: every one of them is keyed by workspace or by
// (workspace, service-frame block), wired only when the deployment configures the integration,
// and mirrors a D1 table on the Cloudflare facade. Re-exported rather than moved out of the
// schema graph, so `pnpm db:generate` still sees exactly one schema module.

// Post-release-health gate (pluggable observability — Datadog today). One connection per
// workspace (mirror of D1 migration 0007's `observability_connections`). `credentials` is a
// sealed JSON blob of the provider-specific secret (domain tag 'cat-factory:observability');
// `summary` is a non-secret display blob. Plaintext credentials only in memory.
export const observabilityConnections = pgTable('observability_connections', {
  workspace_id: text('workspace_id').primaryKey(),
  provider: text('provider').notNull(),
  credentials: text('credentials').notNull(),
  summary: text('summary').notNull().default('{}'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Private package-registry entries per workspace (npm private orgs, GitHub Packages), so
// agent containers can resolve private dependencies on checkout (mirror of D1 migration
// 0034's `package_registry_connections`). `entries` is ONE sealed JSON array of
// { id, ecosystem, vendor, scopes, token } (domain tag 'cat-factory:package-registries');
// `summary` is a non-secret display blob. Plaintext tokens only in memory.
export const packageRegistryConnections = pgTable('package_registry_connections', {
  workspace_id: text('workspace_id').primaryKey(),
  entries: text('entries').notNull(),
  summary: text('summary').notNull().default('[]'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// The workspace's SERVICE CATALOG connection: the developer portal (Backstage) whose services are
// imported into the foundational-services catalog as `workspace`-tier rows (mirror of D1 migration
// 0097's `service_catalog_connections`). `credentials` is ONE sealed JSON credential bag (domain
// tag 'cat-factory:service-catalog'), the empty string for `auth_mode = 'none'`.
//
// The non-secret CONFIGURATION lives in its own columns rather than a JSON summary blob, unlike
// the connections above: every one of these is read on the import path, so a blob would be parsed
// on every pass to get at the URL the request goes to. See backend/docs/service-catalog-import.md.
export const serviceCatalogConnections = pgTable(
  'service_catalog_connections',
  {
    workspace_id: text('workspace_id').primaryKey(),
    provider: text('provider').notNull(),
    base_url: text('base_url').notNull(),
    auth_mode: text('auth_mode').notNull(),
    credentials: text('credentials').notNull().default(''),
    // JSON string[] of portal-side filter terms, ANDed.
    entity_filter: text('entity_filter').notNull().default('["kind=component"]'),
    include_apis: boolean('include_apis').notNull().default(true),
    max_services: integer('max_services').notNull().default(200),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    last_sync_status: text('last_sync_status'),
    last_sync_message: text('last_sync_message'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    // The autorefresh sweep drains the stalest live connections in bounded batches.
    index('idx_service_catalog_stale')
      .on(t.last_synced_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// Per-workspace incident-enrichment connection (PagerDuty + incident.io), moved out of
// env onto a sealed row (mirror of D1 migration 0013's `incident_enrichment_connections`).
// `credentials` is ONE sealed JSON blob { pagerDuty?, incidentIo? } (domain tag
// 'cat-factory:incident-enrichment'); `summary` is a non-secret presence blob.
export const incidentEnrichmentConnections = pgTable('incident_enrichment_connections', {
  workspace_id: text('workspace_id').primaryKey(),
  credentials: text('credentials').notNull(),
  summary: text('summary').notNull().default('{}'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Per-block (service frame) monitor/SLO mapping the gate reads (mirror of D1
// `release_health_configs`). `monitor_ids`/`slo_ids` are JSON arrays as `text`.
export const releaseHealthConfigs = pgTable(
  'release_health_configs',
  {
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id').notNull(),
    monitor_ids: text('monitor_ids').notNull().default('[]'),
    slo_ids: text('slo_ids').notNull().default('[]'),
    env_tag: text('env_tag'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.block_id] })],
)

// Per-service-frame PRE-PR VALIDATION CHECKS (mirror of D1 migration 0061's
// `validation_configs`): the shell commands the executor-harness runs against the checkout
// after the coding agent settles and BEFORE opening a PR, plus the repair-round budget.
// `checks` is a JSON array of `{ label, command }`. Keyed by the SERVICE FRAME block; a run
// resolves its checks by walking its block up the frame chain. Nothing here is secret — the
// commands run inside the run's own container. See docs/initiatives/pre-pr-validation.md.
export const validationConfigs = pgTable(
  'validation_configs',
  {
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id').notNull(),
    checks: text('checks').notNull().default('[]'),
    max_attempts: integer('max_attempts').notNull().default(3),
    // DEPENDENCY PREPOPULATION: the install run BEFORE the agent's first turn (mirror of D1
    // migration 0068). Nullable — a service may declare checks, this, both or neither.
    dependency_install: text('dependency_install'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.block_id] })],
)

// Sensitive per-service test credentials (sealed; mirror of D1 migration 0044's
// `test_secrets`). The SEALED sibling of the non-sensitive test-credential pools: a
// third-party API token a Tester needs, delivered to the container out of band. `credentials`
// is a sealed JSON blob of TestSecretEntry[] (domain tag 'cat-factory:test-secrets'); `summary`
// is a non-secret TestSecretRef[] display blob. Keyed by the SERVICE FRAME block.
export const testSecrets = pgTable(
  'test_secrets',
  {
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id').notNull(),
    credentials: text('credentials').notNull(),
    summary: text('summary').notNull().default('[]'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.block_id] })],
)

// Per-workspace CAPABILITY CREDENTIALS (sealed; mirror of D1 migration 0077's
// `capability_credentials`). The tenant-scoped home for the secrets a registered tool server or
// generative binary integration declares by name — the shipped resolver read them off the
// DEPLOYMENT'S environment, which is a single-tenant answer. `credentials` is a sealed JSON blob
// of CapabilityCredentialEntry[] (domain tag 'cat-factory:capability-credentials'); `summary` is
// a non-secret CapabilityCredentialRef[] display blob. ONE row per workspace.
export const capabilityCredentials = pgTable('capability_credentials', {
  workspace_id: text('workspace_id').primaryKey(),
  credentials: text('credentials').notNull(),
  summary: text('summary').notNull().default('[]'),
  // Optimistic-concurrency revision, bumped on every write; the per-key writes ride the
  // rev-guarded compareAndSwap/deleteIfRev because the row is ONE blob holding the whole set.
  rev: integer('rev').notNull().default(0),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Per-workspace OAUTH GRANTS for remote (http) MCP tool servers (sealed; mirror of D1 migration
// 0082's `mcp_oauth_grants`). What comes out of a person authorising this board against a vendor's
// MCP server: `tokens` is a sealed blob holding the access token, the refresh token and the expiry
// (domain tag 'cat-factory:mcp-oauth'), `summary` is the non-secret blob the connection panel
// renders. ONE row per (workspace, server) rather than one per workspace, because the write that
// contends here is a dispatch-path REFRESH rather than a human's checklist save.
export const mcpOAuthGrants = pgTable(
  'mcp_oauth_grants',
  {
    workspace_id: text('workspace_id').notNull(),
    server_id: text('server_id').notNull(),
    tokens: text('tokens').notNull(),
    summary: text('summary').notNull().default('{}'),
    // Optimistic concurrency for the refresh path: two dispatches can find the same access token
    // expired at the same instant, and only one of their token sets is the live one afterwards.
    rev: integer('rev').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.server_id] })],
)
