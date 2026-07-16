// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import { parseJsonArray } from './_shared.js'
import type {
  BrainstormItem,
  BrainstormSession,
  BrainstormSessionRepository,
  BrainstormStage,
  ClarityReview,
  ClarityReviewItem,
  ClarityReviewRepository,
  ConsensusSession,
  ConsensusSessionRepository,
  DocInterviewQa,
  DocInterviewRepository,
  DocInterviewSession,
  RequirementRecommendation,
  RequirementReview,
  RequirementReviewItem,
  RequirementReviewRepository,
} from '@cat-factory/kernel'
import { and, desc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  brainstormSessions,
  clarityReviews,
  consensusSessions,
  docInterviewSessions,
  requirementReviews,
} from '../../db/schema.js'

type RequirementReviewRow = typeof requirementReviews.$inferSelect

function rowToRequirementReview(row: RequirementReviewRow): RequirementReview {
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as RequirementReview['status'],
    items: parseJsonArray<RequirementReviewItem>(row.items),
    model: row.model,
    incorporatedRequirements: row.incorporated_requirements,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    recommendations: parseJsonArray<RequirementRecommendation>(row.recommendations ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Requirements reviews over Postgres (the Drizzle mirror of the Worker's
 * `D1RequirementReviewRepository`, migration 0021). The reviewed items live as a JSON
 * array in `items`; the service keeps at most one live review per block (it deletes
 * the block's prior review before inserting a fresh one), so `getByBlock` returns the
 * latest. Behaviourally identical to the D1 repo so the cross-runtime conformance
 * suite asserts the same requirements-rework substitution against both stores.
 */

export class DrizzleRequirementReviewRepository implements RequirementReviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null> {
    const rows = await this.db
      .select()
      .from(requirementReviews)
      .where(
        and(
          eq(requirementReviews.workspace_id, workspaceId),
          eq(requirementReviews.block_id, blockId),
        ),
      )
      .orderBy(desc(requirementReviews.created_at))
      .limit(1)
    return rows[0] ? rowToRequirementReview(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<RequirementReview | null> {
    const rows = await this.db
      .select()
      .from(requirementReviews)
      .where(and(eq(requirementReviews.workspace_id, workspaceId), eq(requirementReviews.id, id)))
      .limit(1)
    return rows[0] ? rowToRequirementReview(rows[0]) : null
  }

  async upsert(workspaceId: string, review: RequirementReview): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: review.id,
      block_id: review.blockId,
      status: review.status,
      items: JSON.stringify(review.items),
      model: review.model,
      incorporated_requirements: review.incorporatedRequirements,
      iteration: review.iteration ?? 1,
      max_iterations: review.maxIterations ?? 1,
      recommendations: JSON.stringify(review.recommendations ?? []),
      created_at: review.createdAt,
      updated_at: review.updatedAt,
    }
    await this.db
      .insert(requirementReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [requirementReviews.workspace_id, requirementReviews.id],
        set: {
          block_id: values.block_id,
          status: values.status,
          items: values.items,
          model: values.model,
          incorporated_requirements: values.incorporated_requirements,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          recommendations: values.recommendations,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(requirementReviews)
      .where(
        and(
          eq(requirementReviews.workspace_id, workspaceId),
          eq(requirementReviews.block_id, blockId),
        ),
      )
  }
}

type DocInterviewRow = typeof docInterviewSessions.$inferSelect

function rowToDocInterviewSession(row: DocInterviewRow): DocInterviewSession {
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as DocInterviewSession['status'],
    round: row.round,
    maxRounds: row.max_rounds,
    qa: parseJsonArray<DocInterviewQa>(row.qa),
    brief: row.brief,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Interactive document-interview sessions over Postgres (the Drizzle mirror of the Worker's
 * `D1DocInterviewRepository`, migration 0040). The Q&A live as a JSON array in `qa`; the service
 * keeps at most one live session per block, so `getByBlock` returns the latest. Behaviourally
 * identical to the D1 repo so the cross-runtime conformance suite asserts the same interview
 * brief substitution against both stores.
 */

export class DrizzleDocInterviewRepository implements DocInterviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<DocInterviewSession | null> {
    const rows = await this.db
      .select()
      .from(docInterviewSessions)
      .where(
        and(
          eq(docInterviewSessions.workspace_id, workspaceId),
          eq(docInterviewSessions.block_id, blockId),
        ),
      )
      .orderBy(desc(docInterviewSessions.created_at))
      .limit(1)
    return rows[0] ? rowToDocInterviewSession(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<DocInterviewSession | null> {
    const rows = await this.db
      .select()
      .from(docInterviewSessions)
      .where(
        and(eq(docInterviewSessions.workspace_id, workspaceId), eq(docInterviewSessions.id, id)),
      )
      .limit(1)
    return rows[0] ? rowToDocInterviewSession(rows[0]) : null
  }

  async upsert(workspaceId: string, session: DocInterviewSession): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: session.id,
      block_id: session.blockId,
      status: session.status,
      round: session.round,
      max_rounds: session.maxRounds,
      qa: JSON.stringify(session.qa ?? []),
      brief: session.brief,
      model: session.model,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }
    await this.db
      .insert(docInterviewSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [docInterviewSessions.workspace_id, docInterviewSessions.id],
        set: {
          block_id: values.block_id,
          status: values.status,
          round: values.round,
          max_rounds: values.max_rounds,
          qa: values.qa,
          brief: values.brief,
          model: values.model,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(docInterviewSessions)
      .where(
        and(
          eq(docInterviewSessions.workspace_id, workspaceId),
          eq(docInterviewSessions.block_id, blockId),
        ),
      )
  }
}

type ConsensusSessionRow = typeof consensusSessions.$inferSelect

function rowToConsensusSession(row: ConsensusSessionRow): ConsensusSession {
  return {
    id: row.id,
    blockId: row.block_id,
    executionId: row.execution_id,
    stepIndex: row.step_index,
    agentKind: row.agent_kind,
    strategy: row.strategy as ConsensusSession['strategy'],
    status: row.status as ConsensusSession['status'],
    participants: parseJsonArray(row.participants),
    rounds: parseJsonArray(row.rounds),
    synthesis: row.synthesis,
    confidence: row.confidence,
    dissent: parseJsonArray(row.dissent),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type ClarityReviewRow = typeof clarityReviews.$inferSelect

function rowToClarityReview(row: ClarityReviewRow): ClarityReview {
  let items: ClarityReviewItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as ClarityReviewItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as ClarityReview['status'],
    items,
    model: row.model,
    clarifiedReport: row.clarified_report,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Consensus session transcripts (`consensus_sessions`), the Drizzle/Postgres mirror of
 * {@link D1ConsensusSessionRepository}. One row per (execution, step); the
 * participants/rounds/dissent live as JSON columns, upserted as the process streams.
 */

export class DrizzleConsensusSessionRepository implements ConsensusSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(and(eq(consensusSessions.workspace_id, workspaceId), eq(consensusSessions.id, id)))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(
        and(
          eq(consensusSessions.workspace_id, workspaceId),
          eq(consensusSessions.execution_id, executionId),
          eq(consensusSessions.step_index, stepIndex),
        ),
      )
      .orderBy(desc(consensusSessions.created_at))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(
        and(
          eq(consensusSessions.workspace_id, workspaceId),
          eq(consensusSessions.block_id, blockId),
        ),
      )
      .orderBy(desc(consensusSessions.created_at))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async upsert(workspaceId: string, session: ConsensusSession): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: session.id,
      block_id: session.blockId,
      execution_id: session.executionId,
      step_index: session.stepIndex,
      agent_kind: session.agentKind,
      strategy: session.strategy,
      status: session.status,
      participants: JSON.stringify(session.participants),
      rounds: JSON.stringify(session.rounds),
      synthesis: session.synthesis,
      confidence: session.confidence ?? null,
      dissent: JSON.stringify(session.dissent ?? []),
      error: session.error ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }
    await this.db
      .insert(consensusSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [consensusSessions.workspace_id, consensusSessions.id],
        set: {
          block_id: values.block_id,
          execution_id: values.execution_id,
          step_index: values.step_index,
          agent_kind: values.agent_kind,
          strategy: values.strategy,
          status: values.status,
          participants: values.participants,
          rounds: values.rounds,
          synthesis: values.synthesis,
          confidence: values.confidence,
          dissent: values.dissent,
          error: values.error,
          updated_at: values.updated_at,
        },
      })
  }
}

/**
 * Clarity (bug-report triage) reviews over Postgres — the Drizzle mirror of the Worker's
 * `D1ClarityReviewRepository`. Behaviourally identical to the D1 repo so the cross-runtime
 * conformance suite asserts the same clarified-brief substitution against both stores.
 */

export class DrizzleClarityReviewRepository implements ClarityReviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<ClarityReview | null> {
    const rows = await this.db
      .select()
      .from(clarityReviews)
      .where(
        and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.block_id, blockId)),
      )
      .orderBy(desc(clarityReviews.created_at))
      .limit(1)
    return rows[0] ? rowToClarityReview(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<ClarityReview | null> {
    const rows = await this.db
      .select()
      .from(clarityReviews)
      .where(and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.id, id)))
      .limit(1)
    return rows[0] ? rowToClarityReview(rows[0]) : null
  }

  async upsert(workspaceId: string, review: ClarityReview): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: review.id,
      block_id: review.blockId,
      status: review.status,
      items: JSON.stringify(review.items),
      model: review.model,
      clarified_report: review.clarifiedReport,
      iteration: review.iteration ?? 1,
      max_iterations: review.maxIterations ?? 1,
      created_at: review.createdAt,
      updated_at: review.updatedAt,
    }
    await this.db
      .insert(clarityReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [clarityReviews.workspace_id, clarityReviews.id],
        set: {
          block_id: values.block_id,
          status: values.status,
          items: values.items,
          model: values.model,
          clarified_report: values.clarified_report,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(clarityReviews)
      .where(
        and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.block_id, blockId)),
      )
  }
}

