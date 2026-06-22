import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

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
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    account_id: text('account_id'),
    owner_user_id: bigint('owner_user_id', { mode: 'number' }),
  },
  // listVisible filters by owner_user_id (legacy) and account_id (membership scope).
  (t) => [
    index('idx_workspaces_owner').on(t.owner_user_id),
    index('idx_workspaces_account').on(t.account_id),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    github_account_login: text('github_account_login'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // The default cloud provider new services in this account inherit.
    default_cloud_provider: text('default_cloud_provider'),
  },
  // Enforce one personal account per GitHub login (a correctness constraint, not just
  // a lookup index) — the partial unique index `findPersonalByLogin` relies on.
  (t) => [
    uniqueIndex('idx_accounts_personal')
      .on(t.github_account_login)
      .where(sql`type = 'personal'`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    account_id: text('account_id').notNull(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    role: text('role').notNull().default('member'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.user_id] }),
    index('idx_memberships_user').on(t.user_id),
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
    confidence: doublePrecision('confidence'),
    module_name: text('module_name'),
    fragment_ids: text('fragment_ids'),
    // Service-level (frame): the service's selected best-practice fragment ids (JSON array).
    service_fragment_ids: text('service_fragment_ids'),
    model_id: text('model_id'),
    pull_request: text('pull_request'),
    merge_preset_id: text('merge_preset_id'),
    pipeline_id: text('pipeline_id'),
    // Task-level agent config-contribution values (JSON id->value map).
    agent_config: text('agent_config'),
    // Service-level (frame): Tester local-infra docker-compose path, the "no infra
    // dependencies" flag, the cloud provider and the abstract instance size.
    test_compose_path: text('test_compose_path'),
    no_infra_dependencies: integer('no_infra_dependencies'),
    cloud_provider: text('cloud_provider'),
    instance_size: text('instance_size'),
    // The account-owned service this block belongs to (migration 0031); will become the
    // physical scope key once the repositories switch off workspace_id.
    service_id: text('service_id'),
    // GitHub user id of the block's creator (migration 0038); drives "notify the task
    // creator" routing. Nullable — legacy blocks / auth-disabled dev have no creator.
    created_by: bigint('created_by', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_blocks_parent').on(t.workspace_id, t.parent_id),
    index('idx_blocks_service').on(t.service_id),
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
  (t) => [index('idx_token_usage_created').on(t.created_at)],
)

// Per-workspace, per-agent-kind default model selection (mirror of D1 migration
// 0028). One row per (workspace, agent kind); the model each kind defaults to,
// overriding the env routing for that workspace. A kind absent for a workspace
// falls back to the env routing.
export const workspaceModelDefaults = pgTable(
  'workspace_model_defaults',
  {
    workspace_id: text('workspace_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    model_id: text('model_id').notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.agent_kind] })],
)

// Per-workspace default service-fragment selection (mirror of D1 migration 0040). One
// row per workspace; the best-practice fragment ids new services inherit, JSON array.
export const workspaceFragmentDefaults = pgTable('workspace_fragment_defaults', {
  workspace_id: text('workspace_id').primaryKey(),
  fragment_ids: text('fragment_ids').notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// LLM observability sink (mirror of D1 migration 0026). One row per proxied
// container-agent model call: full prompt/response, output-limit headroom and the
// transport-vs-execution latency split. Pruned aggressively by retention (the full
// bodies make it heavy); booleans are integer 0/1 to match the SQLite store.
export const llmCallMetrics = pgTable(
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
  },
  (t) => [
    index('idx_llm_call_metrics_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_llm_call_metrics_created').on(t.created_at),
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
    // JSON ARRAY of { rating, threshold, passed, feedback } — the companion's verdicts
    // across every rework cycle (migration 0036). Null until a rework has been gated.
    companion: text('companion'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // getByBlock looks up a block's reviews (newest wins), mirroring D1 migration 0021.
    index('idx_requirement_reviews_block').on(t.workspace_id, t.block_id),
  ],
)

// A workspace's issue-tracker selection (mirror of D1 migration 0029).
export const trackerSettings = pgTable('tracker_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  tracker: text('tracker'),
  jira_project_key: text('jira_project_key'),
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
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    resolved_at: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_notifications_open').on(t.workspace_id, t.status, t.created_at),
    index('idx_notifications_block').on(t.workspace_id, t.block_id, t.type, t.status),
  ],
)

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
    is_default: integer('is_default').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // Fast lookup of a workspace's default preset (mirrors idx_merge_presets_default).
    index('idx_merge_presets_default').on(t.workspace_id, t.is_default),
  ],
)

// Board-scan feature: the persisted "repository blueprint" — a repo decomposed into
// the canonical service → modules tree (mirror of D1 migration 0011). Exactly one
// blueprint per (workspace, repo): a re-scan replaces it in place (the unique index
// is the upsert key). The tree is stored whole as JSON in `service_json`.
export const repoBlueprints = pgTable(
  'repo_blueprints',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    source: text('source').notNull(),
    service_json: text('service_json').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_repo_blueprints_repo').on(t.workspace_id, t.repo_owner, t.repo_name),
    index('idx_repo_blueprints_workspace').on(t.workspace_id, t.updated_at),
  ],
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

// Individual-usage subscriptions (Claude): per-USER, never pooled (mirror of D1
// migration 0039). The credential is double-encrypted (password layer inside the
// system layer).
export const personalSubscriptions = pgTable(
  'personal_subscriptions',
  {
    id: text('id').primaryKey(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
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

// Per-run activations of a personal credential: the raw token re-encrypted with the
// system key only, scoped to one execution with a TTL (mirror of D1 migration 0039).
export const subscriptionActivations = pgTable(
  'subscription_activations',
  {
    id: text('id').primaryKey(),
    execution_id: text('execution_id').notNull(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
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
