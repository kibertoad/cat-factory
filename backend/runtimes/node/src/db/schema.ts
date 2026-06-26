import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgSchema,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Telemetry has a very different write profile from the transactional domain
// (append-heavy, high-volume, write-and-rarely-read, short retention), so it lives in
// its own `telemetry` Postgres schema rather than `public`. This is the Node analogue
// of the Cloudflare worker's separate TELEMETRY_DB D1 database. The schema is purely a
// namespace served by the same connection/pool; `migrate()` creates it on boot. The
// `llm_call_metrics` table and `agent_context_snapshots` table live here.
export const telemetry = pgSchema('telemetry')

// Postgres schema mirroring the Cloudflare D1 tables column-for-column (snake_case
// field names = column names) so the shared row<->domain mappers in
// @cat-factory/server work unchanged against either store. JSON-shaped columns are
// `text` (the mappers (de)serialise them), and epoch-ms / GitHub-id columns are
// `bigint({ mode: 'number' })` so they read back as JS numbers. The indexes mirror
// the D1 migrations 1:1 so query plans (and the unique personal-account constraint)
// match across stores.

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    account_id: text('account_id'),
    owner_user_id: text('owner_user_id'),
  },
  // listVisible filters by owner_user_id (legacy) and account_id (membership scope).
  (t) => [
    index('idx_workspaces_owner').on(t.owner_user_id),
    index('idx_workspaces_account').on(t.account_id),
  ],
)

// Canonical user identity (decoupled from GitHub). Everything else keys off users.id.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    email: text('email'),
    avatar_url: text('avatar_url'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_users_email')
      .on(t.email)
      .where(sql`email IS NOT NULL`),
  ],
)

