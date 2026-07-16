// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

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
import type {
  SandboxExperimentRow,
  SandboxFixtureRow,
  SandboxGradeRow,
  SandboxPromptVersionRow,
  SandboxRunRow,
} from '@cat-factory/server'
import {
  rowToSandboxExperiment,
  rowToSandboxFixture,
  rowToSandboxGrade,
  rowToSandboxPromptVersion,
  rowToSandboxRun,
} from '@cat-factory/server'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  sandboxExperiments,
  sandboxFixtures,
  sandboxGrades,
  sandboxPromptVersions,
  sandboxRuns,
} from '../../db/schema.js'

export class DrizzleSandboxPromptVersionRepository implements SandboxPromptVersionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<SandboxPromptVersion | null> {
    const rows = await this.db
      .select()
      .from(sandboxPromptVersions)
      .where(
        and(eq(sandboxPromptVersions.workspace_id, workspaceId), eq(sandboxPromptVersions.id, id)),
      )
      .limit(1)
    return rows[0] ? rowToSandboxPromptVersion(rows[0] as SandboxPromptVersionRow) : null
  }

  async list(workspaceId: string): Promise<SandboxPromptVersion[]> {
    const rows = await this.db
      .select()
      .from(sandboxPromptVersions)
      .where(
        and(
          eq(sandboxPromptVersions.workspace_id, workspaceId),
          isNull(sandboxPromptVersions.archived_at),
        ),
      )
      .orderBy(desc(sandboxPromptVersions.created_at))
    return rows.map((r) => rowToSandboxPromptVersion(r as SandboxPromptVersionRow))
  }

  async listByKind(workspaceId: string, agentKind: string): Promise<SandboxPromptVersion[]> {
    const rows = await this.db
      .select()
      .from(sandboxPromptVersions)
      .where(
        and(
          eq(sandboxPromptVersions.workspace_id, workspaceId),
          eq(sandboxPromptVersions.agent_kind, agentKind),
          isNull(sandboxPromptVersions.archived_at),
        ),
      )
      .orderBy(desc(sandboxPromptVersions.created_at))
    return rows.map((r) => rowToSandboxPromptVersion(r as SandboxPromptVersionRow))
  }

  async upsert(workspaceId: string, version: SandboxPromptVersion): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: version.id,
      lineage_id: version.lineageId,
      agent_kind: version.agentKind,
      name: version.name,
      origin: version.origin,
      system_text: version.systemText,
      base_prompt_id: version.basePromptId,
      version: version.version,
      parent_id: version.parentId,
      labels: JSON.stringify(version.labels),
      created_at: version.createdAt,
      created_by: version.createdBy,
      archived_at: version.archivedAt,
    }
    await this.db
      .insert(sandboxPromptVersions)
      .values(values)
      .onConflictDoUpdate({
        target: [sandboxPromptVersions.workspace_id, sandboxPromptVersions.id],
        set: {
          lineage_id: values.lineage_id,
          agent_kind: values.agent_kind,
          name: values.name,
          origin: values.origin,
          system_text: values.system_text,
          base_prompt_id: values.base_prompt_id,
          version: values.version,
          parent_id: values.parent_id,
          labels: values.labels,
          created_by: values.created_by,
          archived_at: values.archived_at,
        },
      })
  }

  async archive(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(sandboxPromptVersions)
      .set({ archived_at: at })
      .where(
        and(eq(sandboxPromptVersions.workspace_id, workspaceId), eq(sandboxPromptVersions.id, id)),
      )
  }
}

export class DrizzleSandboxFixtureRepository implements SandboxFixtureRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<SandboxFixture | null> {
    const rows = await this.db
      .select()
      .from(sandboxFixtures)
      .where(and(eq(sandboxFixtures.workspace_id, workspaceId), eq(sandboxFixtures.id, id)))
      .limit(1)
    return rows[0] ? rowToSandboxFixture(rows[0] as SandboxFixtureRow) : null
  }

  async list(workspaceId: string): Promise<SandboxFixture[]> {
    const rows = await this.db
      .select()
      .from(sandboxFixtures)
      .where(eq(sandboxFixtures.workspace_id, workspaceId))
      .orderBy(sandboxFixtures.created_at)
    return rows.map((r) => rowToSandboxFixture(r as SandboxFixtureRow))
  }

  async upsert(workspaceId: string, fixture: SandboxFixture): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: fixture.id,
      kind: fixture.kind,
      name: fixture.name,
      payload: fixture.payload ? JSON.stringify(fixture.payload) : null,
      repo_ref: fixture.repoRef ? JSON.stringify(fixture.repoRef) : null,
      objective: fixture.objective ? JSON.stringify(fixture.objective) : null,
      origin: fixture.origin,
      created_at: fixture.createdAt,
    }
    await this.db
      .insert(sandboxFixtures)
      .values(values)
      .onConflictDoUpdate({
        target: [sandboxFixtures.workspace_id, sandboxFixtures.id],
        set: {
          kind: values.kind,
          name: values.name,
          payload: values.payload,
          repo_ref: values.repo_ref,
          objective: values.objective,
          origin: values.origin,
        },
      })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(sandboxFixtures)
      .where(and(eq(sandboxFixtures.workspace_id, workspaceId), eq(sandboxFixtures.id, id)))
  }
}

