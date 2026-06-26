import type { BrainstormSession, BrainstormStage } from '../domain/types.js'

// Persistence port for the brainstorm (structured-dialogue) feature. Mirrors the
// requirements/clarity review repositories, but keyed by (block, STAGE): a block may
// have one live `requirements` session and one live `architecture` session at the same
// time, so lookups and deletes are scoped per stage. Rows are scoped by workspace and
// keyed by session id. Implemented by D1 on the Cloudflare facade and by Drizzle/Postgres
// on the Node facade.

export interface BrainstormSessionRepository {
  /** The current session for a block + stage, or null if none has been run. */
  getByBlockStage(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<BrainstormSession | null>
  /** A session by its id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<BrainstormSession | null>
  /** Create or replace a session (the service deletes a block+stage's prior session first). */
  upsert(workspaceId: string, session: BrainstormSession): Promise<void>
  /** Drop any existing session(s) for a block + stage (called before a fresh run). */
  deleteByBlockStage(workspaceId: string, blockId: string, stage: BrainstormStage): Promise<void>
}
