import type { DocInterviewSession } from '../domain/types.js'

// Persistence port for interactive document-interview sessions (WS5). Rows are
// scoped by workspace and keyed by session id, with the service keeping at most
// one live session per block (it clears the block's prior session before a fresh
// run), so `getByBlock` returns the latest. Mirrors the requirement-review
// repository shape — a plain upsert store, no CAS token needed.

export interface DocInterviewRepository {
  /** The latest interactive-interview session anchored to a board block, or null. */
  getByBlock(workspaceId: string, blockId: string): Promise<DocInterviewSession | null>
  /** A session by its id, or null. */
  get(workspaceId: string, id: string): Promise<DocInterviewSession | null>
  /** Insert or update a session (keyed by workspace + id). */
  upsert(workspaceId: string, session: DocInterviewSession): Promise<void>
  /** Delete every session anchored to a block (when the block is removed / re-run). */
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}
