import { sql } from 'drizzle-orm'
import {
  bigint,
  customType,
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

// Raw binary column (Postgres `bytea`), used by the Node-only `binary_artifact_blobs`
// store-in-DB blob backend. Reads/writes as a `Uint8Array`.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value)
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value)
  },
})

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
    // Workspace RBAC access mode ('account' | 'restricted'); default preserves the legacy
    // "every account member sees it" behaviour so no existing row changes.
    access_mode: text('access_mode').notNull().default('account'),
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
    // ON DELETE RESTRICT: a users row can't be removed while a login identity still points
    // at it — the DB-level guard against the dangling-identity orphaning incident.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
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
    // ON DELETE RESTRICT: can't drop a user that still owns a personal account.
    owner_user_id: text('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // The default cloud provider new services in this account inherit.
    default_cloud_provider: text('default_cloud_provider'),
    // The account-tier monthly spend budget (base pricing currency). Null = none.
    spend_monthly_limit: doublePrecision('spend_monthly_limit'),
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
    // ON DELETE RESTRICT: a users row can't be removed while it still holds a membership.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Combinable roles (admin / developer / product) as a CSV; defaults to developer.
    roles: text('roles').notNull().default('developer'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.user_id] }),
    index('idx_memberships_user').on(t.user_id),
  ],
)

