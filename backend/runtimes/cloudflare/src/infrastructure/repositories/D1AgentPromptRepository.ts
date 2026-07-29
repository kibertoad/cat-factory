import type { AgentPromptRepository } from '@cat-factory/kernel'
import type { AgentPromptRevision } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface AgentPromptRow {
  agent_kind: string
  revision: number
  text: string | null
  restored_from: number | null
  created_at: number
  created_by: string | null
}

function rowToRevision(row: AgentPromptRow): AgentPromptRevision {
  return {
    agentKind: row.agent_kind,
    revision: row.revision,
    text: row.text,
    ...(row.restored_from != null ? { restoredFrom: row.restored_from } : {}),
    createdAt: row.created_at,
    ...(row.created_by != null ? { createdBy: row.created_by } : {}),
  }
}

/**
 * Per-workspace agent system-prompt overrides, one row per revision in
 * `agent_prompt_revisions` (migration 0068). The highest `revision` for a kind is live; a
 * `text` of NULL is the "follow the shipped built-in" revision.
 *
 * `append` is a plain INSERT on purpose. The service allocates the next revision number from
 * what it read, so the primary-key collision is the concurrency control: it must reach the
 * caller (which maps it to a 409) rather than being absorbed by an `ON CONFLICT DO UPDATE`,
 * which would let a second editor's save silently overwrite the first's.
 */
export class D1AgentPromptRepository implements AgentPromptRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listRevisions(workspaceId: string, agentKind: string): Promise<AgentPromptRevision[]> {
    const { results } = await this.db
      .prepare(
        `SELECT agent_kind, revision, text, restored_from, created_at, created_by
           FROM agent_prompt_revisions
           WHERE workspace_id = ? AND agent_kind = ?
           ORDER BY revision DESC`,
      )
      .bind(workspaceId, agentKind)
      .all<AgentPromptRow>()
    return results.map(rowToRevision)
  }

  async listHeads(workspaceId: string): Promise<AgentPromptRevision[]> {
    // One pass over the workspace's slice rather than a point read per kind: the pipeline
    // builder asks about every step's kind at once. The correlated MAX is indexed by
    // `idx_agent_prompt_revisions_workspace`.
    const { results } = await this.db
      .prepare(
        `SELECT agent_kind, revision, text, restored_from, created_at, created_by
           FROM agent_prompt_revisions r
           WHERE workspace_id = ?
             AND revision = (
               SELECT MAX(revision) FROM agent_prompt_revisions
                 WHERE workspace_id = r.workspace_id AND agent_kind = r.agent_kind
             )
           ORDER BY agent_kind ASC`,
      )
      .bind(workspaceId)
      .all<AgentPromptRow>()
    return results.map(rowToRevision)
  }

  async head(workspaceId: string, agentKind: string): Promise<AgentPromptRevision | null> {
    const row = await this.db
      .prepare(
        `SELECT agent_kind, revision, text, restored_from, created_at, created_by
           FROM agent_prompt_revisions
           WHERE workspace_id = ? AND agent_kind = ?
           ORDER BY revision DESC LIMIT 1`,
      )
      .bind(workspaceId, agentKind)
      .first<AgentPromptRow>()
    return row ? rowToRevision(row) : null
  }

  async append(workspaceId: string, revision: AgentPromptRevision): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_prompt_revisions
           (workspace_id, agent_kind, revision, text, restored_from, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        workspaceId,
        revision.agentKind,
        revision.revision,
        revision.text,
        revision.restoredFrom ?? null,
        revision.createdAt,
        revision.createdBy ?? null,
      )
      .run()
  }
}
