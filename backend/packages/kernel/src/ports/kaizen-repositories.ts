import type { KaizenGrading, KaizenGradingStatus, KaizenVerifiedCombo } from '../domain/types.js'

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
   * One BOUNDED page of a workspace's gradings, newest first (`created_at DESC, id DESC`) — the
   * public entry surface's list (`GET /api/v1/kaizen/entries`).
   *
   * The paged sibling of {@link KaizenGradingRepository.listByWorkspace}, which serves the app's
   * screen and stops at its limit with no way to reach what is behind it. An improvement loop has
   * to consume EVERY entry exactly once, so it needs a cursor rather than a bigger ceiling.
   *
   * `cursor` is an EXCLUSIVE keyset on the same `(createdAt, id)` composite the ordering uses, not
   * a bare `createdAt`: a run completing schedules a grading per step in the same millisecond, and
   * a timestamp-only cursor would drop every tied row from the next page. Every filter is applied
   * in SQL (`acknowledged` on whether `acknowledged_at` is set, `settled` on membership of
   * contracts' `KAIZEN_SETTLED_STATUSES`, `since` an inclusive lower bound on `created_at`), because
   * filtering a page in JS returns short pages that read as the end of the list. The caller reads
   * one row beyond `limit` to detect a further page.
   *
   * `settled` is a set membership rather than a second spelling of `status`: it is the SAME
   * predicate {@link KaizenGradingRepository.setAcknowledgement} gates its write on, so
   * `acknowledged: false, settled: true` is exactly the backlog that write accepts. Both facades
   * derive it from that one constant, so a grading status added later cannot make the filter and
   * the write disagree about what "the grader is done with it" means.
   */
  listPage(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      acknowledged?: boolean
      settled?: boolean
      status?: KaizenGradingStatus
      agentKind?: string
      since?: number
    },
  ): Promise<KaizenGrading[]>
  /**
   * Record or clear a grading's acknowledgement, answering the row as it stands afterwards (null
   * when the workspace holds no such id).
   *
   * Its own method rather than a field on {@link KaizenGradingRepository.upsert} because the two
   * writers must not collide: the grading sweep owns the grade and re-writes the row on every
   * transition, while acknowledgement is a human act about what the grade SAID. `upsert` therefore
   * leaves these columns alone, and a re-grade keeps whatever was acknowledged.
   *
   * `ack` non-null sets it, and does so only on a row that is still UNACKNOWLEDGED and has
   * SETTLED (`complete` or `failed`), so `acknowledgedAt` keeps naming the first triage rather
   * than the last retry, and a row the grader is still working cannot be marked triaged. Both
   * conditions live in the statement rather than in a caller's pre-check, which would leave a
   * window between the check and the write. `ack` null clears all three columns, and is likewise
   * guarded on the row being acknowledged in the first place, so clearing what was never
   * acknowledged writes nothing at all.
   *
   * `now` stamps `updatedAt` alongside, and is the SAME value written to `acknowledgedAt`, so a
   * consumer polling `max(updatedAt)` as its change watermark sees triage move. It is a parameter
   * rather than two clock reads for the same reason the two columns are written together: they
   * describe one event, and a row whose acknowledgement is newer than its own last-changed stamp
   * would be a lie about its own history. Nothing is written when a guard rejects the row, so a
   * no-op cannot bump the stamp the sweep's staleness check reads.
   */
  setAcknowledgement(
    workspaceId: string,
    id: string,
    ack: { by: string | null; note: string | null } | null,
    now: number,
  ): Promise<KaizenGrading | null>
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
   * LLM call. Winning the claim here makes a row grade at most once per attempt.
   *
   * NOTE: this serializes a single ROW, not a combo. Two DIFFERENT rows sharing a combo
   * key (e.g. the same kind in two steps of one run) could still be graded by two
   * concurrent passes and race the read-modify-write of the combo streak in
   * `KaizenService.updateCombo`. That race is strictly conservative — it can only UNDER-
   * count the streak (delaying verification), never falsely verify — so each runtime just
   * avoids overlapping its own passes (the Node sweeper's re-entrancy flag / the Worker's
   * `kaizenSweeping` guard) rather than locking per combo.
   */
  claim(workspaceId: string, id: string, staleBefore: number, now: number): Promise<boolean>
}

export interface KaizenVerifiedComboRepository {
  /** A combo's verification progress by key, or null if never graded. */
  getByKey(workspaceId: string, comboKey: string): Promise<KaizenVerifiedCombo | null>
  /** Create or update a combo's streak/verified state. */
  upsert(workspaceId: string, combo: KaizenVerifiedCombo): Promise<void>
  /**
   * The combos for a named SET of keys, in one chunked `IN` query — the batched sibling of
   * {@link KaizenVerifiedComboRepository.getByKey}.
   *
   * What the public entry surface joins a page of gradings against. The two shapes it replaces are
   * both wrong at that scale: `getByKey` per entry is the N+1 this codebase bans, and
   * `listByWorkspace` reads the workspace's whole combo library (unbounded in the kinds, models and
   * prompt versions it has ever run) to answer for at most one page of keys, which a single-entry
   * read pays in full. Keys with no combo are simply absent; empty input → empty result.
   */
  listByKeys(workspaceId: string, comboKeys: string[]): Promise<KaizenVerifiedCombo[]>
  /** All combos for a workspace (verified + in-progress), newest-updated first. */
  listByWorkspace(workspaceId: string): Promise<KaizenVerifiedCombo[]>
}