export class DrizzleSandboxExperimentRepository implements SandboxExperimentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<SandboxExperiment | null> {
    const rows = await this.db
      .select()
      .from(sandboxExperiments)
      .where(and(eq(sandboxExperiments.workspace_id, workspaceId), eq(sandboxExperiments.id, id)))
      .limit(1)
    return rows[0] ? rowToSandboxExperiment(rows[0] as SandboxExperimentRow) : null
  }

  async list(workspaceId: string): Promise<SandboxExperiment[]> {
    const rows = await this.db
      .select()
      .from(sandboxExperiments)
      .where(eq(sandboxExperiments.workspace_id, workspaceId))
      .orderBy(desc(sandboxExperiments.created_at))
    return rows.map((r) => rowToSandboxExperiment(r as SandboxExperimentRow))
  }

  async upsert(workspaceId: string, experiment: SandboxExperiment): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: experiment.id,
      name: experiment.name,
      agent_kind: experiment.agentKind,
      judge_model: experiment.judgeModel,
      repeats: experiment.repeats,
      status: experiment.status,
      matrix: JSON.stringify(experiment.matrix),
      budget_tokens: experiment.budgetTokens,
      created_at: experiment.createdAt,
      created_by: experiment.createdBy,
    }
    await this.db
      .insert(sandboxExperiments)
      .values(values)
      .onConflictDoUpdate({
        target: [sandboxExperiments.workspace_id, sandboxExperiments.id],
        set: {
          name: values.name,
          agent_kind: values.agent_kind,
          judge_model: values.judge_model,
          repeats: values.repeats,
          status: values.status,
          matrix: values.matrix,
          budget_tokens: values.budget_tokens,
          created_by: values.created_by,
        },
      })
  }

  async setStatus(workspaceId: string, id: string, status: SandboxExperimentStatus): Promise<void> {
    await this.db
      .update(sandboxExperiments)
      .set({ status })
      .where(and(eq(sandboxExperiments.workspace_id, workspaceId), eq(sandboxExperiments.id, id)))
  }

  async claimForRun(workspaceId: string, id: string): Promise<boolean> {
    // Conditional update: only flips a non-running experiment to `running`. `.returning()`
    // reports whether this caller won the claim (empty ⇒ already running). Atomic, so
    // concurrent launches can't both clear + re-expand the grid (see the port doc).
    const rows = await this.db
      .update(sandboxExperiments)
      .set({ status: 'running' })
      .where(
        and(
          eq(sandboxExperiments.workspace_id, workspaceId),
          eq(sandboxExperiments.id, id),
          ne(sandboxExperiments.status, 'running'),
        ),
      )
      .returning({ id: sandboxExperiments.id })
    return rows.length > 0
  }
}

export class DrizzleSandboxRunRepository implements SandboxRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<SandboxRun | null> {
    const rows = await this.db
      .select()
      .from(sandboxRuns)
      .where(and(eq(sandboxRuns.workspace_id, workspaceId), eq(sandboxRuns.id, id)))
      .limit(1)
    return rows[0] ? rowToSandboxRun(rows[0] as SandboxRunRow) : null
  }

  async listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const rows = await this.db
      .select()
      .from(sandboxRuns)
      .where(
        and(eq(sandboxRuns.workspace_id, workspaceId), eq(sandboxRuns.experiment_id, experimentId)),
      )
      .orderBy(
        sandboxRuns.prompt_version_id,
        sandboxRuns.model,
        sandboxRuns.fixture_id,
        sandboxRuns.repeat_index,
      )
    return rows.map((r) => rowToSandboxRun(r as SandboxRunRow))
  }

  async listQueued(workspaceId: string, experimentId: string): Promise<SandboxRun[]> {
    const rows = await this.db
      .select()
      .from(sandboxRuns)
      .where(
        and(
          eq(sandboxRuns.workspace_id, workspaceId),
          eq(sandboxRuns.experiment_id, experimentId),
          eq(sandboxRuns.status, 'queued'),
        ),
      )
      .orderBy(sandboxRuns.started_at, sandboxRuns.id)
    return rows.map((r) => rowToSandboxRun(r as SandboxRunRow))
  }

  async upsert(workspaceId: string, run: SandboxRun): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: run.id,
      experiment_id: run.experimentId,
      prompt_version_id: run.promptVersionId,
      model: run.model,
      fixture_id: run.fixtureId,
      repeat_index: run.repeatIndex,
      status: run.status,
      output_text: run.outputText,
      usage: run.usage ? JSON.stringify(run.usage) : null,
      latency_ms: run.latencyMs,
      branch: run.branch,
      pr_url: run.prUrl,
      diff: run.diff,
      error: run.error,
      seed_sha: run.seedSha,
      prompt_label: run.promptLabel,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    }
    await this.db
      .insert(sandboxRuns)
      .values(values)
      .onConflictDoUpdate({
        target: [sandboxRuns.workspace_id, sandboxRuns.id],
        set: {
          experiment_id: values.experiment_id,
          prompt_version_id: values.prompt_version_id,
          model: values.model,
          fixture_id: values.fixture_id,
          repeat_index: values.repeat_index,
          status: values.status,
          output_text: values.output_text,
          usage: values.usage,
          latency_ms: values.latency_ms,
          branch: values.branch,
          pr_url: values.pr_url,
          diff: values.diff,
          error: values.error,
          seed_sha: values.seed_sha,
          prompt_label: values.prompt_label,
          started_at: values.started_at,
          finished_at: values.finished_at,
        },
      })
  }

  async setStatus(workspaceId: string, id: string, status: SandboxRunStatus): Promise<void> {
    await this.db
      .update(sandboxRuns)
      .set({ status })
      .where(and(eq(sandboxRuns.workspace_id, workspaceId), eq(sandboxRuns.id, id)))
  }

  async removeByExperiment(workspaceId: string, experimentId: string): Promise<void> {
    await this.db
      .delete(sandboxRuns)
      .where(
        and(eq(sandboxRuns.workspace_id, workspaceId), eq(sandboxRuns.experiment_id, experimentId)),
      )
  }
}

