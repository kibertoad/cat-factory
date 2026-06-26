import type { KaizenGrading, KaizenVerifiedCombo } from '../domain/types.js'

// Persistence ports for the Kaizen agent (post-run grading of agent steps). Both
// runtime facades implement them (D1 on Cloudflare, Drizzle/Postgres on Node); the
// cross-runtime conformance suite asserts they behave identically. Rows are scoped
// by workspace.

export interface KaizenGradingRepository {
  /** Create or replace a grading (keyed by `(workspaceId, id)`). */
  upsert(workspaceId: string, grading: KaizenGrading): Promise<void>
  /** A grading by its id, or null. */
  get(workspaceId: string, id: string): Promise<KaizenGrading | null>
  /** The grading for a given `(run, step)`, or null — used to keep scheduling idempotent. */
  getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<KaizenGrading | null>
  /** All gradings for a run, ordered by step index ascending — the run-window status surface. */
  listByExecution(workspaceId: string, executionId: string): Promise<KaizenGrading[]>
  /** Recent gradings for a workspace, newest first — the Kaizen screen history (bounded). */
  listByWorkspace(workspaceId: string, limit?: number): Promise<KaizenGrading[]>
  /**
   * Gradings the background sweep should process: `scheduled` rows plus `running`
   * rows last touched before `staleBefore` (a crashed sweep left them mid-flight).
   * Oldest-first, bounded by `limit`. Scanned across ALL workspaces, so each row is
   * paired with its owning `workspaceId` (the wire grading carries none).
   */
  listPending(
    staleBefore: number,
    limit: number,
  ): Promise<{ workspaceId: string; grading: KaizenGrading }[]>
  /**
   * Atomically claim a pending grading for processing: flip it to `running` ONLY if it is
   * still `scheduled` (or a `running` row last touched before `staleBefore`, i.e. orphaned).
   * Returns whether THIS caller won the claim. The sweep is best-effort and can overlap
   * (a slow batch outlasts the poll interval; a runtime may fire concurrent passes), so
   * {@link listPending} alone would let two passes grade the same row — double-spending an
   * LLM call and double-incrementing a combo's streak. Winning the claim here makes a row
   * grade at most once per attempt.
   */
  claim(workspaceId: string, id: string, staleBefore: number, now: number): Promise<boolean>
}

export interface KaizenVerifiedComboRepository {
  /** A combo's verification progress by key, or null if never graded. */
  getByKey(workspaceId: string, comboKey: string): Promise<KaizenVerifiedCombo | null>
  /** Create or update a combo's streak/verified state. */
  upsert(workspaceId: string, combo: KaizenVerifiedCombo): Promise<void>
  /** All combos for a workspace (verified + in-progress), newest-updated first. */
  listByWorkspace(workspaceId: string): Promise<KaizenVerifiedCombo[]>
}