// A linked login identity for a user. (provider, subject) is unique.
export const userIdentities = pgTable(
  'user_identities',
  {
    user_id: text('user_id').notNull(),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    secret: text('secret'),
    metadata: text('metadata'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index('idx_user_identities_user').on(t.user_id),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    github_account_login: text('github_account_login'),
    // The user who owns a personal account (its account-of-one). Null for orgs.
    owner_user_id: text('owner_user_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // The default cloud provider new services in this account inherit.
    default_cloud_provider: text('default_cloud_provider'),
  },
  // Enforce one personal account per user (a correctness constraint, not just a
  // lookup index) — the partial unique index `findPersonalByUser` relies on.
  (t) => [
    uniqueIndex('idx_accounts_personal')
      .on(t.owner_user_id)
      .where(sql`type = 'personal'`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    account_id: text('account_id').notNull(),
    user_id: text('user_id').notNull(),
    // Combinable roles (admin / developer / product) as a CSV; defaults to developer.
    roles: text('roles').notNull().default('developer'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.user_id] }),
    index('idx_memberships_user').on(t.user_id),
  ],
)

// Per-account transactional-email sender (UI-onboarded). The provider API key is
// sealed at rest (SecretCipher), never plaintext.
export const emailConnections = pgTable('email_connections', {
  account_id: text('account_id').primaryKey(),
  provider: text('provider').notNull(),
  from_address: text('from_address').notNull(),
  api_key_cipher: text('api_key_cipher').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  deleted_at: bigint('deleted_at', { mode: 'number' }),
})

// Per-account (deployment-wide) settings, moved out of env (mirror of D1 migration 0014's
// `account_settings`). `config` is non-secret tuning JSON; `secrets_cipher` is ONE sealed
// blob grouping every integration credential (domain tag 'cat-factory:account-settings');
// `summary` is non-secret presence JSON. A missing row means all defaults.
export const accountSettings = pgTable('account_settings', {
  account_id: text('account_id').primaryKey(),
  config: text('config').notNull(),
  secrets_cipher: text('secrets_cipher'),
  summary: text('summary').notNull().default('{}'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Local-mode operational settings — a per-DEPLOYMENT SINGLETON (one developer's machine),
// addressed by a fixed `id` ('local'). `config` is non-secret tuning JSON (warm-pool
// sizing + per-repo checkout reuse) that replaced the `LOCAL_POOL_*` / `HARNESS_*` env
// vars. LOCAL-MODE-ONLY: the warm pool is the local Docker-family runner's differentiator,
// so this table has NO D1 mirror (the symmetry rule's runtime-specific carve-out). A
// missing row means all defaults (pooling off).
export const localSettings = pgTable('local_settings', {
  id: text('id').primaryKey(),
  config: text('config').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Email invitations into an org account. Only the token's hash is stored.
export const accountInvitations = pgTable(
  'account_invitations',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    email: text('email').notNull(),
    roles: text('roles').notNull().default('developer'),
    token_hash: text('token_hash').notNull(),
    invited_by: text('invited_by').notNull(),
    status: text('status').notNull().default('pending'),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_account_invitations_account').on(t.account_id),
    uniqueIndex('idx_account_invitations_token').on(t.token_hash),
  ],
)

export const blocks = pgTable(
  'blocks',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    type: text('type').notNull(),
    description: text('description').notNull().default(''),
    pos_x: doublePrecision('pos_x').notNull().default(0),
    pos_y: doublePrecision('pos_y').notNull().default(0),
    // Explicit, user-dragged frame size; null => the board auto-sizes from content.
    width: doublePrecision('width'),
    height: doublePrecision('height'),
    status: text('status').notNull(),
    progress: doublePrecision('progress').notNull().default(0),
    depends_on: text('depends_on').notNull().default('[]'),
    execution_id: text('execution_id'),
    level: text('level').notNull().default('frame'),
    parent_id: text('parent_id'),
    // Task-level: membership link to an `epic`-level block, independent of parent_id
    // (the structural container). Deleting an epic clears this, never the member tasks.
    epic_id: text('epic_id'),
    // Task-level: preceding-task auto-start toggle (0/1); null ⇒ off. When set, merging
    // this task auto-starts every dependent whose other dependencies are also done.
    auto_start_dependents: integer('auto_start_dependents'),
    confidence: doublePrecision('confidence'),
    module_name: text('module_name'),
    fragment_ids: text('fragment_ids'),
    // Service-level (frame): the service's selected best-practice fragment ids (JSON array).
    service_fragment_ids: text('service_fragment_ids'),
    model_id: text('model_id'),
    pull_request: text('pull_request'),
    merge_preset_id: text('merge_preset_id'),
    model_preset_id: text('model_preset_id'),
    pipeline_id: text('pipeline_id'),
    // Task-level agent config-contribution values (JSON id->value map).
    agent_config: text('agent_config'),
    // Service-level (frame): Tester local-infra docker-compose path, the "no infra
    // dependencies" flag, the cloud provider and the abstract instance size.
    test_compose_path: text('test_compose_path'),
    no_infra_dependencies: integer('no_infra_dependencies'),
    // Service-level (frame): default test environment tasks are spawned with
    // ('local' | 'ephemeral'); a task overrides via its tester.environment config.
    default_test_environment: text('default_test_environment'),
    cloud_provider: text('cloud_provider'),
    instance_size: text('instance_size'),
    // The account-owned service this block belongs to (migration 0031); will become the
    // physical scope key once the repositories switch off workspace_id.
    service_id: text('service_id'),
    // GitHub user id of the block's creator (migration 0038); drives "notify the task
    // creator" routing. Nullable — legacy blocks / auth-disabled dev have no creator.
    created_by: text('created_by'),
    // The responsible product person (usr_*): notified when requirement review flags it.
    responsible_product_user_id: text('responsible_product_user_id'),
    // Task-level: the task-estimator's triage (complexity/risk/impact + rationale) as
    // JSON; persisted on the block for gating consensus steps + UI ratings.
    estimate: text('estimate'),
    // Task-level: the kind of work (feature/bug/document/spike/recurring); absent ⇒ feature.
    task_type: text('task_type'),
    // Task-level: small per-type form fields (bug severity, spike timebox…) as JSON.
    task_type_fields: text('task_type_fields'),
    // Task-level: TECHNICAL label — 1 ⇒ technical, 0 ⇒ business, null ⇒ not yet determined
    // (the engine may infer it). A human-set value is authoritative and never overridden.
    technical: integer('technical'),
    // Task-level: per-task issue-tracker writeback overrides ('on'/'off'; null ⇒ inherit
    // the workspace's writeback_* settings). Comment-on-PR-open and resolve-on-merge.
    tracker_comment_on_pr_open: text('tracker_comment_on_pr_open'),
    tracker_resolve_on_merge: text('tracker_resolve_on_merge'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_blocks_parent').on(t.workspace_id, t.parent_id),
    index('idx_blocks_epic').on(t.workspace_id, t.epic_id),
    index('idx_blocks_service').on(t.service_id),
    // findById looks a block up by id alone (no workspace_id), so it can't use the
    // (workspace_id, id) PK — index id directly to avoid scanning the largest table.
    // Block ids are only unique within a workspace, so this is a plain lookup index.
    index('idx_blocks_id').on(t.id),
  ],
)

// In-org shared services: account-owned service + per-workspace mount (migration 0030).
export const services = pgTable(
  'services',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id'),
    frame_block_id: text('frame_block_id').notNull(),
    installation_id: bigint('installation_id', { mode: 'number' }),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }),
    // Subdirectory within the linked monorepo this service lives in (NULL = whole repo).
    directory: text('directory'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_services_account').on(t.account_id),
    // One service per frame block *within an account* (the frame↔service mapping is 1:1).
    // Scoped by account_id, not global: block ids are only unique within a workspace, so a
    // reused/seeded frame id recurs across workspaces; NULL account ids are SQL-distinct, so
    // the auth-disabled/local path stays unconstrained while real accounts stay 1:1.
    uniqueIndex('idx_services_frame').on(t.account_id, t.frame_block_id),
    // getByFrameBlock resolves a service by frame_block_id alone (no account_id), so it
    // can't use the composite idx_services_frame above. This lookup runs in a loop walking
    // a block's ancestry on every agent run's repo resolution + on board reads — index it.
    index('idx_services_frame_block').on(t.frame_block_id),
    index('idx_services_repo').on(t.installation_id, t.repo_github_id),
  ],
)

export const workspaceServices = pgTable(
  'workspace_services',
  {
    workspace_id: text('workspace_id').notNull(),
    service_id: text('service_id').notNull(),
    pos_x: doublePrecision('pos_x').notNull().default(0),
    pos_y: doublePrecision('pos_y').notNull().default(0),
    width: doublePrecision('width'),
    height: doublePrecision('height'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.service_id] }),
    index('idx_workspace_services_service').on(t.service_id),
  ],
)

export const pipelines = pgTable(
  'pipelines',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    agent_kinds: text('agent_kinds').notNull().default('[]'),
    gates: text('gates'),
    thresholds: text('thresholds'),
    // Nullable JSON array of per-step enable flags; truthy `builtin` marks the curated
    // read-only catalog templates (mirror of D1 migration 0002).
    enabled: text('enabled'),
    builtin: integer('builtin'),
    // Nullable JSON array of per-step consensus configs, parallel to agent_kinds (set in
    // the pipeline builder for steps whose kind carries a consensus capability trait).
    consensus: text('consensus'),
    // Nullable JSON array of per-step StepGating, parallel to agent_kinds: an enabled entry
    // makes the step run only when the task estimate meets the threshold (mirror of D1 0003).
    gating: text('gating'),
    // Nullable JSON array of free-form organizational labels; `archived` (truthy) hides the
    // pipeline from the default library view (mirror of D1 0003).
    labels: text('labels'),
    archived: integer('archived'),
    // Monotonic insert sequence (Postgres has no SQLite rowid): a workspace's pipelines
    // are read back in the order they were seeded — the curated `seedPipelines()` order
    // — so the catalog order (and the UI's default `pipelines[0]`) is deterministic and
    // matches the Cloudflare facade (which orders by `rowid`). Auto-assigned on insert.
    seq: serial('seq').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const agentRuns = pgTable(
  'agent_runs',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    block_id: text('block_id'),
    status: text('status').notNull(),
    detail: text('detail').notNull().default('{}'),
    subtasks: text('subtasks'),
    error: text('error'),
    failure: text('failure'),
    workflow_instance_id: text('workflow_instance_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    // The service this run targets (migration 0031), derived from its block.
    service_id: text('service_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // listByWorkspace filters by workspace_id and orders by created_at.
    index('idx_agent_runs_workspace').on(t.workspace_id, t.created_at),
    index('idx_agent_runs_status_lease').on(t.status, t.updated_at),
    index('idx_agent_runs_block').on(t.workspace_id, t.block_id),
    index('idx_agent_runs_service').on(t.service_id),
  ],
)

export const tokenUsage = pgTable(
  'token_usage',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id'),
    agent_kind: text('agent_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cost_estimate: doublePrecision('cost_estimate').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_token_usage_created').on(t.created_at),
    // Per-workspace spend rollup (`totalsSinceForWorkspace`) runs on every metered
    // LLM-proxy call + web-search + step gate; index (workspace_id, created_at) so it
    // doesn't scan the whole ledger and filter workspace_id row-by-row.
    index('idx_token_usage_workspace').on(t.workspace_id, t.created_at),
  ],
)

// Per-workspace model presets (mirror of D1 migration 0006's `model_presets`). A
// preset is one `base_model_id` applied to every agent kind plus per-kind `overrides`
// (JSON object, agentKind -> model id). A task selects one via `blocks.model_preset_id`;
// none -> the workspace default (`is_default`, exactly one per workspace — the
// repository demotes the prior default when promoting a new one). `is_default` is 0/1
// to mirror the D1 integer flag. Replaces the old `workspace_model_defaults` map.
export const modelPresets = pgTable(
  'model_presets',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    base_model_id: text('base_model_id').notNull(),
    overrides: text('overrides').notNull().default('{}'),
    is_default: integer('is_default').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // Fast lookup of a workspace's default preset (mirrors idx_model_presets_default).
    index('idx_model_presets_default').on(t.workspace_id, t.is_default),
  ],
)
// Per-workspace default service-fragment selection (mirror of D1 migration 0040). One
// row per workspace; the best-practice fragment ids new services inherit, JSON array.
export const workspaceFragmentDefaults = pgTable('workspace_fragment_defaults', {
  workspace_id: text('workspace_id').primaryKey(),
  fragment_ids: text('fragment_ids').notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Prompt-fragment library (ADR 0006; mirror of D1 migration 0020). The managed,
// tenant-scoped catalog of best-practice fragments, scoped by an (owner_kind,
// owner_id) pair so one table backs both the account and workspace tiers. JSON-shaped
// columns (`applies_to`, `tags`) are `text`; a tombstone (`deleted_at`) suppresses an
// inherited or removed-upstream fragment.
export const promptFragments = pgTable(
  'prompt_fragments',
  {
    fragment_id: text('fragment_id').notNull(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    category: text('category'),
    summary: text('summary').notNull(),
    body: text('body').notNull(),
    applies_to: text('applies_to'),
    tags: text('tags'),
    source_id: text('source_id'),
    source_path: text('source_path'),
    source_sha: text('source_sha'),
    doc_source: text('doc_source'),
    doc_external_id: text('doc_external_id'),
    doc_via_workspace_id: text('doc_via_workspace_id'),
    resolved_at: bigint('resolved_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.owner_kind, t.owner_id, t.fragment_id] }),
    index('idx_prompt_fragments_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_prompt_fragments_source')
      .on(t.source_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// A repo directory linked as a source of Markdown guideline files (ADR 0006 §3;
// mirror of D1 migration 0020). At most one live source per (owner, repo, ref, dir) —
// the unique index is the upsert key; a partial owner index powers the list.
export const fragmentSources = pgTable(
  'fragment_sources',
  {
    id: text('id').primaryKey(),
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    git_ref: text('git_ref').notNull().default('HEAD'),
    dir_path: text('dir_path').notNull().default(''),
    last_synced_sha: text('last_synced_sha'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_fragment_sources_unique').on(
      t.owner_kind,
      t.owner_id,
      t.repo_owner,
      t.repo_name,
      t.git_ref,
      t.dir_path,
    ),
    index('idx_fragment_sources_owner')
      .on(t.owner_kind, t.owner_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// LLM observability sink (mirror of D1 migration 0026). One row per proxied
// container-agent model call: full prompt/response, output-limit headroom and the
// transport-vs-execution latency split. Pruned aggressively by retention (the full
// bodies make it heavy); booleans are integer 0/1 to match the SQLite store.
export const llmCallMetrics = telemetry.table(
  'llm_call_metrics',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id'),
    agent_kind: text('agent_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    streaming: integer('streaming').notNull().default(0),
    message_count: integer('message_count').notNull().default(0),
    tool_count: integer('tool_count').notNull().default(0),
    request_max_tokens: integer('request_max_tokens'),
    prompt_tokens: integer('prompt_tokens').notNull().default(0),
    cached_prompt_tokens: integer('cached_prompt_tokens').notNull().default(0),
    completion_tokens: integer('completion_tokens').notNull().default(0),
    total_tokens: integer('total_tokens').notNull().default(0),
    finish_reason: text('finish_reason'),
    upstream_ms: integer('upstream_ms').notNull().default(0),
    overhead_ms: integer('overhead_ms').notNull().default(0),
    total_ms: integer('total_ms').notNull().default(0),
    ok: integer('ok').notNull().default(1),
    http_status: integer('http_status'),
    error_message: text('error_message'),
    // prompt_text is stored as a DELTA (only the messages this call appended beyond
    // prompt_prefix_count); the full prompt is rebuilt on export. See D1 migration 0027.
    prompt_text: text('prompt_text').notNull().default(''),
    prompt_prefix_count: integer('prompt_prefix_count').notNull().default(0),
    prompt_hash: text('prompt_hash').notNull().default(''),
    response_text: text('response_text').notNull().default(''),
    // The model's reasoning/"thinking" trace on a separate channel, when emitted (a
    // reasoning model can spend its whole output budget here and return empty
    // response_text). Mirrors D1 migration 0002_llm_reasoning_text.
    reasoning_text: text('reasoning_text').notNull().default(''),
  },
  (t) => [
    index('idx_llm_call_metrics_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_llm_call_metrics_created').on(t.created_at),
  ],
)

// The complete, redacted context provided to one container-agent dispatch (per step
// attempt): the fully fragment-composed system + user prompts, the fragment bodies
// folded in, and the full content of the files injected into the container. Captures
// what proxy telemetry can't (the injected `.cat-context/*` files the agent reads via
// tools). JSON-shaped columns are text; pruned on the same retention window as
// llm_call_metrics. Mirrors the D1 agent_context_snapshots table column-for-column.
export const agentContextSnapshots = telemetry.table(
  'agent_context_snapshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    step_index: integer('step_index').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    model: text('model'),
    harness: text('harness'),
    system_prompt: text('system_prompt').notNull().default(''),
    user_prompt: text('user_prompt').notNull().default(''),
    // JSON arrays: [{id, body}] and [{path, title, url, content}].
    fragments: text('fragments').notNull().default('[]'),
    context_files: text('context_files').notNull().default('[]'),
    // Redacted structural bits (repo/branch, webSearch, infra, decisions, revision).
    extras: text('extras').notNull().default('{}'),
  },
  (t) => [
    index('idx_agent_context_snapshots_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_agent_context_snapshots_created').on(t.created_at),
  ],
)

// The unified provisioning event log lives in its OWN Postgres schema (`provisioning`)
// rather than `public`, isolating its high write churn from the main tables (the
// Cloudflare analogue is a separate D1 binding). One row per spin-up/down attempt
// across the environment + runner-pool/container subsystems; pruned to a retention
// window. `CREATE SCHEMA IF NOT EXISTS "provisioning"` is emitted ahead of the table by
// the generated migration (mirrors the `sandbox` schema) and bootstrapped idempotently
// by migrate() on boot — the DB role needs CREATE on the database, same as the app
// already requires to create its `public` tables.
export const provisioning = pgSchema('provisioning')
export const provisioningLog = provisioning.table(
  'provisioning_log',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    subsystem: text('subsystem').notNull(),
    operation: text('operation').notNull(),
    target_id: text('target_id'),
    provider_id: text('provider_id'),
    block_id: text('block_id'),
    execution_id: text('execution_id'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    detail: text('detail'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_provisioning_log_workspace').on(t.workspace_id, t.created_at),
    index('idx_provisioning_log_subsystem').on(t.workspace_id, t.subsystem, t.created_at),
    index('idx_provisioning_log_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_provisioning_log_target').on(t.workspace_id, t.target_id),
    index('idx_provisioning_log_created').on(t.created_at),
  ],
)

// Recurring pipelines (mirror of D1 migration 0029). A schedule attaches a pipeline
// to a service frame and owns one reused on-board block; the sweeper fires every
// enabled schedule whose `next_run_at <= now`. `weekdays` is a JSON array (text),
// epoch-ms columns are bigint. Each fire is recorded in `pipeline_schedule_runs`.
export const pipelineSchedules = pgTable(
  'pipeline_schedules',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    service_id: text('service_id'),
    block_id: text('block_id').notNull(),
    frame_id: text('frame_id').notNull(),
    pipeline_id: text('pipeline_id').notNull(),
    template: text('template').notNull(),
    name: text('name').notNull(),
    interval_hours: integer('interval_hours').notNull(),
    weekdays: text('weekdays').notNull().default('[]'),
    window_start_hour: integer('window_start_hour'),
    window_end_hour: integer('window_end_hour'),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: integer('enabled').notNull().default(1),
    last_run_at: bigint('last_run_at', { mode: 'number' }),
    next_run_at: bigint('next_run_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_pipeline_schedules_due').on(t.enabled, t.next_run_at),
    index('idx_pipeline_schedules_block').on(t.workspace_id, t.block_id),
    index('idx_pipeline_schedules_service').on(t.service_id),
  ],
)

export const pipelineScheduleRuns = pgTable(
  'pipeline_schedule_runs',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    schedule_id: text('schedule_id').notNull(),
    execution_id: text('execution_id'),
    status: text('status').notNull(),
    started_at: bigint('started_at', { mode: 'number' }).notNull(),
    finished_at: bigint('finished_at', { mode: 'number' }),
    outcome: text('outcome'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_schedule_runs_schedule').on(t.workspace_id, t.schedule_id, t.started_at),
    index('idx_schedule_runs_started').on(t.started_at),
  ],
)

// Requirements reviews (mirror of D1 migration 0021). One row per review; the
// reviewed `items` live as a JSON array (text). At most one live review per block —
// the service deletes a block's prior review before inserting a fresh one, so
// `getByBlock` returns the current one. `incorporated_requirements` holds the
// reworked, standard-format requirements document the rework step produced.
export const requirementReviews = pgTable(
  'requirement_reviews',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    status: text('status').notNull(),
    items: text('items').notNull().default('[]'),
    model: text('model'),
    incorporated_requirements: text('incorporated_requirements'),
    // Reviewer-pass counter + its budget for the iterative review loop (the initial
    // review is iteration 1; an "extra round" choice bumps max_iterations).
    iteration: integer('iteration').notNull().default(1),
    max_iterations: integer('max_iterations').notNull().default(1),
    // Requirement-Writer recommendations as a JSON array (text), mirror of D1 migration 0009.
    recommendations: text('recommendations').notNull().default('[]'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // getByBlock looks up a block's reviews (newest wins), mirroring D1 migration 0021.
    index('idx_requirement_reviews_block').on(t.workspace_id, t.block_id),
  ],
)

// Kaizen gradings (mirror of D1 migration 0015): one row per (run, step) recording the
// post-run grade + recommendations the Kaizen agent produced. Recommendations are a JSON
// array column. The unique (execution_id, step_index) index keeps scheduling idempotent.
export const kaizenGradings = pgTable(
  'kaizen_gradings',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    execution_id: text('execution_id').notNull(),
    block_id: text('block_id').notNull(),
    step_index: integer('step_index').notNull(),
    agent_kind: text('agent_kind').notNull(),
    model: text('model').notNull(),
    prompt_version: integer('prompt_version').notNull(),
    combo_key: text('combo_key').notNull(),
    status: text('status').notNull(),
    grade: integer('grade'),
    summary: text('summary').notNull().default(''),
    recommendations: text('recommendations').notNull().default('[]'),
    grader_model: text('grader_model'),
    error: text('error'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    uniqueIndex('idx_kaizen_gradings_step').on(t.workspace_id, t.execution_id, t.step_index),
    index('idx_kaizen_gradings_status').on(t.status, t.updated_at),
    index('idx_kaizen_gradings_execution').on(t.workspace_id, t.execution_id),
  ],
)

// Kaizen verified-combo progress (mirror of D1 migration 0015): one row per
// (workspace, comboKey) tracking the streak of high grades and whether the combo has
// crossed the verification threshold (after which the engine stops grading it).
export const kaizenVerifiedCombos = pgTable(
  'kaizen_verified_combos',
  {
    workspace_id: text('workspace_id').notNull(),
    combo_key: text('combo_key').notNull(),
    agent_kind: text('agent_kind').notNull(),
    model: text('model').notNull(),
    prompt_version: integer('prompt_version').notNull(),
    consecutive_high_grades: integer('consecutive_high_grades').notNull().default(0),
    verified: integer('verified').notNull().default(0),
    verified_at: bigint('verified_at', { mode: 'number' }),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.combo_key] })],
)

// Consensus session transcripts (mirror of D1 migration 0002): one row per
// (execution, step) recording the multi-model process — participants, round-by-round
// contributions/votes, and the synthesized result. The observability surface the
// dedicated Consensus Session window renders; written by `@cat-factory/consensus`.
export const consensusSessions = pgTable(
  'consensus_sessions',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    execution_id: text('execution_id'),
    step_index: integer('step_index').notNull(),
    agent_kind: text('agent_kind').notNull(),
    strategy: text('strategy').notNull(),
    status: text('status').notNull(),
    participants: text('participants').notNull().default('[]'),
    rounds: text('rounds').notNull().default('[]'),
    synthesis: text('synthesis'),
    confidence: doublePrecision('confidence'),
    dissent: text('dissent').notNull().default('[]'),
    error: text('error'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_consensus_sessions_step').on(t.workspace_id, t.execution_id, t.step_index),
    index('idx_consensus_sessions_block').on(t.workspace_id, t.block_id, t.created_at),
  ],
)

// Clarity (bug-report triage) reviews (mirror of D1 migration 0002_clarity_reviews). The
// clarity analogue of `requirement_reviews`: items as a JSON array, at most one live review
// per block. `clarified_report` holds the standard-format clarified bug report.
export const clarityReviews = pgTable(
  'clarity_reviews',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    status: text('status').notNull(),
    items: text('items').notNull().default('[]'),
    model: text('model'),
    clarified_report: text('clarified_report'),
    iteration: integer('iteration').notNull().default(1),
    max_iterations: integer('max_iterations').notNull().default(1),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_clarity_reviews_block').on(t.workspace_id, t.block_id),
  ],
)

// Brainstorm (structured-dialogue) sessions (mirror of D1 migration 0016_brainstorm_sessions).
// The brainstorm analogue of `clarity_reviews`, but keyed per (block, STAGE): a block may have
// one live `requirements` session and one live `architecture` session at once.
// `converged_direction` holds the standard-format direction the dialogue settled on.
export const brainstormSessions = pgTable(
  'brainstorm_sessions',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    items: text('items').notNull().default('[]'),
    model: text('model'),
    converged_direction: text('converged_direction'),
    iteration: integer('iteration').notNull().default(1),
    max_iterations: integer('max_iterations').notNull().default(1),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_brainstorm_sessions_block_stage').on(t.workspace_id, t.block_id, t.stage),
  ],
)

// A workspace's issue-tracker selection (mirror of D1 migration 0029).
export const trackerSettings = pgTable('tracker_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  tracker: text('tracker'),
  jira_project_key: text('jira_project_key'),
  // Issue-tracker writeback toggles (0/1): comment on a task's linked issue when its
  // PR opens, and comment + close as resolved when it merges. Per-task overridable.
  writeback_comment_on_pr_open: integer('writeback_comment_on_pr_open').notNull().default(0),
  writeback_resolve_on_merge: integer('writeback_resolve_on_merge').notNull().default(0),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Task-source integration (mirror of D1 migration 0014): a workspace's connections
// to external issue trackers (Jira) and local projections of the issues it imported.
// `credentials` is an encrypted JSON bag (AES-256-GCM envelope), never sent on the
// wire. At most one live connection per (workspace, source); a `deleted_at` tombstone
// lets a workspace disconnect/reconnect.
export const taskConnections = pgTable(
  'task_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    credentials: text('credentials').notNull(),
    label: text('label').notNull().default(''),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.source] })],
)

// Per-workspace task-source toggle (mirrors D1 migration 0008). No row ⇒ the
// default (enabled), so a source is offered as soon as it's available; an
// `enabled: false` row is an explicit opt-out. Replaces the TASK_SOURCES env gate.
export const taskSourceSettings = pgTable(
  'task_source_settings',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    // Integer 0/1 to match the D1 (SQLite) store, per this file's boolean convention.
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.source] })],
)