type BrainstormSessionRow = typeof brainstormSessions.$inferSelect

function rowToBrainstormSession(row: BrainstormSessionRow): BrainstormSession {
  let items: BrainstormItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as BrainstormItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    stage: row.stage as BrainstormSession['stage'],
    status: row.status as BrainstormSession['status'],
    items,
    model: row.model,
    convergedDirection: row.converged_direction,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Brainstorm (structured-dialogue) sessions over Postgres — the Drizzle mirror of the Worker's
 * `D1BrainstormSessionRepository`. Behaviourally identical so the cross-runtime conformance
 * suite asserts the same per-stage round-trip and brainstorm direction handoff against both
 * stores. Keyed per (block, stage): a block may hold a live `requirements` AND `architecture`
 * session at once.
 */

export class DrizzleBrainstormSessionRepository implements BrainstormSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlockStage(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<BrainstormSession | null> {
    const rows = await this.db
      .select()
      .from(brainstormSessions)
      .where(
        and(
          eq(brainstormSessions.workspace_id, workspaceId),
          eq(brainstormSessions.block_id, blockId),
          eq(brainstormSessions.stage, stage),
        ),
      )
      .orderBy(desc(brainstormSessions.created_at))
      .limit(1)
    return rows[0] ? rowToBrainstormSession(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<BrainstormSession | null> {
    const rows = await this.db
      .select()
      .from(brainstormSessions)
      .where(and(eq(brainstormSessions.workspace_id, workspaceId), eq(brainstormSessions.id, id)))
      .limit(1)
    return rows[0] ? rowToBrainstormSession(rows[0]) : null
  }

  async upsert(workspaceId: string, session: BrainstormSession): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: session.id,
      block_id: session.blockId,
      stage: session.stage,
      status: session.status,
      items: JSON.stringify(session.items),
      model: session.model,
      converged_direction: session.convergedDirection,
      iteration: session.iteration ?? 1,
      max_iterations: session.maxIterations ?? 1,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }
    await this.db
      .insert(brainstormSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [brainstormSessions.workspace_id, brainstormSessions.id],
        set: {
          block_id: values.block_id,
          stage: values.stage,
          status: values.status,
          items: values.items,
          model: values.model,
          converged_direction: values.converged_direction,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlockStage(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<void> {
    await this.db
      .delete(brainstormSessions)
      .where(
        and(
          eq(brainstormSessions.workspace_id, workspaceId),
          eq(brainstormSessions.block_id, blockId),
          eq(brainstormSessions.stage, stage),
        ),
      )
  }
}
