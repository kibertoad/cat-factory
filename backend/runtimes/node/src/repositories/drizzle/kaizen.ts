// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import { parseJsonArray } from './_shared.js'
import type {
  KaizenGrading,
  KaizenGradingRepository,
  KaizenGradingStatus,
  KaizenVerifiedCombo,
  KaizenVerifiedComboRepository,
} from '@cat-factory/kernel'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { kaizenGradings, kaizenVerifiedCombos } from '../../db/schema.js'

type KaizenGradingRow = typeof kaizenGradings.$inferSelect

function rowToKaizenGrading(row: KaizenGradingRow): KaizenGrading {
  return {
    id: row.id,
    executionId: row.execution_id,
    blockId: row.block_id,
    stepIndex: row.step_index,
    agentKind: row.agent_kind,
    model: row.model,
    promptVersion: row.prompt_version,
    comboKey: row.combo_key,
    status: row.status as KaizenGradingStatus,
    grade: row.grade,
    summary: row.summary,
    recommendations: parseJsonArray<string>(row.recommendations ?? '[]'),
    graderModel: row.grader_model,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Kaizen gradings over Postgres (the Drizzle mirror of the Worker's
 * `D1KaizenGradingRepository`, migration 0015). One row per (run, step); recommendations
 * are a JSON array. The unique (execution_id, step_index) index keeps scheduling
 * idempotent across durable re-drives.
 */

export class DrizzleKaizenGradingRepository implements KaizenGradingRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(workspaceId: string, grading: KaizenGrading): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: grading.id,
      execution_id: grading.executionId,
      block_id: grading.blockId,
      step_index: grading.stepIndex,
      agent_kind: grading.agentKind,
      model: grading.model,
      prompt_version: grading.promptVersion,
      combo_key: grading.comboKey,
      status: grading.status,
      grade: grading.grade,
      summary: grading.summary,
      recommendations: JSON.stringify(grading.recommendations),
      grader_model: grading.graderModel,
      error: grading.error,
      created_at: grading.createdAt,
      updated_at: grading.updatedAt,
    }
    await this.db
      .insert(kaizenGradings)
      .values(values)
      .onConflictDoUpdate({
        target: [kaizenGradings.workspace_id, kaizenGradings.id],
        set: {
          status: values.status,
          grade: values.grade,
          summary: values.summary,
          recommendations: values.recommendations,
          grader_model: values.grader_model,
          error: values.error,
          updated_at: values.updated_at,
        },
      })
  }

  async get(workspaceId: string, id: string): Promise<KaizenGrading | null> {
    const rows = await this.db
      .select()
      .from(kaizenGradings)
      .where(and(eq(kaizenGradings.workspace_id, workspaceId), eq(kaizenGradings.id, id)))
      .limit(1)
    return rows[0] ? rowToKaizenGrading(rows[0]) : null
  }

  async getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<KaizenGrading | null> {
    const rows = await this.db
      .select()
      .from(kaizenGradings)
      .where(
        and(
          eq(kaizenGradings.workspace_id, workspaceId),
          eq(kaizenGradings.execution_id, executionId),
          eq(kaizenGradings.step_index, stepIndex),
        ),
      )
      .limit(1)
    return rows[0] ? rowToKaizenGrading(rows[0]) : null
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<KaizenGrading[]> {
    const rows = await this.db
      .select()
      .from(kaizenGradings)
      .where(
        and(
          eq(kaizenGradings.workspace_id, workspaceId),
          eq(kaizenGradings.execution_id, executionId),
        ),
      )
      .orderBy(kaizenGradings.step_index)
    return rows.map(rowToKaizenGrading)
  }

  async listByWorkspace(workspaceId: string, limit = 200): Promise<KaizenGrading[]> {
    const rows = await this.db
      .select()
      .from(kaizenGradings)
      .where(eq(kaizenGradings.workspace_id, workspaceId))
      .orderBy(desc(kaizenGradings.created_at))
      .limit(limit)
    return rows.map(rowToKaizenGrading)
  }

  async listPending(
    staleBefore: number,
    limit: number,
  ): Promise<{ workspaceId: string; grading: KaizenGrading }[]> {
    const rows = await this.db
      .select()
      .from(kaizenGradings)
      .where(
        or(
          eq(kaizenGradings.status, 'scheduled'),
          and(eq(kaizenGradings.status, 'running'), lt(kaizenGradings.updated_at, staleBefore)),
        ),
      )
      .orderBy(kaizenGradings.updated_at)
      .limit(limit)
    return rows.map((row) => ({ workspaceId: row.workspace_id, grading: rowToKaizenGrading(row) }))
  }

  async claim(workspaceId: string, id: string, staleBefore: number, now: number): Promise<boolean> {
    // Conditional flip to `running`: succeeds only if the row is still claimable (the same
    // predicate listPending selects on), so concurrent sweep passes can't both win it.
    const claimed = await this.db
      .update(kaizenGradings)
      .set({ status: 'running', updated_at: now })
      .where(
        and(
          eq(kaizenGradings.workspace_id, workspaceId),
          eq(kaizenGradings.id, id),
          or(
            eq(kaizenGradings.status, 'scheduled'),
            and(eq(kaizenGradings.status, 'running'), lt(kaizenGradings.updated_at, staleBefore)),
          ),
        ),
      )
      .returning({ id: kaizenGradings.id })
    return claimed.length > 0
  }
}

