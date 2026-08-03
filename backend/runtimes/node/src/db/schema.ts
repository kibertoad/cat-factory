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
// The only FK targets in the schema live in `tables/identity.js`; the two per-user
// credential tables below reference `users.id`, so it is imported by name here (the rest
// of that module is re-exported further down).
import { users } from './tables/identity.js'

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
//
// The TENANCY & IDENTITY tables (the `workspaces` / `users` roots, login identities, the
// account + membership graph, invitations / password resets, and the per-account email and
// settings rows) live in `tables/identity.ts` — one cohesive group, extracted to keep this
// module inside its size budget — and are re-exported below. `users` is also imported by
// name at the top of this file, because the two per-user credential tables reference it.
export * from './tables/identity.js'
// The foundational-services catalog (backend/docs/adr/0031-foundational-services.md).
export * from './tables/foundational-services.js'

// The SETTINGS tables (the local-mode singleton, the per-user budget, the per-workspace
// runtime policy row + its custom metadata bag, and the per-agent-kind generation knob) live
// in `tables/settings.ts` — the same cohesive-group extraction, for the same size-budget
// reason — and are re-exported here.
export * from './tables/settings.js'

// The PROMPT-FRAGMENT LIBRARY tables (the tenant-scoped best-practice catalog, its generated
// condensed briefs, the repo directories it syncs from, and the per-workspace inherited
// selection) live in `tables/prompt-fragments.ts` — the same cohesive-group extraction, for
// the same size-budget reason — and are re-exported here.
export * from './tables/prompt-fragments.js'

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
    // ...and the headless clarification loop's question echo (mirror of D1 migration 0062).
    tracker_questions_on_park: text('tracker_questions_on_park'),
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
    // Sweeper re-drives of this run. Deliberately NOT rev-guarded (a monotonic counter about
    // the run, not derived from its state, so it can never fail a re-drive) and it survives the
    // restart/eviction the sweeper's in-memory orphan map does not. Mirrors D1 migration 0076.
    redrive_count: integer('redrive_count').notNull().default(0),
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
// Per-workspace agent system-prompt overrides (mirror of D1 migration 0068), edited from the
// pipeline builder. APPEND-ONLY: one row per revision, the HIGHEST `revision` is live, and
// restoring an older prompt appends a copy of it (tagged `restored_from`) rather than moving a
// pointer. `text` NULL is the deliberate way back to the shipped built-in — distinct from
// having no rows at all, so the log records the revert. The composite primary key is
// load-bearing: the next revision number comes from a read, so the collision is what keeps two
// concurrent editors from clobbering each other (surfaced as a 409). Never upsert into it.
export const agentPromptRevisions = pgTable(
  'agent_prompt_revisions',
  {
    workspace_id: text('workspace_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    revision: integer('revision').notNull(),
    text: text('text'),
    restored_from: integer('restored_from'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    created_by: text('created_by'),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.agent_kind, t.revision] }),
    // The workspace-wide override index reads every kind's head in one pass (mirrors
    // idx_agent_prompt_revisions_workspace). The D1 mirror declares `revision DESC`; this one is
    // ASC deliberately — Postgres scans a btree backwards at the same cost, so matching the
    // direction would buy nothing and cost a regenerated snapshot. Neither store's head read
    // depends on the declared direction.
    index('idx_agent_prompt_revisions_workspace').on(t.workspace_id, t.agent_kind, t.revision),
  ],
)

