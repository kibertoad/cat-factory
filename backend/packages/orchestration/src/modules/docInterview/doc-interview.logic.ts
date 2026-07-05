import type { DocInterviewQa, DocInterviewSession } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Pure state transitions + coercion for the interactive document-interview
// session (WS5). The interviewer LLM (DocInterviewService) decides WHAT to ask /
// synthesize; these apply the decision to the session entity. Mirrors the
// initiative interview's `initiative.logic.ts`, but the converged outcome is a
// single synthesized authoring `brief` (a document has no goal/constraints/
// non-goals triple) folded into the writer's context.
// ---------------------------------------------------------------------------

/** How many interviewer passes may run before the loop is force-converged. */
export const DOC_INTERVIEW_MAX_ROUNDS = 4
/** Upper bound on questions the interviewer may ask in one round (keeps the gate answerable). */
export const DOC_INTERVIEW_MAX_QUESTIONS = 8
/** Clamp bounds, mirroring the strict wire schema's `shortProseField` / prose limits. */
const SHORT_MAX = 2000
const PROSE_MAX = 8000

const clampShort = (s: string): string => s.trim().slice(0, SHORT_MAX)
const clampProse = (s: string): string => s.trim().slice(0, PROSE_MAX)

/** The interviewer LLM's decision: ask more questions, or converge with a synthesized brief. */
export type DocInterviewOutput =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'done'; brief: string }

/**
 * Leniently coerce the interviewer's JSON into a {@link DocInterviewOutput}. `finalize` forces
 * convergence (the human proceeded, or the round cap was hit) regardless of what the model
 * returned. Empty/absent questions also mean convergence — nothing left to ask.
 */
export function coerceDocInterviewOutput(
  parsed: unknown,
  opts: { finalize: boolean },
): DocInterviewOutput {
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >
  const questions = Array.isArray(obj.questions)
    ? obj.questions
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map(clampShort)
        .slice(0, DOC_INTERVIEW_MAX_QUESTIONS)
    : []
  const done = opts.finalize || obj.done === true || questions.length === 0
  if (done) {
    return { kind: 'done', brief: typeof obj.brief === 'string' ? clampProse(obj.brief) : '' }
  }
  return { kind: 'questions', questions }
}

/** Only the answered exchanges — the digest that survives across rounds. */
function answeredQa(session: DocInterviewSession): DocInterviewQa[] {
  return (session.qa ?? []).filter((q) => (q.answer ?? '').trim().length > 0)
}

/** A fresh, empty session for a block (round 0, awaiting the interviewer's first pass). */
export function newDocInterviewSession(
  id: string,
  blockId: string,
  now: number,
  maxRounds = DOC_INTERVIEW_MAX_ROUNDS,
): DocInterviewSession {
  return {
    id,
    blockId,
    status: 'awaiting',
    round: 0,
    maxRounds,
    qa: [],
    brief: null,
    model: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Append a fresh round of pending questions: keep the answered digest, drop any prior-round
 * questions the human skipped, add the new ones with stable ids. Bumps the round and parks it
 * `awaiting`.
 */
export function applyDocInterviewQuestions(
  session: DocInterviewSession,
  questions: string[],
  nextId: () => string,
  now: number,
): DocInterviewSession {
  const pending: DocInterviewQa[] = questions.map((question) => ({
    id: nextId(),
    question: clampShort(question),
    answer: '',
  }))
  return {
    ...session,
    status: 'awaiting',
    round: session.round + 1,
    qa: [...answeredQa(session), ...pending],
    updatedAt: now,
  }
}

/** Record the human's answer to one pending question (matched by id). No-op if unknown. */
export function applyDocInterviewAnswer(
  session: DocInterviewSession,
  questionId: string,
  answer: string,
  now: number,
): DocInterviewSession {
  return {
    ...session,
    qa: (session.qa ?? []).map((q) =>
      q.id === questionId ? { ...q, answer: clampShort(answer) } : q,
    ),
    updatedAt: now,
  }
}

/**
 * Converge the interview: keep the answered digest, fold the synthesized brief onto the
 * session, and mark it `done`. A blank synthesized brief keeps the prior one (defensive — the
 * finalize pass should always produce one).
 */
export function applyDocInterviewOutcome(
  session: DocInterviewSession,
  brief: string,
  now: number,
): DocInterviewSession {
  return {
    ...session,
    status: 'done',
    qa: answeredQa(session),
    brief: brief.trim() || session.brief || '',
    updatedAt: now,
  }
}

/** Whether the interviewer must force-converge on the next pass (the round cap was reached). */
export function docInterviewAtCap(session: DocInterviewSession): boolean {
  return session.round >= session.maxRounds
}

/** Render the answered Q&A digest as prompt lines (empty array when nothing is answered). */
export function answeredDigest(session: DocInterviewSession): string[] {
  const answered = answeredQa(session)
  if (!answered.length) return []
  const lines = ['Answers gathered so far:']
  for (const { question, answer } of answered) lines.push(`- Q: ${question}`, `  A: ${answer}`)
  return lines
}
