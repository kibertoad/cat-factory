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
import { and, desc, eq, sql } from 'drizzle-orm'
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
    rev: row.rev ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Requirements reviews over Postgres (the Drizzle mirror of the Worker's
 * `D1RequirementReviewRepository`, migration 0021). The reviewed items live as a JSON array in
 * `items`; a block holds at most ONE live review — a UNIQUE index on (workspace_id, block_id)
 * enforces that, and {@link DrizzleRequirementReviewRepository.replaceForBlock} publishes a fresh
 * one as a single upsert against it — so `getByBlock` returns it. Every read-modify-write rides
 * the rev-guarded
 * {@link compareAndSwap}. Behaviourally identical to the D1 repo, so the cross-runtime
 * conformance suite asserts the same substitution AND the same concurrency semantics against
 * both stores.
 */

/** Row values for an insert (a fresh row starts at rev 0; the writes below own the bump). */
function requirementReviewValues(workspaceId: string, review: RequirementReview) {
  return {
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
    rev: 0,
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  }
}

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

  /**
   * Force-write. A fresh insert starts at rev 0; a write over an existing row BUMPS it, so a
   * concurrent {@link compareAndSwap} holding the old revision still detects that the row moved.
   */
  async upsert(workspaceId: string, review: RequirementReview): Promise<void> {
    const values = requirementReviewValues(workspaceId, review)
    const rows = await this.db
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
          rev: sql`${requirementReviews.rev} + 1`,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: requirementReviews.rev })
    if (rows[0]) review.rev = rows[0].rev
  }

  async compareAndSwap(workspaceId: string, review: RequirementReview): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this review; writes only while the
    // stored row is unchanged, and never inserts (a deleted review must stay deleted).
    const values = requirementReviewValues(workspaceId, review)
    const rows = await this.db
      .update(requirementReviews)
      .set({
        block_id: values.block_id,
        status: values.status,
        items: values.items,
        model: values.model,
        incorporated_requirements: values.incorporated_requirements,
        iteration: values.iteration,
        max_iterations: values.max_iterations,
        recommendations: values.recommendations,
        rev: sql`${requirementReviews.rev} + 1`,
        updated_at: values.updated_at,
      })
      .where(
        and(
          eq(requirementReviews.workspace_id, workspaceId),
          eq(requirementReviews.id, review.id),
          eq(requirementReviews.rev, review.rev ?? 0),
        ),
      )
      .returning({ rev: requirementReviews.rev })
    if (!rows[0]) return false
    review.rev = rows[0].rev
    return true
  }

  /**
   * Publish `review` as the block's one live review, as a SINGLE conflict-targeted upsert on the
   * block's UNIQUE index.
   *
   * This deliberately is NOT a transactioned delete-then-insert. A transaction is not a
   * uniqueness constraint: at Postgres' default READ COMMITTED a DELETE takes no predicate lock,
   * so two concurrent review runs each delete nothing (or each other's already-gone row), each
   * insert, and both commit — leaving the block with TWO live reviews, which is the exact hazard
   * this method exists to prevent. (SQLite serializes writers, so D1 was accidentally safe; a
   * domain invariant must not rest on which runtime it happens to run under.) One statement
   * against the constraint has no window to interleave into on either runtime.
   *
   * The predecessor's row IS this row — its `id` is overwritten — so the superseded review is
   * gone rather than left beside the live one, and `rev` restarts at 0 so a writer still holding
   * the predecessor's revision can't match.
   */
  async replaceForBlock(workspaceId: string, review: RequirementReview): Promise<void> {
    const values = requirementReviewValues(workspaceId, review)
    const rows = await this.db
      .insert(requirementReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [requirementReviews.workspace_id, requirementReviews.block_id],
        set: {
          id: values.id,
          status: values.status,
          items: values.items,
          model: values.model,
          incorporated_requirements: values.incorporated_requirements,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          recommendations: values.recommendations,
          rev: 0,
          created_at: values.created_at,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: requirementReviews.rev })
    // Read the revision back rather than assuming it: the caller keeps mutating this object
    // through `compareAndSwap`, so a `rev` it only believes is right desynchronises it.
    review.rev = rows[0]?.rev ?? 0
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
    rev: row.rev ?? 0,
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

/** Row values for an insert (a fresh row starts at rev 0; the writes below own the bump). */
function clarityReviewValues(workspaceId: string, review: ClarityReview) {
  return {
    workspace_id: workspaceId,
    id: review.id,
    block_id: review.blockId,
    status: review.status,
    items: JSON.stringify(review.items),
    model: review.model,
    clarified_report: review.clarifiedReport,
    iteration: review.iteration ?? 1,
    max_iterations: review.maxIterations ?? 1,
    rev: 0,
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  }
}

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
    const values = clarityReviewValues(workspaceId, review)
    const rows = await this.db
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
          rev: sql`${clarityReviews.rev} + 1`,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: clarityReviews.rev })
    if (rows[0]) review.rev = rows[0].rev
  }

  async compareAndSwap(workspaceId: string, review: ClarityReview): Promise<boolean> {
    const values = clarityReviewValues(workspaceId, review)
    const rows = await this.db
      .update(clarityReviews)
      .set({
        block_id: values.block_id,
        status: values.status,
        items: values.items,
        model: values.model,
        clarified_report: values.clarified_report,
        iteration: values.iteration,
        max_iterations: values.max_iterations,
        rev: sql`${clarityReviews.rev} + 1`,
        updated_at: values.updated_at,
      })
      .where(
        and(
          eq(clarityReviews.workspace_id, workspaceId),
          eq(clarityReviews.id, review.id),
          eq(clarityReviews.rev, review.rev ?? 0),
        ),
      )
      .returning({ rev: clarityReviews.rev })
    if (!rows[0]) return false
    review.rev = rows[0].rev
    return true
  }

  /**
   * A single conflict-targeted upsert on the block's UNIQUE index — see
   * {@link DrizzleRequirementReviewRepository.replaceForBlock} for why a transactioned
   * delete-then-insert does not hold this invariant under READ COMMITTED.
   */
  async replaceForBlock(workspaceId: string, review: ClarityReview): Promise<void> {
    const values = clarityReviewValues(workspaceId, review)
    const rows = await this.db
      .insert(clarityReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [clarityReviews.workspace_id, clarityReviews.block_id],
        set: {
          id: values.id,
          status: values.status,
          items: values.items,
          model: values.model,
          clarified_report: values.clarified_report,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          rev: 0,
          created_at: values.created_at,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: clarityReviews.rev })
    review.rev = rows[0]?.rev ?? 0
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
    rev: row.rev ?? 0,
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

/** Row values for an insert (a fresh row starts at rev 0; the writes below own the bump). */
function brainstormSessionValues(workspaceId: string, session: BrainstormSession) {
  return {
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
    rev: 0,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  }
}

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
    const values = brainstormSessionValues(workspaceId, session)
    const rows = await this.db
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
          rev: sql`${brainstormSessions.rev} + 1`,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: brainstormSessions.rev })
    if (rows[0]) session.rev = rows[0].rev
  }

  async compareAndSwap(workspaceId: string, session: BrainstormSession): Promise<boolean> {
    const values = brainstormSessionValues(workspaceId, session)
    const rows = await this.db
      .update(brainstormSessions)
      .set({
        block_id: values.block_id,
        stage: values.stage,
        status: values.status,
        items: values.items,
        model: values.model,
        converged_direction: values.converged_direction,
        iteration: values.iteration,
        max_iterations: values.max_iterations,
        rev: sql`${brainstormSessions.rev} + 1`,
        updated_at: values.updated_at,
      })
      .where(
        and(
          eq(brainstormSessions.workspace_id, workspaceId),
          eq(brainstormSessions.id, session.id),
          eq(brainstormSessions.rev, session.rev ?? 0),
        ),
      )
      .returning({ rev: brainstormSessions.rev })
    if (!rows[0]) return false
    session.rev = rows[0].rev
    return true
  }

  /**
   * A single conflict-targeted upsert on the (block, STAGE) UNIQUE index — see
   * {@link DrizzleRequirementReviewRepository.replaceForBlock} for why a transactioned
   * delete-then-insert does not hold this invariant under READ COMMITTED. The stage is part of
   * the conflict target, so the block's other live stage is untouched by construction rather
   * than by a scoped delete.
   */
  async replaceForBlockStage(workspaceId: string, session: BrainstormSession): Promise<void> {
    const values = brainstormSessionValues(workspaceId, session)
    const rows = await this.db
      .insert(brainstormSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [
          brainstormSessions.workspace_id,
          brainstormSessions.block_id,
          brainstormSessions.stage,
        ],
        set: {
          id: values.id,
          status: values.status,
          items: values.items,
          model: values.model,
          converged_direction: values.converged_direction,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          rev: 0,
          created_at: values.created_at,
          updated_at: values.updated_at,
        },
      })
      .returning({ rev: brainstormSessions.rev })
    session.rev = rows[0]?.rev ?? 0
  }
}
