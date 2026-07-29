import type { ConsensusGroup, ConsensusSession } from '../domain/types.js'

// Persistence port for the consensus-orchestration feature. Each runtime facade
// implements it (Cloudflare D1 + Node Postgres/Drizzle); tests/conformance supply
// an in-memory fake. Rows are scoped by workspace and keyed by session id, with at
// most one session per (executionId, stepIndex) — a re-run of a step replaces its
// prior session. The scaffolding is always present (cheap/empty when the optional
// `@cat-factory/consensus` package is not wired); only the executor/strategies are
// opt-in.

export interface ConsensusSessionRepository {
  /** A session by its id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<ConsensusSession | null>
  /** The session for a specific run step, or null if none has run. */
  getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<ConsensusSession | null>
  /** The most recent session for a block, or null if none has run. */
  getByBlock(workspaceId: string, blockId: string): Promise<ConsensusSession | null>
  /** Create or replace a session (idempotent per id — replays/live updates re-upsert). */
  upsert(workspaceId: string, session: ConsensusSession): Promise<void>
}

/**
 * The workspace's consensus-GROUP library: reusable, estimate-gated panels a pipeline step
 * escalates to. Unlike the session store this is authored config, so it is read on the RUN
 * path — {@link listByIds} resolves a step's whole tier set in ONE chunked `IN` query per
 * dispatch, never a point read per id.
 */
export interface ConsensusGroupRepository {
  /** A group by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<ConsensusGroup | null>
  /** Every group in the workspace's library (settings UI + board-load snapshot). */
  list(workspaceId: string): Promise<ConsensusGroup[]>
  /**
   * The groups for a set of ids, in one batched read — the dispatch-path shape. Ids that do
   * not resolve are simply absent from the result (a step naming a deleted group degrades to
   * its remaining tiers rather than failing the run).
   */
  listByIds(workspaceId: string, ids: string[]): Promise<ConsensusGroup[]>
  /** Create or replace a group (keyed by id). */
  upsert(workspaceId: string, group: ConsensusGroup): Promise<void>
  /** Remove a group by id (no-op if absent). */
  remove(workspaceId: string, id: string): Promise<void>
}
