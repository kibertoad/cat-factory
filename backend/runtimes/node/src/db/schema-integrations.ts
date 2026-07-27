import { bigint, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

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
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.block_id] })],
)

// Per-service-frame ACCEPTANCE CRITERIA (mirror of D1 migration 0063's `acceptance_criteria`):
// the durable given/when/then behaviour statements a service accumulates, keyed by the SERVICE
// FRAME block (a run resolves them by walking its block up the frame chain).
//
// One ROW per criterion — unlike the frame-scoped configs above — because each carries its own
// lifecycle (`proposed` from the accretion pass → `confirmed`/`retired` by a human) and a stable
// id that the tester's per-criterion verdicts and the PR verification report join on.
//
// The clause columns are `*_text` because `when` is a RESERVED WORD in Postgres (and `then` in
// both dialects); the D1 mirror uses the same names so the two runtimes stay identical. `tags`
// is a JSON array as text. See docs/initiatives/acceptance-criteria-store.md.
export const acceptanceCriteria = pgTable(
  'acceptance_criteria',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    block_id: text('block_id').notNull(),
    title: text('title').notNull(),
    given_text: text('given_text').notNull().default(''),
    when_text: text('when_text').notNull().default(''),
    outcome_text: text('outcome_text').notNull().default(''),
    tags: text('tags').notNull().default('[]'),
    status: text('status').notNull().default('proposed'),
    provenance: text('provenance').notNull().default('authored'),
    source_review_id: text('source_review_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  // The frame-chain read on every dispatch and the workspace hydrate both ride this index.
  (t) => [index('idx_acceptance_criteria_workspace_block').on(t.workspace_id, t.block_id)],
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
