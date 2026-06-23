import type { ConsensusSession } from '../domain/types.js'

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
