import * as v from 'valibot'
import { kaizenGradingStatusSchema } from './kaizen.js'
import { blockStatusSchema } from './primitives.js'
import {
  booleanQuerySchema,
  cursorSchema,
  epochMsQuerySchema,
  pageLimitSchema,
} from './public-paging.js'

// ---------------------------------------------------------------------------
// Public KAIZEN-ENTRY wire shapes (`/api/v1/kaizen/entries`, `…/{entryId}`, `…/acknowledge`).
//
// A Kaizen entry is one post-run grading of one agent step: how smooth or chaotic that
// interaction was, and what the grader recommends changing (`KaizenService`). Inside
// the app they are read one board at a time — the Kaizen screen's bounded history, and the
// per-run status strip in the run window — which is enough for a person browsing, and useless
// for the thing this surface exists for: a continuous-improvement loop that has to consume EVERY
// entry exactly once, file the recommendations somewhere, and come back for what is new.
//
// Three rules shape these shapes:
//
//  1. **The list is workspace-wide and keyset-paginated, with NO run or task required up front.**
//     An improvement loop does not know which runs produced recommendations; that is what it is
//     asking. Every other Kaizen read makes the caller name a run first, which is the one thing
//     it cannot supply.
//  2. **An entry carries the investigative context, not just the grade.** The point of reading
//     one is deciding whether to act on it, and that decision needs to know WHAT was graded
//     (agent kind, resolved model, prompt version), WHERE (run, step index, task, service) and
//     whether the combo it names is already verified and therefore no longer being graded.
//     Everything here is either on the grading row or one batched lookup away; the run's own
//     detail stays behind `GET /api/v1/debug/runs/{runId}`, which the `runId` joins onto.
//  3. **Acknowledgement is the entry's own state**, written only through this surface and never
//     by the grading sweep. It is what makes the loop incremental: `?acknowledged=false` is the
//     backlog, and acknowledging is what takes an entry out of it.
// ---------------------------------------------------------------------------

/** Machine-readable `details.reason` for an entry id this workspace does not hold. */
export const KAIZEN_ENTRY_NOT_FOUND_REASON = 'kaizen_entry_not_found'

/**
 * Machine-readable `details.reason` for acknowledging an entry that has not settled yet.
 *
 * Distinct from a 404 because it is about TIMING rather than identity: the entry exists, the
 * grader has simply not finished with it, and a caller that acknowledged it now would be marking
 * recommendations triaged before they were written. Retry once the entry reaches `complete` or
 * `failed`.
 */
export const KAIZEN_ENTRY_NOT_SETTLED_REASON = 'kaizen_entry_not_settled'

/**
 * The board coordinates of the graded run, resolved at read time — null when the task block has
 * since been deleted.
 *
 * Separate from the entry's own `taskId` on purpose: the id is a fact the grading row RECORDED
 * and always answers, while this is what the board says about it NOW. Collapsing the two would
 * make a deleted task read as an entry that never had one.
 */
export const publicKaizenEntryTaskSchema = v.object({
  title: v.string(),
  /** The task's board lifecycle status (`planned` / `in_progress` / `done` / …). */
  status: blockStatusSchema,
  /**
   * The enclosing service frame (`GET /api/v1/services`), or null for a task outside one — a
   * headless job's anchor, or a board block that predates services.
   */
  serviceId: v.nullable(v.string()),
  /** That service's title, when it resolved. */
  serviceTitle: v.nullable(v.string()),
})
export type PublicKaizenEntryTask = v.InferOutput<typeof publicKaizenEntryTaskSchema>

/**
 * Where the entry's `(agentKind, model, promptVersion)` combo stands in the verification streak,
 * or null when nothing has been recorded for it yet.
 *
 * Carried because it decides whether an entry is worth acting on: a VERIFIED combo is one the
 * engine has stopped grading, so its recommendations are historical, and a long streak says the
 * pairing is behaving even if this one run was not.
 */
export const publicKaizenEntryComboSchema = v.object({
  /** Consecutive high grades (4 or 5, no recommendations) recorded for the combo. */
  consecutiveHighGrades: v.number(),
  /** Whether it crossed the streak threshold and is no longer graded. */
  verified: v.boolean(),
  /** Epoch ms it crossed, else null. */
  verifiedAt: v.nullable(v.number()),
})
export type PublicKaizenEntryCombo = v.InferOutput<typeof publicKaizenEntryComboSchema>

/**
 * One Kaizen entry as `/api/v1` speaks it: the grading, what produced it, and its triage state.
 *
 * The id vocabulary is the public one — `entryId` for the grading, `runId` and `taskId` for the
 * run and board block the stored row calls `executionId` and `blockId` — so every id here
 * addresses something on this API. Nothing the row holds is dropped.
 */