// Workspace membership (workspace RBAC, migration 0052). Scopes a user to a board with a
// single-valued workspace role; a restricted board reads it as the sole grant, an
// account-mode board honours it as an upgrade-only overlay.
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    // ON DELETE CASCADE: a deleted board takes its roster (the Drizzle FK; the D1 side
    // relies on the workspace-delete cascade list since D1 doesn't enforce FKs).
    workspace_id: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // ON DELETE RESTRICT: mirrors memberships.user_id — can't drop a user with a live row.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Single value: admin | member | viewer (a strict hierarchy, not a CSV set).
    role: text('role').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    // Audit: who granted the row; null for system grants (creator auto-enroll). No FK.
    added_by_user_id: text('added_by_user_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.user_id] }),
    // Drives listWorkspaceIdsForUser + the visibility subquery.
    index('idx_workspace_members_user').on(t.user_id),
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

// ADR 0026 D6.1 — the non-secret fingerprint of the deployment's master ENCRYPTION_KEY,
// a per-DEPLOYMENT SINGLETON addressed by a fixed `id` ('key'). Seeded once on first boot
// and compared on every boot to detect key drift before any request touches a stale secret.
// The value is a one-way HKDF of the key (leaks nothing usable), so it is stored in the
// clear. Mirrored to D1 (`key_fingerprint` migration) per the runtime-symmetry rule.
export const keyFingerprint = pgTable('key_fingerprint', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
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

// Password-reset tokens ("forgot my password"). Only the SHA-256 token hash is stored;
// single-use (status flips to 'used') and expiring. Mirrors the D1 table.
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    token_hash: text('token_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_password_reset_tokens_token').on(t.token_hash),
    index('idx_password_reset_tokens_user').on(t.user_id, t.status),
    // `deleteExpired` sweeps on `expires_at < ?`; index it like every other TTL column
    // (idx_environments_expiry / idx_personal_subs_expiry) so the sweep isn't a full scan.
    index('idx_password_reset_tokens_expiry').on(t.expires_at),
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
    // Task-level: membership link to an `initiative`-level block (a task the
    // initiative's execution loop spawned), independent of parent_id.
    initiative_id: text('initiative_id'),
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
    // Task-level: PRs a multi-repo run opened in connected services' repos beside the
    // own-service `pull_request` — serialized JSON array of { repo, frameId?, ref }.
    peer_pull_requests: text('peer_pull_requests'),
    merge_preset_id: text('merge_preset_id'),
    model_preset_id: text('model_preset_id'),
    pipeline_id: text('pipeline_id'),
    // Task-level agent config-contribution values (JSON id->value map).
    agent_config: text('agent_config'),
    // Service-owned provisioning config (the "what + where") — serialized ServiceProvisioning.
    // Carries the provision type + in-repo specifics; the Tester's infra stand-up + the
    // deployer read it. The cloud provider and abstract instance size follow.
    provisioning: text('provisioning'),
    cloud_provider: text('cloud_provider'),
    instance_size: text('instance_size'),
    // Frontend-frame-level (`type: 'frontend'`): serialized FrontendConfig — how to
    // build/serve/mock the frontend for a self-contained UI test + its backend
    // bindings (env-var → upstream), which double as the board's frontend→service links.
    frontend_config: text('frontend_config'),
    // Service-frame-level (`type: 'service'`): the service's directed connections to the
    // other services it uses (consumer→provider), serialized JSON array of
    // { serviceBlockId, description? }. Board edges + the source of a task's
    // "involved services" choices.
    service_connections: text('service_connections'),
    // Task-level: the selected connected service frames directly involved in this task
    // beyond its own service (JSON array of frame block ids) — spun up as ephemeral
    // environments too; the coding agent may change their repos.
    involved_service_ids: text('involved_service_ids'),
    // Task-level (document tasks): read-only reference repos for the `doc-writer` agent —
    // serialized JSON array of { githubId, owner, name, defaultBranch, installationId? }.
    reference_repos: text('reference_repos'),
    // Task-level: pre-existing branches of the primary target repo handed to the run as input
    // — serialized JSON array of { name, mode: 'reference' | 'working' }. One optional
    // `working` branch the run builds inside; any number of read-only `reference` branches.
    apriori_branches: text('apriori_branches'),
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
    // Headless marker (mirrors the D1 `blocks.internal` column): 1 ⇒ a public-API "initiative"
    // anchor block, excluded from every board projection. Null/absent ⇒ a normal, visible block.
    internal: integer('internal'),
    // Archive marker (mirrors the D1 `blocks.archived` column): 1 ⇒ an archived service frame,
    // hidden from the board projection with its whole subtree but fully preserved and restorable
    // with no expiry. Null/absent ⇒ a normal, visible block.
    archived: integer('archived'),
    // Monotonic insert sequence (Postgres has no SQLite rowid): block list reads come
    // back in insertion order — sibling order in the board tree, deterministic
    // snapshots — matching the Cloudflare facade (which orders by `rowid`).
    // Auto-assigned on insert.
    seq: serial('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_blocks_parent').on(t.workspace_id, t.parent_id),
    index('idx_blocks_epic').on(t.workspace_id, t.epic_id),
    index('idx_blocks_initiative').on(t.workspace_id, t.initiative_id),
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
    // Optional prose description shown next to the step list in the pickers/builder (mirror of D1
    // migration 0055_pipeline_description); NULL ⇒ no description.
    description: text('description'),
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
    // Nullable JSON array of per-step Follow-up companion toggles, parallel to agent_kinds:
    // `false` disables the Coder's Follow-up companion on that step (mirror of D1 0032).
    follow_ups: text('follow_ups'),
    // Nullable JSON array of per-step test quality-control companion configs, parallel to
    // agent_kinds: an `enabled: false` entry turns the QC companion off on a Tester step, an
    // entry with `gating` makes the coverage audit estimate-conditional (mirror of D1 0032).
    tester_quality: text('tester_quality'),
    // Nullable JSON array of per-step options bags, parallel to agent_kinds: the extensible
    // home for new per-step parameters (see `stepOptionsSchema`), replacing the one-column-per-
    // knob pattern. Today carries only `autoRecommend` (mirror of D1 0044_pipeline_step_options).
    step_options: text('step_options'),
    // Nullable JSON array of free-form organizational labels; `archived` (truthy) hides the
    // pipeline from the default library view (mirror of D1 0003).
    labels: text('labels'),
    archived: integer('archived'),
    // Monotonic seed version for a built-in pipeline (mirror of D1 migration 0017); NULL on
    // custom/cloned pipelines and on legacy rows. Lets a workspace's persisted copy be compared
    // against the current `seedPipelines()` catalog and offered a reseed when it moves ahead.
    version: integer('version'),
    // `public = 1` marks a pipeline callable via the public API (mirror of D1 migration 0034);
    // NULL/absent ⇒ not exposed. Only inline pipelines are honored by the public surface.
    public: integer('public'),
    // How the pipeline may be LAUNCHED: `'one-off'` / `'recurring'` / `'both'` (mirror of D1
    // migration 0037); NULL/absent ⇒ unrestricted (`'both'`).
    availability: text('availability'),
    // The pipeline's use-case classifier: `'build'` / `'document'` / `'review'` / `'research'` /
    // `'planning'` (mirror of D1 migration 0056_pipeline_purpose). NULL/absent ⇒ unclassified.
    // Drives the task pickers (a `document` task offers only `'document'`) and the builder palette.
    purpose: text('purpose'),
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
    // Optimistic-concurrency revision, bumped on every write; guarded by compareAndSwap
    // so a human-action write that raced the driver is retried, not silently clobbered.
    rev: integer('rev').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // listByWorkspace filters by workspace_id and orders by created_at.
    index('idx_agent_runs_workspace').on(t.workspace_id, t.created_at),
    index('idx_agent_runs_status_lease').on(t.status, t.updated_at),
    index('idx_agent_runs_block').on(t.workspace_id, t.block_id),
    index('idx_agent_runs_service').on(t.service_id),
    // Serves the lean live-run projection `ExecutionRepository.listLive`
    // (workspace_id = ? AND kind = 'execution' AND status IN (running/blocked/paused)) backing the
    // per-service task-concurrency dispatch guard + resumePaused. Mirrors D1 migration 0048.
    index('idx_agent_runs_ws_kind_status').on(t.workspace_id, t.kind, t.status),
    // At most ONE live execution run per block — the one-run-per-block invariant the engine
    // relied on via a racy delete-then-insert, now enforced atomically so two concurrent
    // starts can't create two live runs (two drivers, two containers). Partial (only live
    // execution rows), so terminal history is unconstrained and bootstrap rows never collide.
    // Mirrors D1 migration 0033. See DrizzleExecutionRepository.insertLive.
    uniqueIndex('uniq_live_execution_per_block')
      .on(t.workspace_id, t.block_id)
      .where(sql`${t.kind} = 'execution' AND ${t.status} IN ('running', 'blocked', 'paused')`),
  ],
)

