import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Interactive document-review-session wire contracts (WS5 of the document-task
// initiative). Between the outline and the written draft, a `doc-interviewer`
// step converses with the human: it asks a small batch of clarifying questions
// about scope / audience / structure, the human answers, and the loop iterates
// (up to a round cap) until the interviewer synthesizes a refined authoring
// brief. The run PARKS on the standard durable decision-wait while the human
// answers through the dedicated window, then RESUMES — mirroring the initiative
// planning interview, but persisted in its own per-block session table (a
// document task has no owning entity row to hang the transcript on).
//
// The synthesized `brief` is folded into the doc-writer's context so the draft
// starts from an interview-refined spec, not the raw block description.
// ---------------------------------------------------------------------------

const DOC_INTERVIEW_ID_MAX = 80
const DOC_INTERVIEW_SHORT_MAX = 2000
const DOC_INTERVIEW_PROSE_MAX = 8000

const idField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(DOC_INTERVIEW_ID_MAX))
const shortProseField = v.pipe(v.string(), v.maxLength(DOC_INTERVIEW_SHORT_MAX))

/**
 * A single interview exchange: the interviewer appends a question with an empty
 * `answer` (a PENDING question the human must answer); the human fills it in. A
 * stable `id` addresses the answer write (optional only so hand-authored/fixture
 * Q&A without one still parses — the interviewer always sets it).
 */
export const docInterviewQaSchema = v.object({
  id: v.optional(idField),
  question: shortProseField,
  answer: v.optional(shortProseField, ''),
})
export type DocInterviewQa = v.InferOutput<typeof docInterviewQaSchema>

/**
 * Lifecycle of the interactive document interview session (one live session per
 * block). `awaiting` while the run is parked for the human to answer the current
 * batch; `done` once the interview converged (or the human proceeded) and the
 * `brief` was synthesized.
 */
export const docInterviewStatusSchema = v.picklist(['awaiting', 'done'])
export type DocInterviewStatus = v.InferOutput<typeof docInterviewStatusSchema>

/**
 * The persisted interactive-document-interview session — the source of truth the
 * window renders and the run parks on. `round` counts interviewer passes (it may
 * ask follow-ups after seeing answers, up to `maxRounds`); `brief` is the
 * synthesized authoring brief folded into the writer's context once `status` is
 * `done`. One row per block; a re-run replaces it.
 */
export const docInterviewSessionSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  status: docInterviewStatusSchema,
  round: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxRounds: v.pipe(v.number(), v.integer(), v.minValue(1)),
  qa: v.optional(v.array(docInterviewQaSchema), []),
  /** The synthesized authoring brief; absent until the interview converges. */
  brief: v.nullable(v.pipe(v.string(), v.maxLength(DOC_INTERVIEW_PROSE_MAX))),
  /** The model that ran the interviewer, for observability. */
  model: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type DocInterviewSession = v.InferOutput<typeof docInterviewSessionSchema>

/** Record the human's answer to one pending interview question (no run resume). */
export const answerDocInterviewSchema = v.object({
  questionId: idField,
  answer: shortProseField,
})
export type AnswerDocInterviewInput = v.InferOutput<typeof answerDocInterviewSchema>