// Repo-sourced Claude Skills library (ADR 0024, slice 1; mirror of D1 migration 0052).
// An account links a repo directory of skill folders; the link is synced into the
// account's skill catalog. ONE tier (the account), a directory-per-skill sync unit,
// resources JSON-encoded in a `text` column.
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
    // WHICH slice of the run spent the call (`agent` / `validation-repair` / … ), stamped by
    // the harness that owns the phase boundary; '' is the unattributed slice, a real group in
    // the rollup rather than a dropped row. `turn_index` is the harness's job-scoped `seq`,
    // NULL where the producing channel has no turn concept (the proxy). Mirrors D1 migration
    // 0004_llm_call_phase_turn. See docs/initiatives/token-burn-instrumentation.md.
    phase: text('phase').notNull().default(''),
    turn_index: integer('turn_index'),
    message_count: integer('message_count').notNull().default(0),
    tool_count: integer('tool_count').notNull().default(0),
    request_max_tokens: integer('request_max_tokens'),
    prompt_tokens: integer('prompt_tokens').notNull().default(0),
    cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
    cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
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
    // Optimistic-concurrency token (mirror of the D1 column): every read-modify-write CASes on
    // it, so two writers editing different findings can't clobber each other.
    rev: integer('rev').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // UNIQUE (D1 migration 0066): a block holds at most ONE live review, and the constraint is
    // what enforces it — `replaceForBlock` is a conflict-targeted upsert on this key, so two
    // concurrent review runs can't interleave into two live reviews the way a transactioned
    // delete-then-insert could under READ COMMITTED. Also serves `getByBlock`'s lookup.
    uniqueIndex('idx_requirement_reviews_block').on(t.workspace_id, t.block_id),
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
    // The workspace consensus GROUP whose panel ran (the tier the task's estimate earned), when
    // the step named a tier set. The NAME is copied, not joined: the library row can be renamed
    // or deleted afterwards and the transcript must still say which panel produced it.
    group_id: text('group_id'),
    group_name: text('group_name'),
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

