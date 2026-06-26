import type {
  SandboxExperiment,
  SandboxExperimentStatus,
  SandboxFixture,
  SandboxGrade,
  SandboxPromptVersion,
  SandboxRun,
  SandboxRunStatus,
} from '@cat-factory/contracts'

// Row -> domain mapping for the Sandbox tables, shared by BOTH persistence facades:
// the Cloudflare D1 repos (dedicated SANDBOX_DB) and the Node Drizzle repos (Postgres
// `sandbox` schema). The column names are identical across the two dialects, so the
// read path lives here once — a new field is mapped in a single place instead of being
// mirrored per runtime. JSON-shaped columns are stored as TEXT JSON and parsed here.
// The write path (positional D1 SQL vs the Drizzle builder) legitimately differs and
// stays in each repo. See backend/CLAUDE.md "Keep the runtimes symmetric".

export function parseSandboxJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---- prompt versions --------------------------------------------------------

export interface SandboxPromptVersionRow {
  id: string
  lineage_id: string
  agent_kind: string
  name: string
  origin: string
  system_text: string
  base_prompt_id: string | null
  version: number
  parent_id: string | null
  labels: string
  created_at: number
  created_by: string | null
  archived_at: number | null
}

export function rowToSandboxPromptVersion(row: SandboxPromptVersionRow): SandboxPromptVersion {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    agentKind: row.agent_kind,
    name: row.name,
    origin: row.origin as SandboxPromptVersion['origin'],
    systemText: row.system_text,
    basePromptId: row.base_prompt_id,
    version: row.version,
    parentId: row.parent_id,
    labels: parseSandboxJson<string[]>(row.labels, []),
    createdAt: row.created_at,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
  }
}

// ---- fixtures ---------------------------------------------------------------

export interface SandboxFixtureRow {
  id: string
  kind: string
  name: string
  payload: string | null
  repo_ref: string | null
  objective: string | null
  origin: string
  created_at: number
}

export function rowToSandboxFixture(row: SandboxFixtureRow): SandboxFixture {
  return {
    id: row.id,
    kind: row.kind as SandboxFixture['kind'],
    name: row.name,
    payload: parseSandboxJson<Record<string, unknown> | null>(row.payload, null),
    repoRef: parseSandboxJson<SandboxFixture['repoRef']>(row.repo_ref, null),
    objective: parseSandboxJson<SandboxFixture['objective']>(row.objective, null),
    origin: row.origin as SandboxFixture['origin'],
    createdAt: row.created_at,
  } as SandboxFixture
}

// ---- experiments ------------------------------------------------------------

export interface SandboxExperimentRow {
  id: string
  name: string
  agent_kind: string
  judge_model: string
  repeats: number
  status: string
  matrix: string
  budget_tokens: number | null
  created_at: number
  created_by: string | null
}

export function rowToSandboxExperiment(row: SandboxExperimentRow): SandboxExperiment {
  return {
    id: row.id,
    name: row.name,
    agentKind: row.agent_kind,
    judgeModel: row.judge_model,
    repeats: row.repeats,
    status: row.status as SandboxExperimentStatus,
    matrix: parseSandboxJson<SandboxExperiment['matrix']>(row.matrix, {
      promptVersionIds: [],
      models: [],
      fixtureIds: [],
    }),
    budgetTokens: row.budget_tokens,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

// ---- runs -------------------------------------------------------------------

export interface SandboxRunRow {
  id: string
  experiment_id: string
  prompt_version_id: string
  model: string
  fixture_id: string
  repeat_index: number
  status: string
  output_text: string | null
  usage: string | null
  latency_ms: number | null
  branch: string | null
  pr_url: string | null
  diff: string | null
  error: string | null
  seed_sha: string | null
  prompt_label: string
  started_at: number | null
  finished_at: number | null
}

export function rowToSandboxRun(row: SandboxRunRow): SandboxRun {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    promptVersionId: row.prompt_version_id,
    model: row.model,
    fixtureId: row.fixture_id,
    repeatIndex: row.repeat_index,
    status: row.status as SandboxRunStatus,
    outputText: row.output_text,
    usage: parseSandboxJson<SandboxRun['usage']>(row.usage, null),
    latencyMs: row.latency_ms,
    branch: row.branch,
    prUrl: row.pr_url,
    diff: row.diff,
    error: row.error,
    seedSha: row.seed_sha,
    promptLabel: row.prompt_label,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

// ---- grades -----------------------------------------------------------------

export interface SandboxGradeRow {
  id: string
  run_id: string
  judge_model: string
  scores: string
  weighted_total: number
  objective: string | null
  created_at: number
}

export function rowToSandboxGrade(row: SandboxGradeRow): SandboxGrade {
  return {
    id: row.id,
    runId: row.run_id,
    judgeModel: row.judge_model,
    scores: parseSandboxJson<SandboxGrade['scores']>(row.scores, []),
    weightedTotal: row.weighted_total,
    objective: parseSandboxJson<SandboxGrade['objective']>(row.objective, null),
    createdAt: row.created_at,
  }
}