export const tokenUsage = pgTable(
  'token_usage',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    // Owning account + initiating user, denormalized for the account/user budget tiers.
    account_id: text('account_id'),
    user_id: text('user_id'),
    execution_id: text('execution_id'),
    agent_kind: text('agent_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cost_estimate: doublePrecision('cost_estimate').notNull().default(0),
    // Metered (per-token cost, summed by the budget gate) vs subscription (flat-rate quota
    // harness usage, counted for the usage report but excluded from every spend rollup).
    billing: text('billing').notNull().default('metered'),
    // The subscription vendor for a subscription row (claude/codex/glm/kimi/deepseek).
    vendor: text('vendor'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_token_usage_created').on(t.created_at),
    // Per-workspace spend rollup (`totalsSinceForWorkspace`) runs on every metered
    // LLM-proxy call + web-search + step gate; index (workspace_id, created_at) so it
    // doesn't scan the whole ledger and filter workspace_id row-by-row.
    index('idx_token_usage_workspace').on(t.workspace_id, t.created_at),
    // Account/user tier rollups (`totalsSinceForAccount` / `totalsSinceForUser`).
    index('idx_token_usage_account').on(t.account_id, t.created_at),
    index('idx_token_usage_user').on(t.user_id, t.created_at),
  ],
)

export const userSettings = pgTable('user_settings', {
  user_id: text('user_id').primaryKey(),
  // The user-tier monthly spend budget (base pricing currency). Null = none.
  spend_monthly_limit: doublePrecision('spend_monthly_limit'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

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
    // Monotonic catalog version for a built-in preset (NULL on custom; treated as 0).
    version: integer('version'),
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
    // Head commit sha of the source dir at the last sync (name kept for column stability;
    // it no longer stores the former tree-listing digest). Powers the staleness probe.
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

// Repo-sourced Claude Skills library (docs/initiatives/repo-skills.md, slice 1;
// mirror of D1 migration 0052). An account links a repo directory of skill folders;
// the link is synced into the account's skill catalog. ONE tier (the account), a
// directory-per-skill sync unit, resources JSON-encoded in a `text` column.
export const skillSources = pgTable(
  'skill_sources',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    repo_owner: text('repo_owner').notNull(),
    repo_name: text('repo_name').notNull(),
    git_ref: text('git_ref').notNull().default('HEAD'),
    dir_path: text('dir_path').notNull().default(''),
    // Head commit sha of the source dir at the last sync; powers the staleness probe.
    last_synced_commit: text('last_synced_commit'),
    last_synced_at: bigint('last_synced_at', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('idx_skill_sources_unique').on(
      t.account_id,
      t.repo_owner,
      t.repo_name,
      t.git_ref,
      t.dir_path,
    ),
    index('idx_skill_sources_account')
      .on(t.account_id)
      .where(sql`${t.deleted_at} IS NULL`),
    // Push-webhook fan-out (slice 4) looks sources up by repo.
    index('idx_skill_sources_repo')
      .on(t.repo_owner, t.repo_name)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
)

export const accountSkills = pgTable(
  'account_skills',
  {
    skill_id: text('skill_id').notNull(),
    account_id: text('account_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    // JSON [{ path, sha, size }] manifest of sibling resource files (bodies not stored).
    resources: text('resources').notNull().default('[]'),
    source_id: text('source_id').notNull(),
    source_path: text('source_path').notNull(),
    source_sha: text('source_sha').notNull(),
    pinned_commit: text('pinned_commit'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.skill_id] }),
    index('idx_account_skills_account')
      .on(t.account_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('idx_account_skills_source')
      .on(t.source_id)
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

// One web search a container agent performed through the backend search proxy. Recorded
// best-effort (gated by the same LLM_RECORD_PROMPTS + storeAgentContext double switch as
// agent_context_snapshots) and pruned on the same retention window. Mirrors the D1
// agent_search_queries table column-for-column.
export const agentSearchQueries = telemetry.table(
  'agent_search_queries',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    // The upstream backend that served the search (`brave` | `searxng`), or null.
    provider: text('provider'),
    query: text('query').notNull().default(''),
    result_count: integer('result_count').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_agent_search_queries_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_agent_search_queries_created').on(t.created_at),
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
    // Manual-only schedule: never auto-fired by the sweeper (`listDue` filters `on_demand = 0`).
    on_demand: integer('on_demand').notNull().default(0),
    // Nullable JSON issue-intake config (mirror of D1 migration 0038): source + board
    // scope + predicates for a pipeline with a `bug-intake` step.
    issue_intake: text('issue_intake'),
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

// Interactive document-interview sessions (WS5; mirror of D1 migration 0040): one live session
// per document-authoring block. The Q&A transcript lives as a JSON array (text) in `qa`;
// `round`/`max_rounds` track the iterative interview loop; `brief` is the synthesized authoring
// brief the writer starts from once the interview converges.
export const docInterviewSessions = pgTable(
  'doc_interview_sessions',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    status: text('status').notNull(),
    round: integer('round').notNull().default(0),
    max_rounds: integer('max_rounds').notNull().default(4),
    qa: text('qa').notNull().default('[]'),
    brief: text('brief'),
    model: text('model'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // getByBlock looks up a block's sessions (newest wins), mirroring D1 migration 0040.
    index('idx_doc_interview_sessions_block').on(t.workspace_id, t.block_id),
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

// Initiatives: the long-running multi-task work container (mirror of D1 migration
// 0035_initiatives). One row per `initiative`-level block; the whole entity lives in
// the `doc` JSON blob with the loop-relevant keys (status, rev) lifted into columns.
// `rev` is the optimistic-concurrency token every post-insert write CAS-es on.
export const initiatives = pgTable(
  'initiatives',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull(),
    rev: integer('rev').notNull(),
    doc: text('doc').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    uniqueIndex('idx_initiatives_block').on(t.workspace_id, t.block_id),
    // The tracker folder `docs/initiatives/<slug>/` is keyed by slug, so a slug must be
    // unique per workspace — this backstops the read-then-insert slug derivation in
    // InitiativeService.create against a concurrent same-title race (the loser's insert
    // fails rather than silently sharing a folder with the winner).
    uniqueIndex('idx_initiatives_slug').on(t.workspace_id, t.slug),
    // The cron sweeper's work list (slice 3): every `executing` initiative.
    index('idx_initiatives_status').on(t.status),
  ],
)

// A workspace's issue-tracker selection (mirror of D1 migration 0029).
export const trackerSettings = pgTable('tracker_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  tracker: text('tracker'),
  jira_project_key: text('jira_project_key'),
  linear_team_id: text('linear_team_id'),
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
    // Which agent-runner backend this row configures (`manifest` | `kubernetes` | …).
    kind: text('kind').notNull().default('manifest'),
    provider_id: text('provider_id').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    // Historical name; now holds the whole discriminated `RunnerBackendConfig` JSON.
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
    // At most ONE open notification per (workspace, block, type) — the dedup invariant the
    // service relied on via a racy read-before-write, now enforced atomically so two
    // concurrent raises can't stack duplicate open cards. Partial (only open rows) so
    // dismissed/acted history is unconstrained; block-less cards (NULL block_id) are exempt.
    uniqueIndex('uniq_notifications_open_block')
      .on(t.workspace_id, t.block_id, t.type)
      .where(sql`${t.status} = 'open'`),
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
  // Retention window (days) for binary artifacts (UI screenshots + reference designs)
  // before the cleanup sweep deletes them. Default 14; mirrors the D1 column.
  artifact_retention_days: integer('artifact_retention_days').notNull().default(14),
  // Per-workspace toggle for the Kaizen agent (post-run grading). On by default; integer
  // 0/1 to match the SQLite store.
  kaizen_enabled: integer('kaizen_enabled').notNull().default(1),
  // LOCAL MODE ONLY toggle (inert on Cloudflare/Node): delegate container agents to the
  // workspace's runner pool instead of the host container runtime. Off by default; integer
  // 0/1 to match the SQLite store.
  delegate_agents_to_runner_pool: integer('delegate_agents_to_runner_pool').notNull().default(0),
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
export const riskPolicies = pgTable(
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
    max_tester_quality_iterations: integer('max_tester_quality_iterations').notNull().default(3),
    release_watch_window_minutes: integer('release_watch_window_minutes').notNull().default(30),
    release_max_attempts: integer('release_max_attempts').notNull().default(1),
    human_review_grace_minutes: integer('human_review_grace_minutes').notNull().default(10),
    // When 0 the `merger` step never auto-merges — every PR is routed to human review.
    auto_merge_enabled: integer('auto_merge_enabled').notNull().default(1),
    // Estimate gating for the implementation-fork decision phase, a JSON `StepGating` blob
    // (mirror of D1's `fork_decision` TEXT column). NULL ⇒ off in `auto` mode.
    fork_decision: text('fork_decision'),
    // Monotonic catalog version for a built-in preset (NULL on custom; treated as 0).
    version: integer('version'),
    is_default: integer('is_default').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // Fast lookup of a workspace's default preset (mirrors idx_merge_presets_default).
    index('idx_merge_presets_default').on(t.workspace_id, t.is_default),
  ],
)

// Shared stacks — long-lived compose infra a per-PR consumer environment attaches to over an
// external network (mirror of D1 migration 0041's `shared_stacks`). JSON-shaped columns
// (`compose_files`/`compose_profiles`/`env_files`/`managed_networks`/`setup_steps`/
// `health_gate`) are `text` JSON; `allow_host_commands` is 0/1 to mirror D1. Behaviourally
// identical to the D1 repo so the cross-runtime conformance suite asserts the same round-trip.
export const sharedStacks = pgTable(
  'shared_stacks',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    clone_url: text('clone_url').notNull(),
    git_ref: text('git_ref'),
    compose_files: text('compose_files').notNull().default('[]'),
    compose_profiles: text('compose_profiles').notNull().default('[]'),
    env_files: text('env_files').notNull().default('[]'),
    managed_networks: text('managed_networks').notNull().default('[]'),
    setup_steps: text('setup_steps').notNull().default('[]'),
    prerequisites: text('prerequisites').notNull().default('[]'),
    health_gate: text('health_gate'),
    allow_host_commands: integer('allow_host_commands').notNull().default(0),
    status: text('status').notNull().default('stopped'),
    last_error: text('last_error'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
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
    // Workspace+DocKind role link (WS1 items 2–4), alongside `linked_block_id`: `template` |
    // `exemplar` scoped to `doc_kind`. Nullable — a plain imported / block-linked doc has neither.
    role: text('role'),
    doc_kind: text('doc_kind'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.source, t.external_id] }),
    index('idx_documents_block').on(t.workspace_id, t.linked_block_id),
    index('idx_documents_role').on(t.workspace_id, t.role, t.doc_kind),
  ],
)

// Ephemeral-environment integration (mirror of D1 migration 0025). A workspace's per-
// provision-type infra HANDLERS (how a service's declared provision type is stood up) and
// the registry of environments provisioned from them. Keyed by (workspace_id,
// provision_type, manifest_id) — one handler per type, plus one per pinned custom manifest
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
    // cross-frame discovery key — a `frontend` frame's `service` binding resolves the live env
    // by the bound service FRAME id, not the task the deployer ran on (`block_id`).
    frame_id: text('frame_id'),
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
    // The frame's provisioning config, pinned at dispatch (JSON) — see the kernel port.
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
    // Lifecycle flags (0/1): `enabled` gates leasing, `is_default` pins the preferred token
    // for a (workspace, vendor). Mirror of D1 migration 0058.
    enabled: integer('enabled').notNull().default(1),
    is_default: integer('is_default').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_subs_pool').on(t.workspace_id, t.vendor, t.deleted_at)],
)

// Subscription quota-cycle counters (mirror of D1 migration 0047): the MODELED
// rolling-window usage behind "how much of a subscription's quota cycle is left"
// (usage-and-quota-tracking, Part B). One row per (scope, scope_id, vendor, window_kind):
// scope 'pooled' → a provider_subscription_tokens id; scope 'user' → a user id. Each
// window accumulates the same tokens but resets on its own cadence (window_started_at is
// the first-use anchor, re-stamped when the window ages out). Never billed.
export const subscriptionQuotaCycles = pgTable(
  'subscription_quota_cycles',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id').notNull(),
    vendor: text('vendor').notNull(),
    window_kind: text('window_kind').notNull(),
    window_started_at: bigint('window_started_at', { mode: 'number' }).notNull(),
    input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    request_count: integer('request_count').notNull().default(0),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_subscription_quota_cycles_key').on(
      t.scope,
      t.scope_id,
      t.vendor,
      t.window_kind,
    ),
    index('idx_subscription_quota_cycles_window').on(t.window_started_at),
  ],
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
    // Lifecycle flags (0/1): `enabled` gates leasing, `is_default` pins the preferred key
    // for a (scope, scope_id, provider). Mirror of D1 migration 0058.
    enabled: integer('enabled').notNull().default(1),
    is_default: integer('is_default').notNull().default(0),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('idx_provider_api_keys_pool').on(t.scope, t.scope_id, t.provider, t.deleted_at)],
)

// Inbound public-API keys: the credentials external systems present to `/api/v1` (mirror of D1
// migration 0034). The secret is stored ONLY as a one-way peppered hash — never plaintext, never
// recoverable — the opposite of the provider keys above (which are decryptable for outbound use).
export const publicApiKeys = pgTable(
  'public_api_keys',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    workspace_id: text('workspace_id').notNull(),
    label: text('label').notNull(),
    // Permission on `/api/v1`: read ⊂ write ⊂ admin. Existing rows backfill to `write` (D1
    // migration 0053). Kept as text (matches D1) rather than a pg enum, so the two runtimes'
    // storage stays column-for-column identical.
    scope: text('scope').notNull().default('write'),
    secret_hash: text('secret_hash').notNull(),
    // The user who minted the key (audit + UI attribution); nullable — a dev-open mint has no
    // session, and pre-existing rows predate the column (D1 migration 0054). Not a FK: a key is
    // a workspace-scoped service credential that outlives its minter's access. Mirror of D1 0054.
    created_by_user_id: text('created_by_user_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    last_used_at: bigint('last_used_at', { mode: 'number' }),
    revoked_at: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => [index('idx_public_api_keys_workspace').on(t.workspace_id)],
)

// Individual-usage subscriptions (Claude): per-USER, never pooled (mirror of D1
// migration 0039). The credential is double-encrypted (password layer inside the
// system layer).
export const personalSubscriptions = pgTable(
  'personal_subscriptions',
  {
    id: text('id').primaryKey(),
    // ON DELETE RESTRICT: can't drop a user that still owns a personal subscription
    // (the orphaned `psub_X -> usr_OLD` row from the incident).
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
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

// Per-USER infra handler overrides (local mode): the per-user layer over a workspace's
// per-type environment handlers, keyed by (user_id, workspace_id, provision_type,
// manifest_id). `manifest_id` is '' for non-custom types so it sits in the composite PK
// cleanly. Mirror of D1 migration 0024; see docs/initiatives/per-service-provision-types.md.
export const environmentUserHandlers = pgTable(
  'environment_user_handlers',
  {
    user_id: text('user_id').notNull(),
    workspace_id: text('workspace_id').notNull(),
    provision_type: text('provision_type').notNull(),
    manifest_id: text('manifest_id').notNull().default(''),
    engine: text('engine').notNull(),
    provider_id: text('provider_id').notNull(),
    label: text('label').notNull(),
    base_url: text('base_url').notNull(),
    handler_json: text('handler_json').notNull(),
    accepts_manifest_id: text('accepts_manifest_id'),
    secrets_cipher: text('secrets_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.user_id, t.workspace_id, t.provision_type, t.manifest_id],
    }),
  ],
)

// Workspace-defined custom-manifest-type catalog entries (the UI-editable half of the
// custom provision-type catalog; the other half comes from registered providers). Keyed
// by (workspace_id, manifest_id). Mirror of D1 migration 0024.
export const customManifestTypes = pgTable(
  'custom_manifest_types',
  {
    workspace_id: text('workspace_id').notNull(),
    manifest_id: text('manifest_id').notNull(),
    label: text('label').notNull(),
    accepts_input_hint: text('accepts_input_hint'),
    description: text('description'),
    default_manifest_path: text('default_manifest_path'),
    fixer_prompt: text('fixer_prompt'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.manifest_id] })],
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
    // ON DELETE RESTRICT: a users row can't be removed while it still has a run activation.
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
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
    // Which VCS this connection talks to (github / gitlab). See contracts `GitHubConnection`
    // + kernel `GitHubInstallation.provider`.
    provider: text('provider').notNull().default('github'),
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
// The container executor resolves a run's target repo from the service frame the block
// sits under (via the account-owned `Service`, not any repo→block column).
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
    // Whether the repo is a monorepo hosting several services (link-owned — sync
    // preserves it). See contracts `GitHubRepo.isMonorepo`.
    is_monorepo: integer('is_monorepo').notNull().default(0),
    // How the repo entered the projection: 'app' (shared GitHub App installation, visible
    // to every member) or 'user_pat' (reachable only via the linker's personal token).
    // Link-owned — sync preserves it. See contracts `GitHubRepo.linkedVia`.
    linked_via: text('linked_via').notNull().default('app'),
    // Which VCS the repo belongs to (github / gitlab) — the connection's provider, inherited
    // by the repo. See contracts `GitHubRepo.provider`.
    provider: text('provider').notNull().default('github'),
    etag: text('etag'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.github_id] }),
    index('idx_gh_repos_install').on(t.installation_id),
  ],
)