export const tasks = pgTable(
  'tasks',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    external_id: text('external_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    status: text('status').notNull().default(''),
    type: text('type').notNull().default(''),
    assignee: text('assignee'),
    priority: text('priority'),
    labels: text('labels').notNull().default('[]'),
    description: text('description').notNull().default(''),
    comments: text('comments').notNull().default('[]'),
    excerpt: text('excerpt').notNull().default(''),
    linked_block_id: text('linked_block_id'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.source, t.external_id] }),
    index('idx_tasks_block').on(t.workspace_id, t.linked_block_id),
  ],
)

// A workspace's binding to a self-hosted runner pool (mirror of D1 migration 0013):
// the validated manifest + the encrypted scheduler-API secret bundle. The container
// agent executor dispatches repo-operating jobs to this pool when one is registered.
// `secrets_cipher` is opaque ciphertext (WebCryptoSecretCipher); never plaintext.
export const runnerPoolConnections = pgTable(
  'runner_pool_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    provider_id: text('provider_id').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    manifest_json: text('manifest_json').notNull(),
    secrets_cipher: text('secrets_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.provider_id] }),
    // A workspace has at most one live pool (the partial unique mirrors D1).
    uniqueIndex('idx_runner_pool_conn_workspace')
      .on(t.workspace_id)
      .where(sql`deleted_at IS NULL`),
  ],
)

