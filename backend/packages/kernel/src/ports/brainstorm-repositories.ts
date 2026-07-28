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
  /** Force-write a session, bumping its `rev` (seeding / the insert behind {@link replaceForBlockStage}). */
  upsert(workspaceId: string, session: BrainstormSession): Promise<void>
  /**
   * Rev-guarded conditional update — the brainstorm mirror of
   * `RequirementReviewRepository.compareAndSwap`, with the same never-inserts contract.
   */
  compareAndSwap(workspaceId: string, session: BrainstormSession): Promise<boolean>
  /**
   * ATOMICALLY make `session` the block's one live session FOR ITS STAGE (a single
   * conflict-targeted upsert against the UNIQUE (workspace, block, stage) index; the stage is
   * read off the session, since a block may hold one live `requirements` and one live
   * `architecture` session at once) — the brainstorm mirror of
   * `RequirementReviewRepository.replaceForBlock`, including why a transactioned
   * delete-then-insert is NOT an acceptable implementation.
   */
  replaceForBlockStage(workspaceId: string, session: BrainstormSession): Promise<void>
}