export const publicKaizenEntrySchema = v.object({
  /** The id to pass to `GET /api/v1/kaizen/entries/{entryId}` and the acknowledge route. */
  entryId: v.string(),
  /** The run whose step was graded (`GET /api/v1/debug/runs/{runId}` for its own detail). */
  runId: v.string(),
  /** Index of the graded step within that run's pipeline. */
  stepIndex: v.number(),
  /** The board task the run was started on, as the row recorded it. */
  taskId: v.string(),
  /** What the board says about that task now, or null when it has been deleted. */
  task: v.nullable(publicKaizenEntryTaskSchema),
  /** The graded step's agent kind (`coder`, `architect`, a deployment's own kind, …). */
  agentKind: v.string(),
  /** The model the step actually dispatched on, as resolved at dispatch. */
  model: v.string(),
  /** The shipped prompt version the step ran, from the agents prompt-version registry. */
  promptVersion: v.number(),
  /** `agentKind|model|promptVersion(|revision|variant)` — what the streak is kept against. */
  comboKey: v.string(),
  /** The combo's verification progress, or null when nothing has been recorded for it. */
  combo: v.nullable(publicKaizenEntryComboSchema),
  /** Where the grading itself got to (`scheduled` / `running` / `complete` / `failed`). */
  status: kaizenGradingStatusSchema,
  /** 1..5 once `complete` (5 = smooth, guided, efficient); null while pending or failed. */
  grade: v.nullable(v.number()),
  /** The grader's prose account of how the interaction went; empty until it completes. */
  summary: v.string(),
  /** What the grader recommends changing. Empty ⇒ it found nothing to improve. */
  recommendations: v.array(v.string()),
  /** `provider:model` that produced the grade, so a reader can weigh the grader itself. */
  graderModel: v.nullable(v.string()),
  /**
   * Why the grading `failed`, else null. A failure is a real entry rather than a hidden one: it
   * usually names a deployment-level problem (prompt recording off, no grader model wired) that
   * nothing else reports, and it is acknowledgeable for exactly that reason.
   */
  error: v.nullable(v.string()),
  /** Whether somebody has triaged it — the same fact `acknowledgedAt` carries, as the filter. */
  acknowledged: v.boolean(),
  /** Epoch ms it was acknowledged, else null. */
  acknowledgedAt: v.nullable(v.number()),
  /** The user (`usr_*`) or API key (`pak_*`) that acknowledged it, else null. */
  acknowledgedBy: v.nullable(v.string()),
  /** The note left with the acknowledgement, else null. */
  acknowledgementNote: v.nullable(v.string()),
  /** Epoch ms the grading was scheduled (also what the list orders and pages on). */
  createdAt: v.number(),
  /** Epoch ms the row last changed (a grader transition or an acknowledgement). */
  updatedAt: v.number(),
})
export type PublicKaizenEntry = v.InferOutput<typeof publicKaizenEntrySchema>

export const publicKaizenEntryListSchema = v.object({
  entries: v.array(publicKaizenEntrySchema),
  /**
   * Cursor to pass as `?cursor=` for the next page, or null when this was the last page. A
   * non-null cursor means "there may be more", so a client pages until it comes back null.
   */
  nextCursor: v.nullable(v.string()),
})
export type PublicKaizenEntryList = v.InferOutput<typeof publicKaizenEntryListSchema>

/**
 * Query params for `GET /api/v1/kaizen/entries`. Ordering is newest-first on the grading's
 * `createdAt`, keyset-paged on `(createdAt, entryId)` so a burst of gradings sharing a
 * millisecond cannot lose rows between pages.
 *
 * The filters are the four questions an improvement loop actually asks, each pushed into SQL:
 * what is untriaged, what settled, what a given agent kind is being told, and what is new since
 * the last sweep. They compose (`?acknowledged=false&status=complete` is the working backlog).
 */
export const listPublicKaizenEntriesQuerySchema = v.object({
  /** Rows per page (1..100); omitted → 25. */
  limit: v.optional(pageLimitSchema),
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: v.optional(cursorSchema),
  /** `false` for the untriaged backlog, `true` for what has been handled; omitted → both. */
  acknowledged: v.optional(booleanQuerySchema),
  /** Return only entries whose grading is in this state. */
  status: v.optional(kaizenGradingStatusSchema),
  /** Return only entries grading this agent kind. */
  agentKind: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  /** Return only entries created at or after this epoch-ms stamp (the incremental-poll filter). */
  since: v.optional(epochMsQuerySchema),
})
export type ListPublicKaizenEntriesQuery = v.InferOutput<typeof listPublicKaizenEntriesQuerySchema>

/** Longest acknowledgement note the surface stores. */
export const KAIZEN_ACKNOWLEDGEMENT_NOTE_MAX = 2_000

/**
 * Body for `POST /api/v1/kaizen/entries/{entryId}/acknowledge`.
 *
 * `acknowledged` is optional and defaults to `true`, so the ordinary call is an empty body; pass
 * `false` to put an entry back on the backlog after acknowledging it by mistake. Acknowledging an
 * already-acknowledged entry is a no-op that returns the row unchanged, which keeps
 * `acknowledgedAt` naming when it was FIRST triaged rather than when a retrying client last
 * repeated itself.
 */
export const acknowledgeKaizenEntrySchema = v.object({
  /** `true` (the default) records the acknowledgement; `false` clears it. */
  acknowledged: v.optional(v.boolean()),
  /**
   * What the next reader should know: a ticket id, a decision, why it was dismissed. Stored only
   * with the acknowledgement that lands, and cleared along with it.
   */
  note: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(KAIZEN_ACKNOWLEDGEMENT_NOTE_MAX))),
  ),
})
export type AcknowledgeKaizenEntry = v.InferOutput<typeof acknowledgeKaizenEntrySchema>