// Human-actionable notifications (mirror of D1 migration 0024). First-class items
// surfaced on the board that outlive the run that raised them (merge_review /
// pipeline_complete / ci_failed). The optional structured `payload` (assessment /
// PR url / pipeline name) is JSON text. Closing the Node parity gap so the
// notification subsystem — and any channel, including Slack — fires here too.
export const notifications = pgTable(
  'notifications',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(),
    block_id: text('block_id'),
    execution_id: text('execution_id'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: text('payload'),
    // Render severity: 'normal' (yellow) or 'urgent' (red, escalated by the sweep). NULL = normal.
    severity: text('severity'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    resolved_at: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_notifications_open').on(t.workspace_id, t.status, t.created_at),
    index('idx_notifications_block').on(t.workspace_id, t.block_id, t.type, t.status),
  ],
)

// Per-workspace runtime settings (mirror of D1 migration 0004's `workspace_settings`):
// the human-wait escalation threshold + the per-service running-task limit policy. One
// row per workspace; the service lazily seeds DEFAULT_WORKSPACE_SETTINGS on first read.
export const workspaceSettings = pgTable('workspace_settings', {
  workspace_id: text('workspace_id').notNull().primaryKey(),
  waiting_escalation_minutes: integer('waiting_escalation_minutes').notNull().default(120),
  // 'off' | 'shared' | 'per_type'
  task_limit_mode: text('task_limit_mode').notNull().default('off'),
  // The shared cap when task_limit_mode = 'shared'; null otherwise.
  task_limit_shared: integer('task_limit_shared'),
  // JSON object of per-type caps when task_limit_mode = 'per_type'; null otherwise.
  task_limit_per_type: text('task_limit_per_type'),
  // Whether to store the full provided-context snapshot for each container agent
  // (the observability feature). On by default; integer 0/1 to match the SQLite store.
  store_agent_context: integer('store_agent_context').notNull().default(1),
  // Per-workspace toggle for the Kaizen agent (post-run grading). On by default; integer
  // 0/1 to match the SQLite store.
  kaizen_enabled: integer('kaizen_enabled').notNull().default(1),
  // LOCAL MODE ONLY toggles (inert on Cloudflare/Node): delegate container agents to the
  // workspace's runner pool, and/or the Tester's ephemeral environments to the registered
  // environment provider, instead of the host container runtime / in-container DinD. Off by
  // default; integer 0/1 to match the SQLite store.
  delegate_agents_to_runner_pool: integer('delegate_agents_to_runner_pool').notNull().default(0),
  delegate_test_env_to_provider: integer('delegate_test_env_to_provider').notNull().default(0),
  // Per-workspace spend budget (moved out of env). Both nullable; null ⇒ the built-in
  // DEFAULT_SPEND_PRICING base table.
  spend_currency: text('spend_currency'),
  spend_monthly_limit: doublePrecision('spend_monthly_limit'),
})

// Per-workspace merge threshold presets (mirror of D1 migration 0024's
// `merge_threshold_presets`). A task selects one via `blocks.merge_preset_id`; none →
// the workspace default (`is_default`, exactly one per workspace — the repository
// demotes the prior default when promoting a new one). `is_default` is 0/1 to mirror
// the D1 integer flag. Carries the auto-merge ceilings + `ci_max_attempts`.
export const mergeThresholdPresets = pgTable(
  'merge_threshold_presets',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    max_complexity: doublePrecision('max_complexity').notNull(),
    max_risk: doublePrecision('max_risk').notNull(),
    max_impact: doublePrecision('max_impact').notNull(),
    ci_max_attempts: integer('ci_max_attempts').notNull(),
    max_requirement_iterations: integer('max_requirement_iterations').notNull().default(3),
    max_requirement_concern_allowed: text('max_requirement_concern_allowed')
      .notNull()
      .default('none'),
    release_watch_window_minutes: integer('release_watch_window_minutes').notNull().default(30),
    release_max_attempts: integer('release_max_attempts').notNull().default(1),
    is_default: integer('is_default').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // Fast lookup of a workspace's default preset (mirrors idx_merge_presets_default).
    index('idx_merge_presets_default').on(t.workspace_id, t.is_default),
  ],
)