// Per-user "repos my personal access token can reach" projection (mirror of D1). The
// fail-closed cache the board redaction checks so a frame backed by a `user_pat` repo is
// hidden from members who can't reach it, without a live GitHub call per snapshot. See the
// kernel `UserRepoAccessRepository` port.
export const githubUserRepoAccess = pgTable(
  'github_user_repo_access',
  {
    user_id: text('user_id').notNull(),
    repo_github_id: bigint('repo_github_id', { mode: 'number' }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    default_branch: text('default_branch'),
    private: integer('private').notNull().default(0),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.repo_github_id] }),
    index('idx_gh_user_repo_access_repo').on(t.repo_github_id),
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

// Binary-artifact METADATA (mirror of D1 migration 0017). The bytes live in a blob
// backend keyed by `storage_key` (R2 / S3 / the `binary_artifact_blobs` table below);
// this table holds only the queryable metadata, identical column-for-column to D1.
export const binaryArtifacts = pgTable(
  'binary_artifacts',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    execution_id: text('execution_id'),
    block_id: text('block_id'),
    kind: text('kind').notNull(),
    view: text('view'),
    content_type: text('content_type').notNull(),
    byte_size: integer('byte_size').notNull(),
    hash: text('hash').notNull(),
    storage: text('storage').notNull(),
    storage_key: text('storage_key').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_binary_artifacts_execution').on(t.workspace_id, t.execution_id),
    index('idx_binary_artifacts_block').on(t.workspace_id, t.block_id),
    // The per-workspace retention sweep filters on `created_at`; index it so the prune is an
    // indexed range delete (mirrors the D1 idx_binary_artifacts_created index).
    index('idx_binary_artifacts_created').on(t.workspace_id, t.created_at),
  ],
)

// Node-ONLY blob backend: when an account selects the `db` content-storage backend, the
// bytes live in this Postgres `bytea` table (keyed by the artifact's `storage_key`). There
// is no D1 equivalent — on Cloudflare blobs always go to R2 (D1 can't hold large values), so
// this store-in-DB backend genuinely cannot exist on the Worker runtime.
export const binaryArtifactBlobs = pgTable('binary_artifact_blobs', {
  storage_key: text('storage_key').primaryKey(),
  bytes: bytea('bytes').notNull(),
})