type KaizenVerifiedComboRow = typeof kaizenVerifiedCombos.$inferSelect

function rowToKaizenVerifiedCombo(row: KaizenVerifiedComboRow): KaizenVerifiedCombo {
  return {
    comboKey: row.combo_key,
    agentKind: row.agent_kind,
    model: row.model,
    promptVersion: row.prompt_version,
    consecutiveHighGrades: row.consecutive_high_grades,
    verified: row.verified === 1,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Kaizen verified-combo progress over Postgres (the Drizzle mirror of the Worker's
 * `D1KaizenVerifiedComboRepository`, migration 0015).
 */

export class DrizzleKaizenVerifiedComboRepository implements KaizenVerifiedComboRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByKey(workspaceId: string, comboKey: string): Promise<KaizenVerifiedCombo | null> {
    const rows = await this.db
      .select()
      .from(kaizenVerifiedCombos)
      .where(
        and(
          eq(kaizenVerifiedCombos.workspace_id, workspaceId),
          eq(kaizenVerifiedCombos.combo_key, comboKey),
        ),
      )
      .limit(1)
    return rows[0] ? rowToKaizenVerifiedCombo(rows[0]) : null
  }

  async upsert(workspaceId: string, combo: KaizenVerifiedCombo): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      combo_key: combo.comboKey,
      agent_kind: combo.agentKind,
      model: combo.model,
      prompt_version: combo.promptVersion,
      consecutive_high_grades: combo.consecutiveHighGrades,
      verified: combo.verified ? 1 : 0,
      verified_at: combo.verifiedAt,
      updated_at: combo.updatedAt,
    }
    await this.db
      .insert(kaizenVerifiedCombos)
      .values(values)
      .onConflictDoUpdate({
        target: [kaizenVerifiedCombos.workspace_id, kaizenVerifiedCombos.combo_key],
        set: {
          consecutive_high_grades: values.consecutive_high_grades,
          verified: values.verified,
          verified_at: values.verified_at,
          updated_at: values.updated_at,
        },
      })
  }

  async listByWorkspace(workspaceId: string): Promise<KaizenVerifiedCombo[]> {
    const rows = await this.db
      .select()
      .from(kaizenVerifiedCombos)
      .where(eq(kaizenVerifiedCombos.workspace_id, workspaceId))
      .orderBy(desc(kaizenVerifiedCombos.updated_at))
    return rows.map(rowToKaizenVerifiedCombo)
  }
}
