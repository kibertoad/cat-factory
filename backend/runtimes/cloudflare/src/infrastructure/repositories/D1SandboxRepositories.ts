import type {
  SandboxExperiment,
  SandboxExperimentRepository,
  SandboxExperimentStatus,
  SandboxFixture,
  SandboxFixtureRepository,
  SandboxGrade,
  SandboxGradeRepository,
  SandboxPromptVersion,
  SandboxPromptVersionRepository,
  SandboxRun,
  SandboxRunRepository,
  SandboxRunStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1 persistence for the Sandbox. These target a DEDICATED D1 database (the SANDBOX_DB
// binding, sandbox-migrations/), so the tables are unprefixed (`prompt_versions`,
// `fixtures`, `experiments`, `runs`, `grades`) — the database IS the namespace. The Node
// facade mirrors these over a Postgres `sandbox` schema (Drizzle); the cross-runtime
// conformance suite asserts they behave identically. JSON-shaped fields are TEXT JSON.

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---- prompt versions --------------------------------------------------------

interface PromptVersionRow {
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

function rowToPromptVersion(row: PromptVersionRow): SandboxPromptVersion {
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
    labels: parseJson<string[]>(row.labels, []),
    createdAt: row.created_at,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
  }
}

export class D1SandboxPromptVersionRepository implements SandboxPromptVersionRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxPromptVersion | null> {
    const row = await this.db
      .prepare(`SELECT * FROM prompt_versions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<PromptVersionRow>()
    return row ? rowToPromptVersion(row) : null
  }

  async list(workspaceId: string): Promise<SandboxPromptVersion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM prompt_versions
           WHERE workspace_id = ? AND archived_at IS NULL
           ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<PromptVersionRow>()
    return results.map(rowToPromptVersion)
  }

  async listByKind(workspaceId: string, agentKind: string): Promise<SandboxPromptVersion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM prompt_versions
           WHERE workspace_id = ? AND agent_kind = ? AND archived_at IS NULL
           ORDER BY created_at DESC`,
      )
      .bind(workspaceId, agentKind)
      .all<PromptVersionRow>()
    return results.map(rowToPromptVersion)
  }

  async upsert(workspaceId: string, version: SandboxPromptVersion): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO prompt_versions
           (workspace_id, id, lineage_id, agent_kind, name, origin, system_text, base_prompt_id,
            version, parent_id, labels, created_at, created_by, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           lineage_id = excluded.lineage_id,
           agent_kind = excluded.agent_kind,
           name = excluded.name,
           origin = excluded.origin,
           system_text = excluded.system_text,
           base_prompt_id = excluded.base_prompt_id,
           version = excluded.version,
           parent_id = excluded.parent_id,
           labels = excluded.labels,
           created_by = excluded.created_by,
           archived_at = excluded.archived_at`,
      )
      .bind(
        workspaceId,
        version.id,
        version.lineageId,
        version.agentKind,
        version.name,
        version.origin,
        version.systemText,
        version.basePromptId,
        version.version,
        version.parentId,
        JSON.stringify(version.labels),
        version.createdAt,
        version.createdBy,
        version.archivedAt,
      )
      .run()
  }

  async archive(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(`UPDATE prompt_versions SET archived_at = ? WHERE workspace_id = ? AND id = ?`)
      .bind(at, workspaceId, id)
      .run()
  }
}

// ---- fixtures ---------------------------------------------------------------

interface FixtureRow {
  id: string
  kind: string
  name: string
  payload: string | null
  repo_ref: string | null
  objective: string | null
  origin: string
  created_at: number
}

function rowToFixture(row: FixtureRow): SandboxFixture {
  return {
    id: row.id,
    kind: row.kind as SandboxFixture['kind'],
    name: row.name,
    payload: parseJson<Record<string, unknown> | null>(row.payload, null),
    repoRef: parseJson<SandboxFixture['repoRef']>(row.repo_ref, null),
    objective: parseJson<SandboxFixture['objective']>(row.objective, null),
    origin: row.origin as SandboxFixture['origin'],
    createdAt: row.created_at,
  } as SandboxFixture
}

export class D1SandboxFixtureRepository implements SandboxFixtureRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxFixture | null> {
    const row = await this.db
      .prepare(`SELECT * FROM fixtures WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<FixtureRow>()
    return row ? rowToFixture(row) : null
  }

  async list(workspaceId: string): Promise<SandboxFixture[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM fixtures WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<FixtureRow>()
    return results.map(rowToFixture)
  }

  async upsert(workspaceId: string, fixture: SandboxFixture): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fixtures
           (workspace_id, id, kind, name, payload, repo_ref, objective, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           payload = excluded.payload,
           repo_ref = excluded.repo_ref,
           objective = excluded.objective,
           origin = excluded.origin`,
      )
      .bind(
        workspaceId,
        fixture.id,
        fixture.kind,
        fixture.name,
        fixture.payload ? JSON.stringify(fixture.payload) : null,
        fixture.repoRef ? JSON.stringify(fixture.repoRef) : null,
        fixture.objective ? JSON.stringify(fixture.objective) : null,
        fixture.origin,
        fixture.createdAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM fixtures WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }
}

// ---- experiments ------------------------------------------------------------

interface ExperimentRow {
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

function rowToExperiment(row: ExperimentRow): SandboxExperiment {
  return {
    id: row.id,
    name: row.name,
    agentKind: row.agent_kind,
    judgeModel: row.judge_model,
    repeats: row.repeats,
    status: row.status as SandboxExperimentStatus,
    matrix: parseJson<SandboxExperiment['matrix']>(row.matrix, {
      promptVersionIds: [],
      models: [],
      fixtureIds: [],
    }),
    budgetTokens: row.budget_tokens,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

export class D1SandboxExperimentRepository implements SandboxExperimentRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxExperiment | null> {
    const row = await this.db
      .prepare(`SELECT * FROM experiments WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ExperimentRow>()
    return row ? rowToExperiment(row) : null
  }

  async list(workspaceId: string): Promise<SandboxExperiment[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM experiments WHERE workspace_id = ? ORDER BY created_at DESC`)
      .bind(workspaceId)
      .all<ExperimentRow>()
    return results.map(rowToExperiment)
  }

  async upsert(workspaceId: string, experiment: SandboxExperiment): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO experiments
           (workspace_id, id, name, agent_kind, judge_model, repeats, status, matrix,
            budget_tokens, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
           agent_kind = excluded.agent_kind,
           judge_model = excluded.judge_model,
           repeats = excluded.repeats,
           status = excluded.status,
           matrix = excluded.matrix,
           budget_tokens = excluded.budget_tokens,
           created_by = excluded.created_by`,
      )
      .bind(
        workspaceId,
        experiment.id,
        experiment.name,
        experiment.agentKind,
        experiment.judgeModel,
        experiment.repeats,
        experiment.status,
        JSON.stringify(experiment.matrix),
        experiment.budgetTokens,
        experiment.createdAt,
        experiment.createdBy,
      )
      .run()
  }

  async setStatus(workspaceId: string, id: string, status: SandboxExperimentStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE experiments SET status = ? WHERE workspace_id = ? AND id = ?`)
      .bind(status, workspaceId, id)
      .run()
  }
}

// ---- runs -------------------------------------------------------------------

interface RunRow {
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

function rowToRun(row: RunRow): SandboxRun {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    promptVersionId: row.prompt_version_id,
    model: row.model,
    fixtureId: row.fixture_id,
    repeatIndex: row.repeat_index,
    status: row.status as SandboxRunStatus,
    outputText: row.output_text,
    usage: parseJson<SandboxRun['usage']>(row.usage, null),
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

export class D1SandboxRunRepository implements SandboxRunRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM runs WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<RunRow>()
    return row ? rowToRun(row) : null
  }

  async listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM runs
           WHERE workspace_id = ? AND experiment_id = ?
           ORDER BY prompt_version_id, model, fixture_id, repeat_index`,
      )
      .bind(workspaceId, experimentId)
      .all<RunRow>()
    return results.map(rowToRun)
  }

  async listQueued(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM runs
           WHERE workspace_id = ? AND experiment_id = ? AND status = 'queued'
           ORDER BY started_at ASC, id ASC`,
      )
      .bind(workspaceId, experimentId)
      .all<RunRow>()
    return results.map(rowToRun)
  }

  async upsert(workspaceId: string, run: SandboxRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runs
           (workspace_id, id, experiment_id, prompt_version_id, model, fixture_id, repeat_index,
            status, output_text, usage, latency_ms, branch, pr_url, diff, error, seed_sha,
            prompt_label, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           experiment_id = excluded.experiment_id,
           prompt_version_id = excluded.prompt_version_id,
           model = excluded.model,
           fixture_id = excluded.fixture_id,
           repeat_index = excluded.repeat_index,
           status = excluded.status,
           output_text = excluded.output_text,
           usage = excluded.usage,
           latency_ms = excluded.latency_ms,
           branch = excluded.branch,
           pr_url = excluded.pr_url,
           diff = excluded.diff,
           error = excluded.error,
           seed_sha = excluded.seed_sha,
           prompt_label = excluded.prompt_label,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
      )
      .bind(
        workspaceId,
        run.id,
        run.experimentId,
        run.promptVersionId,
        run.model,
        run.fixtureId,
        run.repeatIndex,
        run.status,
        run.outputText,
        run.usage ? JSON.stringify(run.usage) : null,
        run.latencyMs,
        run.branch,
        run.prUrl,
        run.diff,
        run.error,
        run.seedSha,
        run.promptLabel,
        run.startedAt,
        run.finishedAt,
      )
      .run()
  }

  async setStatus(workspaceId: string, id: string, status: SandboxRunStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE runs SET status = ? WHERE workspace_id = ? AND id = ?`)
      .bind(status, workspaceId, id)
      .run()
  }

  async removeByExperiment(workspaceId: string, experimentId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM runs WHERE workspace_id = ? AND experiment_id = ?`)
      .bind(workspaceId, experimentId)
      .run()
  }
}

// ---- grades -----------------------------------------------------------------

interface GradeRow {
  id: string
  run_id: string
  judge_model: string
  scores: string
  weighted_total: number
  objective: string | null
  created_at: number
}

function rowToGrade(row: GradeRow): SandboxGrade {
  return {
    id: row.id,
    runId: row.run_id,
    judgeModel: row.judge_model,
    scores: parseJson<SandboxGrade['scores']>(row.scores, []),
    weightedTotal: row.weighted_total,
    objective: parseJson<SandboxGrade['objective']>(row.objective, null),
    createdAt: row.created_at,
  }
}

export class D1SandboxGradeRepository implements SandboxGradeRepository {
  constructor(private readonly db: D1Database) {}

  async getByRun(workspaceId: string, runId: string): Promise<SandboxGrade | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM grades WHERE workspace_id = ? AND run_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, runId)
      .first<GradeRow>()
    return row ? rowToGrade(row) : null
  }

  async listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxGrade[]> {
    const { results } = await this.db
      .prepare(
        `SELECT g.* FROM grades g
           JOIN runs r ON r.workspace_id = g.workspace_id AND r.id = g.run_id
           WHERE g.workspace_id = ? AND r.experiment_id = ?
           ORDER BY g.created_at ASC`,
      )
      .bind(workspaceId, experimentId)
      .all<GradeRow>()
    return results.map(rowToGrade)
  }

  async upsert(workspaceId: string, grade: SandboxGrade): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO grades
           (workspace_id, id, run_id, judge_model, scores, weighted_total, objective, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           run_id = excluded.run_id,
           judge_model = excluded.judge_model,
           scores = excluded.scores,
           weighted_total = excluded.weighted_total,
           objective = excluded.objective`,
      )
      .bind(
        workspaceId,
        grade.id,
        grade.runId,
        grade.judgeModel,
        JSON.stringify(grade.scores),
        grade.weightedTotal,
        grade.objective ? JSON.stringify(grade.objective) : null,
        grade.createdAt,
      )
      .run()
  }

  async removeByExperiment(workspaceId: string, experimentId: string): Promise<void> {
    // Grades carry no experiment_id; scope them through their run. Callers clear grades
    // BEFORE runs so this subquery still resolves the experiment's cells.
    await this.db
      .prepare(
        `DELETE FROM grades
           WHERE workspace_id = ?
             AND run_id IN (SELECT id FROM runs WHERE workspace_id = ? AND experiment_id = ?)`,
      )
      .bind(workspaceId, workspaceId, experimentId)
      .run()
  }
}
