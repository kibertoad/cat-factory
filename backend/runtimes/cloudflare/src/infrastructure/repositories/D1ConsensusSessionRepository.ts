import type { ConsensusSessionRepository } from '@cat-factory/kernel'
import type { ConsensusParticipant, ConsensusRound, ConsensusSession } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface ConsensusSessionRow {
  id: string
  block_id: string
  execution_id: string | null
  step_index: number
  agent_kind: string
  strategy: string
  status: string
  participants: string
  rounds: string
  synthesis: string | null
  confidence: number | null
  dissent: string
  error: string | null
  created_at: number
  updated_at: number
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToSession(row: ConsensusSessionRow): ConsensusSession {
  return {
    id: row.id,
    blockId: row.block_id,
    executionId: row.execution_id,
    stepIndex: row.step_index,
    agentKind: row.agent_kind,
    strategy: row.strategy as ConsensusSession['strategy'],
    status: row.status as ConsensusSession['status'],
    participants: parseJsonArray<ConsensusParticipant>(row.participants),
    rounds: parseJsonArray<ConsensusRound>(row.rounds),
    synthesis: row.synthesis,
    confidence: row.confidence,
    dissent: parseJsonArray<string>(row.dissent),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Consensus session transcripts in `consensus_sessions` (migration 0002), one row
 * per (execution, step). The participants/rounds/dissent live as JSON columns; the
 * session is upserted repeatedly as the multi-model process streams progress.
 */
export class D1ConsensusSessionRepository implements ConsensusSessionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<ConsensusSession | null> {
    const row = await this.db
      .prepare(`SELECT * FROM consensus_sessions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ConsensusSessionRow>()
    return row ? rowToSession(row) : null
  }

  async getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<ConsensusSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM consensus_sessions
           WHERE workspace_id = ? AND execution_id = ? AND step_index = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, executionId, stepIndex)
      .first<ConsensusSessionRow>()
    return row ? rowToSession(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ConsensusSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM consensus_sessions
           WHERE workspace_id = ? AND block_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<ConsensusSessionRow>()
    return row ? rowToSession(row) : null
  }

  async upsert(workspaceId: string, session: ConsensusSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO consensus_sessions
           (workspace_id, id, block_id, execution_id, step_index, agent_kind, strategy, status,
            participants, rounds, synthesis, confidence, dissent, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           execution_id = excluded.execution_id,
           step_index = excluded.step_index,
           agent_kind = excluded.agent_kind,
           strategy = excluded.strategy,
           status = excluded.status,
           participants = excluded.participants,
           rounds = excluded.rounds,
           synthesis = excluded.synthesis,
           confidence = excluded.confidence,
           dissent = excluded.dissent,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        session.id,
        session.blockId,
        session.executionId,
        session.stepIndex,
        session.agentKind,
        session.strategy,
        session.status,
        JSON.stringify(session.participants),
        JSON.stringify(session.rounds),
        session.synthesis,
        session.confidence ?? null,
        JSON.stringify(session.dissent ?? []),
        session.error ?? null,
        session.createdAt,
        session.updatedAt,
      )
      .run()
  }
}