// Sandbox (parallel prompt/model testing surface). Lives in a DEDICATED Postgres
// `sandbox` schema (the analogue of the Worker's separate `SANDBOX_DB` D1 database), so
// the tables are unprefixed (`sandbox.prompt_versions`, …) — the schema is the namespace.
// Same connection/migrator as the main schema; the boot migrator creates the schema.
// Shipped baselines are NOT stored (read live from `@cat-factory/agents`); only candidate
// prompt versions are. JSON-shaped fields are text JSON. See backend/CLAUDE.md
// "Keep the runtimes symmetric".
export const sandboxSchema = pgSchema('sandbox')

export const sandboxPromptVersions = sandboxSchema.table(
  'prompt_versions',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    lineage_id: text('lineage_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    name: text('name').notNull(),
    origin: text('origin').notNull(),
    system_text: text('system_text').notNull(),
    base_prompt_id: text('base_prompt_id'),
    version: integer('version').notNull(),
    parent_id: text('parent_id'),
    labels: text('labels').notNull().default('[]'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    created_by: text('created_by'),
    archived_at: bigint('archived_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_sandbox_prompts_kind').on(t.workspace_id, t.agent_kind),
  ],
)

export const sandboxFixtures = sandboxSchema.table(
  'fixtures',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    payload: text('payload'),
    repo_ref: text('repo_ref'),
    objective: text('objective'),
    origin: text('origin').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const sandboxExperiments = sandboxSchema.table(
  'experiments',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    agent_kind: text('agent_kind').notNull(),
    judge_model: text('judge_model').notNull(),
    repeats: integer('repeats').notNull(),
    status: text('status').notNull(),
    matrix: text('matrix').notNull(),
    budget_tokens: bigint('budget_tokens', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    created_by: text('created_by'),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const sandboxRuns = sandboxSchema.table(
  'runs',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    experiment_id: text('experiment_id').notNull(),
    prompt_version_id: text('prompt_version_id').notNull(),
    model: text('model').notNull(),
    fixture_id: text('fixture_id').notNull(),
    repeat_index: integer('repeat_index').notNull(),
    status: text('status').notNull(),
    output_text: text('output_text'),
    usage: text('usage'),
    latency_ms: integer('latency_ms'),
    branch: text('branch'),
    pr_url: text('pr_url'),
    diff: text('diff'),
    error: text('error'),
    seed_sha: text('seed_sha'),
    prompt_label: text('prompt_label').notNull(),
    started_at: bigint('started_at', { mode: 'number' }),
    finished_at: bigint('finished_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_sandbox_runs_experiment').on(t.workspace_id, t.experiment_id),
    index('idx_sandbox_runs_queued').on(t.workspace_id, t.experiment_id, t.status),
  ],
)

export const sandboxGrades = sandboxSchema.table(
  'grades',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    run_id: text('run_id').notNull(),
    judge_model: text('judge_model').notNull(),
    scores: text('scores').notNull().default('[]'),
    weighted_total: doublePrecision('weighted_total').notNull(),
    objective: text('objective'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_sandbox_grades_run').on(t.workspace_id, t.run_id),
  ],
)

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

// Document-source integration (mirror of D1 migration 0012). A `source`
// discriminator tags every row so one pair of tables serves every provider. The
// credential bag is encrypted at rest (a WebCryptoSecretCipher envelope), never sent
// on the wire; at most one live connection per (workspace, source) — reconnecting
// replaces the row.
export const documentConnections = pgTable(
  'document_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    credentials: text('credentials').notNull(),
    label: text('label').notNull().default(''),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.source] })],
)