export class DrizzleSandboxGradeRepository implements SandboxGradeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByRun(workspaceId: string, runId: string): Promise<SandboxGrade | null> {
    const rows = await this.db
      .select()
      .from(sandboxGrades)
      .where(and(eq(sandboxGrades.workspace_id, workspaceId), eq(sandboxGrades.run_id, runId)))
      .orderBy(desc(sandboxGrades.created_at))
      .limit(1)
    return rows[0] ? rowToSandboxGrade(rows[0] as SandboxGradeRow) : null
  }

  async listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxGrade[]> {
    const rows = await this.db
      .select({ grade: sandboxGrades })
      .from(sandboxGrades)
      .innerJoin(
        sandboxRuns,
        and(
          eq(sandboxRuns.workspace_id, sandboxGrades.workspace_id),
          eq(sandboxRuns.id, sandboxGrades.run_id),
        ),
      )
      .where(
        and(
          eq(sandboxGrades.workspace_id, workspaceId),
          eq(sandboxRuns.experiment_id, experimentId),
        ),
      )
      .orderBy(sandboxGrades.created_at)
    return rows.map((r) => rowToSandboxGrade(r.grade as SandboxGradeRow))
  }

  async upsert(workspaceId: string, grade: SandboxGrade): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: grade.id,
      run_id: grade.runId,
      judge_model: grade.judgeModel,
      scores: JSON.stringify(grade.scores),
      weighted_total: grade.weightedTotal,
      objective: grade.objective ? JSON.stringify(grade.objective) : null,
      created_at: grade.createdAt,
    }
    await this.db
      .insert(sandboxGrades)
      .values(values)
      .onConflictDoUpdate({
        target: [sandboxGrades.workspace_id, sandboxGrades.id],
        set: {
          run_id: values.run_id,
          judge_model: values.judge_model,
          scores: values.scores,
          weighted_total: values.weighted_total,
          objective: values.objective,
        },
      })
  }

  async removeByExperiment(workspaceId: string, experimentId: string): Promise<void> {
    // Grades carry no experiment_id; scope them through their run's experiment.
    const runIds = this.db
      .select({ id: sandboxRuns.id })
      .from(sandboxRuns)
      .where(
        and(eq(sandboxRuns.workspace_id, workspaceId), eq(sandboxRuns.experiment_id, experimentId)),
      )
    await this.db
      .delete(sandboxGrades)
      .where(
        and(eq(sandboxGrades.workspace_id, workspaceId), inArray(sandboxGrades.run_id, runIds)),
      )
  }
}

/**
 * The Sandbox's persistence as one spreadable mixin (the Drizzle analogue of the
 * Worker's `selectSandboxDeps`). The Node container spreads `...createDrizzleSandboxDeps(db)`
 * into its dependencies so the container body never enumerates the Sandbox repos — the
 * knowledge of which repos exist lives here, next to their implementations. Typed by the
 * kernel ports (not `CoreDependencies`) so this module stays free of the orchestration import.
 */

export function createDrizzleSandboxDeps(db: DrizzleDb): {
  sandboxPromptVersionRepository: SandboxPromptVersionRepository
  sandboxFixtureRepository: SandboxFixtureRepository
  sandboxExperimentRepository: SandboxExperimentRepository
  sandboxRunRepository: SandboxRunRepository
  sandboxGradeRepository: SandboxGradeRepository
} {
  return {
    sandboxPromptVersionRepository: new DrizzleSandboxPromptVersionRepository(db),
    sandboxFixtureRepository: new DrizzleSandboxFixtureRepository(db),
    sandboxExperimentRepository: new DrizzleSandboxExperimentRepository(db),
    sandboxRunRepository: new DrizzleSandboxRunRepository(db),
    sandboxGradeRepository: new DrizzleSandboxGradeRepository(db),
  }
}
