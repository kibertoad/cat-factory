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
import {
  type SandboxExperimentRow,
  type SandboxFixtureRow,
  type SandboxGradeRow,
  type SandboxPromptVersionRow,
  type SandboxRunRow,
  rowToSandboxExperiment,
  rowToSandboxFixture,
  rowToSandboxGrade,
  rowToSandboxPromptVersion,
  rowToSandboxRun,
} from './mappers'

// D1 persistence for the Sandbox. These target a DEDICATED D1 database (the SANDBOX_DB
// binding, sandbox-migrations/), so the tables are unprefixed (`prompt_versions`,
// `fixtures`, `experiments`, `runs`, `grades`) — the database IS the namespace. The Node
// facade mirrors these over a Postgres `sandbox` schema (Drizzle); the cross-runtime
// conformance suite asserts they behave identically. JSON-shaped fields are TEXT JSON.
// The row -> domain mappers are shared with the Drizzle repos (`@cat-factory/server`);
// only the dialect-specific SQL write path lives here.

// ---- prompt versions --------------------------------------------------------

export class D1SandboxPromptVersionRepository implements SandboxPromptVersionRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxPromptVersion | null> {
    const row = await this.db
      .prepare(`SELECT * FROM prompt_versions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SandboxPromptVersionRow>()
    return row ? rowToSandboxPromptVersion(row) : null
  }

  async list(workspaceId: string): Promise<SandboxPromptVersion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM prompt_versions
           WHERE workspace_id = ? AND archived_at IS NULL
           ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<SandboxPromptVersionRow>()
    return results.map(rowToSandboxPromptVersion)
  }

  async listByKind(workspaceId: string, agentKind: string): Promise<SandboxPromptVersion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM prompt_versions
           WHERE workspace_id = ? AND agent_kind = ? AND archived_at IS NULL
           ORDER BY created_at DESC`,
      )
      .bind(workspaceId, agentKind)
      .all<SandboxPromptVersionRow>()
    return results.map(rowToSandboxPromptVersion)
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

export class D1SandboxFixtureRepository implements SandboxFixtureRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxFixture | null> {
    const row = await this.db
      .prepare(`SELECT * FROM fixtures WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SandboxFixtureRow>()
    return row ? rowToSandboxFixture(row) : null
  }

  async list(workspaceId: string): Promise<SandboxFixture[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM fixtures WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<SandboxFixtureRow>()
    return results.map(rowToSandboxFixture)
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

export class D1SandboxExperimentRepository implements SandboxExperimentRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxExperiment | null> {
    const row = await this.db
      .prepare(`SELECT * FROM experiments WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SandboxExperimentRow>()
    return row ? rowToSandboxExperiment(row) : null
  }

  async list(workspaceId: string): Promise<SandboxExperiment[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM experiments WHERE workspace_id = ? ORDER BY created_at DESC`)
      .bind(workspaceId)
      .all<SandboxExperimentRow>()
    return results.map(rowToSandboxExperiment)
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

  async claimForRun(workspaceId: string, id: string): Promise<boolean> {
    // Conditional update: only flips a non-running experiment to `running`. The affected-row
    // count tells the caller whether it won the claim (false ⇒ already running). Atomic, so
    // concurrent launches can't both clear + re-expand the grid (see the port doc).
    const result = await this.db
      .prepare(
        `UPDATE experiments SET status = 'running'
           WHERE workspace_id = ? AND id = ? AND status != 'running'`,
      )
      .bind(workspaceId, id)
      .run()
    return (result.meta?.changes ?? 0) > 0
  }
}

// ---- runs -------------------------------------------------------------------

export class D1SandboxRunRepository implements SandboxRunRepository {
  constructor(private readonly db: D1Database) {}

  async get(workspaceId: string, id: string): Promise<SandboxRun | null> {
    const row = await this.db
      .prepare(`SELECT * FROM runs WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SandboxRunRow>()
    return row ? rowToSandboxRun(row) : null
  }

  async listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM runs
           WHERE workspace_id = ? AND experiment_id = ?
           ORDER BY prompt_version_id, model, fixture_id, repeat_index`,
      )
      .bind(workspaceId, experimentId)
      .all<SandboxRunRow>()
    return results.map(rowToSandboxRun)
  }

  async listQueued(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM runs
           WHERE workspace_id = ? AND experiment_id = ? AND status = 'queued'
           ORDER BY started_at ASC, id ASC`,
      )
      .bind(workspaceId, experimentId)
      .all<SandboxRunRow>()
    return results.map(rowToSandboxRun)
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

export class D1SandboxGradeRepository implements SandboxGradeRepository {
  constructor(private readonly db: D1Database) {}

  async getByRun(workspaceId: string, runId: string): Promise<SandboxGrade | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM grades WHERE workspace_id = ? AND run_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, runId)
      .first<SandboxGradeRow>()
    return row ? rowToSandboxGrade(row) : null
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
      .all<SandboxGradeRow>()
    return results.map(rowToSandboxGrade)
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