// One row per imported page: `body` holds the normalized Markdown the planner +
// agent-context injection consume, `linked_block_id` attaches it to a board block.
export const documents = pgTable(
  'documents',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    external_id: text('external_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    excerpt: text('excerpt').notNull().default(''),
    body: text('body').notNull().default(''),
    content_hash: text('content_hash').notNull().default(''),
    linked_block_id: text('linked_block_id'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.source, t.external_id] }),
    index('idx_documents_block').on(t.workspace_id, t.linked_block_id),
  ],
)

// Ephemeral-environment integration (mirror of D1 migration 0008). A workspace's
// binding to its own environment-management API (a declarative manifest) and the
// registry of environments provisioned from it. Credentials are opaque ciphertext
// (SecretCipher envelopes), never plaintext. At most one live provider per workspace
// (the partial unique index lets a tombstoned binding be replaced).
export const environmentConnections = pgTable(
  'environment_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    provider_id: text('provider_id').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    manifest_json: text('manifest_json').notNull(),
    secrets_cipher: text('secrets_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.provider_id] }),
    uniqueIndex('idx_environment_conn_workspace')
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
    execution_id: text('execution_id'),
    provider_id: text('provider_id').notNull(),
    external_id: text('external_id'),
    url: text('url'),
    status: text('status').notNull(),
    access_cipher: text('access_cipher'),
    provision_fields_cipher: text('provision_fields_cipher'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    last_error: text('last_error'),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
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

// Repo-bootstrap feature: managed reference architectures a new repo is bootstrapped
// from (mirror of D1 migration 0010). The bootstrap *runs* themselves are stored as
// kind='bootstrap' rows of the unified agent_runs table (no separate table), exactly
// like the Worker.
export const referenceArchitectures = pgTable(
  'reference_architectures',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    default_instructions: text('default_instructions').notNull().default(''),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    index('idx_reference_architectures_workspace')
      .on(t.workspace_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// Slack integration (mirror of D1 migration 0037). An additional delivery transport
// for the notification mechanism. Per-account connection (+ encrypted bot token,
// `token_cipher` is a WebCryptoSecretCipher envelope, never plaintext), per-workspace
// routing, and the per-account GitHub→Slack member map for @-mentions.
export const slackConnections = pgTable(
  'slack_connections',
  {
    account_id: text('account_id').primaryKey(),
    team_id: text('team_id').notNull(),
    team_name: text('team_name').notNull(),
    team_icon_url: text('team_icon_url'),
    bot_user_id: text('bot_user_id'),
    scopes: text('scopes'),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  // A Slack team binds to at most one live account (mirrors the D1 partial unique).
  (t) => [
    uniqueIndex('idx_slack_conn_team')
      .on(t.team_id)
      .where(sql`deleted_at IS NULL`),
  ],
)

export const slackSettings = pgTable('slack_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  routes: text('routes').notNull().default('{}'),
  mentions_enabled: integer('mentions_enabled').notNull().default(0),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const slackMemberMappings = pgTable('slack_member_mappings', {
  account_id: text('account_id').primaryKey(),
  entries: text('entries').notNull().default('[]'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Provider-subscription token pool (mirror of D1 migration 0035): per-workspace,
// per-vendor subscription credentials (Claude Pro/Max OAuth token, ChatGPT
// auth.json) authenticating the Claude Code / Codex harnesses. The credential is
// stored as an opaque SecretCipher envelope; usage counters drive usage-aware
// rotation. A workspace may hold many tokens per vendor (a pool).
export const providerSubscriptionTokens = pgTable(
  'provider_subscription_tokens',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    vendor: text('vendor').notNull(),
    label: text('label').notNull(),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    window_started_at: bigint('window_started_at', { mode: 'number' }),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_subs_pool').on(t.workspace_id, t.vendor, t.deleted_at)],
)

// Direct-provider API-key pool: UI-onboarded vendor API keys scoped to an
// account, workspace, or user (mirror of D1 migration 0042). The key is stored as
// an opaque SecretCipher envelope — never plaintext.
export const providerApiKeys = pgTable(
  'provider_api_keys',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id').notNull(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    key_cipher: text('key_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    window_started_at: bigint('window_started_at', { mode: 'number' }),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_api_keys_pool').on(t.scope, t.scope_id, t.provider, t.deleted_at)],
)

// Individual-usage subscriptions (Claude): per-USER, never pooled (mirror of D1
// migration 0039). The credential is double-encrypted (password layer inside the
// system layer).
export const personalSubscriptions = pgTable(
  'personal_subscriptions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    vendor: text('vendor').notNull(),
    label: text('label').notNull(),
    token_cipher: text('token_cipher').notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_personal_subs_user_vendor')
      .on(t.user_id, t.vendor)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_personal_subs_expiry')
      .on(t.expires_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

// Per-USER locally-run model endpoints (Ollama / LM Studio / llama.cpp / vLLM / custom),
// keyed by (user_id, provider). The optional bearer key is system-key-encrypted in
// `api_key_cipher`; `models` is a JSON array of enabled model ids (mirror of D1
// migration 0002).
export const localModelEndpoints = pgTable(
  'local_model_endpoints',
  {
    user_id: text('user_id').notNull(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    api_key_cipher: text('api_key_cipher'),
    models: text('models').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.provider] })],
)

// Generic per-USER secrets — token-style credentials keyed by (user_id, kind) (a GitHub
// PAT today; future repository/provider tokens as new kinds). Mirror of D1 migration 0009
// / D1UserSecretRepository. The secret is single-system-key ciphertext; non-secret fields
// ride in metadata_json.
export const userSecrets = pgTable(
  'user_secrets',
  {
    user_id: text('user_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    secret_cipher: text('secret_cipher').notNull(),
    metadata_json: text('metadata_json'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.kind] })],
)

// Per-WORKSPACE enabled GATEWAY models (the dynamic catalog subset) — OpenRouter today,
// LiteLLM and others later. `models` is a JSON array of { id, name, contextLength?,
// inputPerMillion, outputPerMillion } — the enabled subset with cached context + price
// (mirror of D1 migration 0006). Keyed by (workspace_id, provider).
export const providerModelCatalog = pgTable(
  'provider_model_catalog',
  {
    workspace_id: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    models: text('models').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.provider] })],
)

// Per-run activations of a personal credential: the raw token re-encrypted with the
// system key only, scoped to one execution with a TTL (mirror of D1 migration 0039).
export const subscriptionActivations = pgTable(
  'subscription_activations',
  {
    id: text('id').primaryKey(),
    execution_id: text('execution_id').notNull(),
    user_id: text('user_id').notNull(),
    vendor: text('vendor').notNull(),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_sub_activations_run').on(t.execution_id, t.user_id, t.vendor),
    index('idx_sub_activations_expiry').on(t.expires_at),
  ],
)

// GitHub App installation bindings (mirror of D1 migration 0004 + the account_id /
// app_id columns from 0017 / 0019). The container executor reads this to resolve a
// run's installation id and mint a short-lived push token; tokens are cached
// in-memory by the auth adapter, never persisted here.
export const githubInstallations = pgTable(
  'github_installations',
  {
    installation_id: bigint('installation_id', { mode: 'number' }).primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id'),
    account_login: text('account_login').notNull(),
    target_type: text('target_type').notNull(),
    app_id: text('app_id'),
    cached_token: text('cached_token'),
    token_expires_at: bigint('token_expires_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_gh_install_workspace')
      .on(t.workspace_id)
      .where(sql`deleted_at IS NULL`),
    index('idx_gh_install_account')
      .on(t.account_id)
      .where(sql`deleted_at IS NULL`),
  ],
)

// Projection of a workspace's GitHub repositories (mirror of D1 migration 0004).
// `block_id` links a repo to a board service frame and is owned by the board link
// (never overwritten by sync). The container executor resolves a run's target repo
// from the service frame the block sits under.
export const githubRepos = pgTable(
  'github_repos',
  {
    workspace_id: text('workspace_id').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    default_branch: text('default_branch'),
    private: integer('private').notNull().default(0),
    block_id: text('block_id'),
    // Whether the repo is a monorepo hosting several services (board-owned, like
    // block_id — sync preserves it). See contracts `GitHubRepo.isMonorepo`.
    is_monorepo: integer('is_monorepo').notNull().default(0),
    etag: text('etag'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.github_id] }),
    index('idx_gh_repos_install').on(t.installation_id),
  ],
)

// GitHub projection tables (mirror of D1 migration 0004; sync cursors re-keyed by
// migration 0032). Local read models of a workspace's repos' branches / PRs / issues /
// commits / check runs, populated by the inline GitHub sync. `protected`/`merged` are
// 0/1 to mirror the D1 integer flags; soft-delete tombstones where the D1 tables have one.
export const githubBranches = pgTable(
  'github_branches',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    name: text('name').notNull(),
    head_sha: text('head_sha').notNull(),
    protected: integer('protected').notNull().default(0),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.name] })],
)

