import type { AgentPromptRevision } from '../domain/types.js'

// Persistence port for per-workspace agent system-prompt overrides. The Worker implements
// it against D1, the Node service against Postgres; tests supply an in-memory fake.
//
// The store is an APPEND-ONLY log: one row per revision of one `(workspace, agentKind)`
// prompt, and the HIGHEST revision is live. Restoring an older prompt appends a copy of it
// rather than moving a pointer, so the log always reads forward and history is never lost by
// going back. A revision with `text: null` means "follow the shipped built-in prompt" — the
// deliberate way back, distinct from a kind that was simply never touched.
//
// `revision` is allocated by the caller from what it just read, so the repository's uniqueness
// on `(workspace_id, agent_kind, revision)` is what makes two concurrent editors safe: the
// loser's insert collides instead of silently clobbering the winner's text. Implementations
// must therefore let that violation PROPAGATE (the service maps it to a 409) rather than
// swallowing it with an upsert.

export interface AgentPromptRepository {
  /**
   * The full revision log for one kind, NEWEST FIRST (so `[0]` is live). Empty for an
   * untouched kind.
   */
  listRevisions(workspaceId: string, agentKind: string): Promise<AgentPromptRevision[]>
  /**
   * The live revision of EVERY kind that has one, for the workspace's override index. One
   * query rather than a point read per pipeline step — the builder asks about a whole
   * pipeline's worth of kinds at once.
   */
  listHeads(workspaceId: string): Promise<AgentPromptRevision[]>
  /** The live revision for one kind, or null when the kind was never touched. */
  head(workspaceId: string, agentKind: string): Promise<AgentPromptRevision | null>
  /**
   * Append a revision. Throws when `revision` already exists for the kind — see the
   * concurrency note above; never silently overwrite.
   */
  append(workspaceId: string, revision: AgentPromptRevision): Promise<void>
}
