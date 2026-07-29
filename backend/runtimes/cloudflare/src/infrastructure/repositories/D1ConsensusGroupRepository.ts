import type { ConsensusGroupRepository } from '@cat-factory/kernel'
import type { ConsensusGating, ConsensusGroup, ConsensusParticipant } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface ConsensusGroupRow {
  id: string
  name: string
  description: string | null
  strategy: string
  participants: string
  synthesizer_model_id: string | null
  rounds: number | null
  gating: string
  created_at: number
}

/** The bar a row falls back to when its JSON is unreadable: none (the group is the floor). */
const UNGATED: ConsensusGating = { enabled: false, onMissingEstimate: 'consensus' }

function parseParticipants(raw: string): ConsensusParticipant[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ConsensusParticipant[]) : []
  } catch {
    return []
  }
}

/**
 * A malformed gating column degrades to UNGATED rather than to a bar nobody can clear: the
 * selection reads this to decide whether the panel runs at all, and failing closed on unreadable
 * config would silently downgrade a workspace's reviews with no error anywhere. A group with no
 * usable participants is rejected by the executor's own `< 2` backstop regardless.
 */
function parseGating(raw: string): ConsensusGating {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ConsensusGating
  } catch {
    // fall through
  }
  return UNGATED
}

function rowToGroup(row: ConsensusGroupRow): ConsensusGroup {
  return {
    id: row.id,
    name: row.name,
    ...(row.description != null ? { description: row.description } : {}),
    strategy: row.strategy as ConsensusGroup['strategy'],
    participants: parseParticipants(row.participants),
    ...(row.synthesizer_model_id != null ? { synthesizerModelId: row.synthesizer_model_id } : {}),
    ...(row.rounds != null ? { rounds: row.rounds } : {}),
    gating: parseGating(row.gating),
    createdAt: row.created_at,
  }
}

/**
 * The workspace consensus-GROUP library in `consensus_groups` (migration 0070): the reusable,
 * estimate-gated panels a pipeline step escalates to. Participants and the gating bar live as
 * JSON columns — neither is ever a query predicate, since the tier selection runs in TypeScript
 * over the batch {@link listByIds} returns.
 */
export class D1ConsensusGroupRepository implements ConsensusGroupRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<ConsensusGroup | null> {
    const row = await this.db
      .prepare(`SELECT * FROM consensus_groups WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ConsensusGroupRow>()
    return row ? rowToGroup(row) : null
  }

  async list(workspaceId: string): Promise<ConsensusGroup[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM consensus_groups WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<ConsensusGroupRow>()
    return results.map(rowToGroup)
  }

  async listByIds(workspaceId: string, ids: string[]): Promise<ConsensusGroup[]> {
    if (!ids.length) return []
    const groups: ConsensusGroup[] = []
    for (const chunk of chunkForIn(ids)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM consensus_groups
             WHERE workspace_id = ? AND id IN (${placeholders})
             ORDER BY created_at ASC`,
        )
        .bind(workspaceId, ...chunk)
        .all<ConsensusGroupRow>()
      groups.push(...results.map(rowToGroup))
    }
    return groups
  }

  async upsert(workspaceId: string, group: ConsensusGroup): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO consensus_groups
           (workspace_id, id, name, description, strategy, participants, synthesizer_model_id,
            rounds, gating, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           strategy = excluded.strategy,
           participants = excluded.participants,
           synthesizer_model_id = excluded.synthesizer_model_id,
           rounds = excluded.rounds,
           gating = excluded.gating`,
      )
      .bind(
        workspaceId,
        group.id,
        group.name,
        group.description ?? null,
        group.strategy,
        JSON.stringify(group.participants),
        group.synthesizerModelId ?? null,
        group.rounds ?? null,
        JSON.stringify(group.gating),
        group.createdAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM consensus_groups WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }
}