export const githubPullRequests = pgTable(
  'github_pull_requests',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    number: integer('number').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    head_ref: text('head_ref'),
    base_ref: text('base_ref'),
    head_sha: text('head_sha'),
    merged: integer('merged').notNull().default(0),
    author: text('author'),
    gh_updated_at: bigint('gh_updated_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.number] }),
    index('idx_gh_pr_state').on(t.workspace_id, t.state),
  ],
)

export const githubIssues = pgTable(
  'github_issues',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    number: integer('number').notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    author: text('author'),
    labels: text('labels').notNull().default('[]'),
    gh_updated_at: bigint('gh_updated_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.number] })],
)

export const githubCommits = pgTable(
  'github_commits',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    author: text('author'),
    authored_at: bigint('authored_at', { mode: 'number' }),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.sha] })],
)

export const githubCheckRuns = pgTable(
  'github_check_runs',
  {
    workspace_id: text('workspace_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    github_id: bigint('github_id', { mode: 'number' }).notNull(),
    head_sha: text('head_sha').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.repo_github_id, t.github_id] }),
    index('idx_gh_checks_sha').on(t.workspace_id, t.repo_github_id, t.head_sha),
  ],
)

// Incremental-sync bookkeeping, keyed by (installation, repo, kind) so a repo is
// fetched once per org and fanned out (mirror of D1 migration 0032).
export const githubSyncCursors = pgTable(
  'github_sync_cursors',
  {
    installation_id: bigint('installation_id', { mode: 'number' }).notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    etag: text('etag'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    since_iso: text('since_iso'),
  },
  (t) => [primaryKey({ columns: [t.installation_id, t.repo_github_id, t.kind] })],
)
