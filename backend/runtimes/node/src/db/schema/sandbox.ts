import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core'

// The SANDBOX surface's Drizzle tables, split out of `db/schema.ts` along the isolation boundary
// the architecture already draws: `@cat-factory/sandbox` is "deliberately isolated from the core
// product so it can be extracted" (CLAUDE.md), and its tables live in their own Postgres schema
// (the analogue of the Worker's separate `SANDBOX_DB` D1 database) rather than beside the core
// ones. Keeping them in a sibling module — re-exported from `db/schema.ts`, so every importer and
// drizzle-kit see exactly the same surface — makes that separation visible in the file layout too,
// and keeps the core schema module under its size budget.

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