// The workspace CONSENSUS-GROUP library (mirror of D1 migration 0070): the reusable,
// estimate-gated panels a pipeline step escalates to. `participants` and `gating` are JSON
// columns — neither is ever a query predicate, since the tier selection runs in TypeScript over
// the batch `listByIds` returns. A step names a SET of these (inside the existing
// `pipelines.consensus` JSON) and the engine picks the most demanding tier the estimate clears.
export const consensusGroups = pgTable(
  'consensus_groups',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    strategy: text('strategy').notNull(),
    participants: text('participants').notNull().default('[]'),
    synthesizer_model_id: text('synthesizer_model_id'),
    rounds: integer('rounds'),
    gating: text('gating').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_consensus_groups_workspace').on(t.workspace_id, t.created_at),
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
    // Optimistic-concurrency token (mirror of the D1 column): every read-modify-write CASes on
    // it, so two writers editing different findings can't clobber each other.
    rev: integer('rev').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // UNIQUE (D1 migration 0066) — see `requirement_reviews`: the constraint, not a transaction,
    // is what keeps a block to one live review.
    uniqueIndex('idx_clarity_reviews_block').on(t.workspace_id, t.block_id),
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
    // Optimistic-concurrency token (mirror of the D1 column): every read-modify-write CASes on
    // it, so two writers editing different findings can't clobber each other.
    rev: integer('rev').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // UNIQUE (D1 migration 0066) — one live session per block AND STAGE, since a block
    // legitimately holds a `requirements` and an `architecture` session at the same time.
    uniqueIndex('idx_brainstorm_sessions_block_stage').on(t.workspace_id, t.block_id, t.stage),
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

// A workspace's outbound notification webhook (mirror of D1 migration 0061): ONE endpoint per
// workspace that receives the workspace's notifications as they are raised — the delivery channel
// a HEADLESS integration needs, chiefly so a public-API run that PARKS on a human decision reaches
// its caller by push. `secret_sealed` is the signing secret encrypted with the deployment
// SecretCipher (never read back over the API); `types` is a JSON array of notification types where
// EMPTY means "the defaults", not "everything".
export const notificationWebhooks = pgTable('notification_webhooks', {
  workspace_id: text('workspace_id').primaryKey(),
  url: text('url').notNull(),
  types: text('types').notNull().default('[]'),
  // The run-lifecycle subscription (D1 migration 0072). EMPTY means NONE, unlike `types` above:
  // an endpoint registered before run events existed must not start receiving a new family.
  run_events: text('run_events').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  secret_sealed: text('secret_sealed'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

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
    // Judge steps (the fourth step-taxonomy bucket): the minimum verdict score (0..1) a rubric
    // assessment must reach to advance without a human, and how many rework BOUNCE rounds a
    // judge may spend first. Mirrors D1's `judge_min_score` / `judge_max_bounces`.
    judge_min_score: doublePrecision('judge_min_score').notNull().default(0.7),
    judge_max_bounces: integer('judge_max_bounces').notNull().default(1),
    // When 0 the `merger` step never auto-merges — every PR is routed to human review.
    auto_merge_enabled: integer('auto_merge_enabled').notNull().default(1),
    // Estimate gating for the implementation-fork decision phase, a JSON `StepGating` blob
    // (mirror of D1's `fork_decision` TEXT column). NULL ⇒ off in `auto` mode.
    fork_decision: text('fork_decision'),
    // Per-change-class auto-merge rules, a JSON partial map from change class to
    // `thresholds` | `always` | `never` (mirror of D1's `class_rules` TEXT column). `{}` — the
    // default — means every class uses the score ceilings above, the historical behaviour.
    class_rules: text('class_rules').notNull().default('{}'),
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

// Merge TRACK RECORD — one row per merge decision: the run's deterministic change class, the
// merger's scores at the decision, what happened, and the reviewer-effort tag a human left
// (mirror of D1 migration 0061's `merge_track_records`). Per-class rollups over this table are
// SQL aggregates behind `DrizzleMergeTrackRecordRepository.rollupByClass`, never rows reduced in
// JS. Provider-neutral: repo identity is `repo_id` + `provider`, never a GitHub-shaped id.
export const mergeTrackRecords = pgTable(
  'merge_track_records',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    block_id: text('block_id').notNull(),
    // NULL for a record born from an externally-merged PR with no cat-factory run.
    execution_id: text('execution_id'),
    // docs | test | dependency | config | source | schema | unknown.
    change_class: text('change_class').notNull(),
    changed_file_count: integer('changed_file_count'),
    // The merger's 0..1 axes; NULL when it produced no parseable assessment (or never ran).
    complexity: doublePrecision('complexity'),
    risk: doublePrecision('risk'),
    impact: doublePrecision('impact'),
    risk_policy_id: text('risk_policy_id'),
    risk_policy_name: text('risk_policy_name'),
    // pending_review | auto_merged | human_merged | external_merged | rejected.
    decision: text('decision').notNull(),
    // none | minor | major. NULL until tagged — tagging is a nudge, never a gate.
    review_effort: text('review_effort'),
    pr_number: integer('pr_number'),
    pr_url: text('pr_url'),
    repo_id: text('repo_id'),
    provider: text('provider'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    resolved_at: bigint('resolved_at', { mode: 'number' }),
    tagged_at: bigint('tagged_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // The per-class rollup reads a whole workspace grouped by class.
    index('idx_merge_track_records_class').on(t.workspace_id, t.change_class),
    // Settling a decision / tagging effort resolves by run.
    index('idx_merge_track_records_execution').on(t.workspace_id, t.execution_id),
    // The block-scoped merge controls read the block's most recent record.
    index('idx_merge_track_records_block').on(t.workspace_id, t.block_id, t.created_at),
    // External-merge attribution looks a record up by the PR the webhook named.
    index('idx_merge_track_records_pr').on(t.workspace_id, t.repo_id, t.pr_number),
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
    // NULL ⇒ a repo-less stack: every compose layer is an inline document or a reference into
    // another repo, so there is nothing of its own to clone (migration 0070 ⇄ D1).
    clone_url: text('clone_url'),
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

// The sandbox surface's tables live in their own Postgres schema and their own module (see
// `schema/sandbox.ts`) — the architecture's existing "extractable sandbox" boundary. Re-exported
// here so `db/schema.ts` remains the ONE import surface for the Drizzle schema: every repository,
// the boot migrator and drizzle-kit's snapshot generation all read it from this module.
export * from './schema/sandbox.js'
export * from './schema/tracker.js'

// The opt-in integration tables (sealed connections + per-service-frame integration config)
// live in their own module; re-exported here so drizzle-kit still sees one schema graph and
// every existing `schema.js` import site is unchanged.
export * from './schema-integrations.js'

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

// The Slack integration's tables live in their own module (this file is at its size ratchet);
// re-exported here so drizzle-kit and every repository still read ONE schema module.
export { slackConnections, slackMemberMappings, slackSettings } from './schema-slack.js'

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
// The VCS/projection tables (installations, repos, per-user repo access, and the branch /
// pull-request / issue / commit / check-run / sync-cursor projections) live in
// `tables/vcs.ts` — one cohesive group, extracted to keep this module inside its size budget —
// and are re-exported below so every `from '../db/schema.js'` importer is unaffected.
export {
  githubInstallations,
  githubRepos,
  githubUserRepoAccess,
  githubBranches,
  githubPullRequests,
  githubIssues,
  githubCommits,
  githubCheckRuns,
  githubSyncCursors,
} from './tables/vcs.js'

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
