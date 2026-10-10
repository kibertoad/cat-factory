import { computed, reactive, watch } from 'vue'

/**
 * Per-question answer drafts for an INTERVIEW gate window (the initiative planner's interviewer and
 * the doc-authoring interviewer), plus the two ways they leave the browser: one answer on blur, and
 * every dirty answer on the way out.
 *
 * Both windows hold the same shape of draft for the same reason, and recording one is a PLAIN SAVE:
 * it writes the reply without resolving the interview, which is what the window's own two commands
 * do. That is what makes the FLUSH disposition correct here rather than a discard prompt (see
 * `ResultWindowDrafts.logic.spec.ts` for the rule and the per-window table).
 *
 * It is ONE seam because the two windows held byte-identical copies of this logic and only ever got
 * fixed one at a time: the doc interview grew a close-time flush while the planner kept dropping
 * answers on close, and neither reported a failed write. Three properties are easy to lose when this
 * is hand-rolled per window, and each one was:
 *
 *  - The flush CAPTURES what it needs synchronously. `blockId` and everything derived from it go
 *    null the instant the view tears down, so an awaited loop that re-reads them writes nowhere.
 *  - Each answer settles INDEPENDENTLY. A loop that awaited straight through dropped every answer
 *    after the first rejection, with the window already gone.
 *  - Every path REPORTS its own failure. Both backing stores rethrow and Vue discards a handler's
 *    returned promise, so an unreported write is an unhandled rejection and, to the user, a no-op.
 */

/** The minimum an exchange has to carry for a draft answer to be held against it. */
export interface InterviewDraftQuestion {
  /**
   * The id the answer write addresses. Optional because the wire shape leaves it optional (a
   * hand-authored or fixture exchange parses without one); see {@link useInterviewDrafts}'s
   * `addressable`.
   */
  id?: string
  /** Stable key for the list and the draft map: the question id, or its index as a fallback. */
  key: string
  /** What is already recorded. Seeds the draft, and decides whether the draft is dirty. */
  answer?: string
}

export function useInterviewDrafts<Q extends InterviewDraftQuestion>(opts: {
  /** The block the answers are written against, or null while no view is open. */
  blockId: () => string | null
  /** Every exchange the session holds, settled rounds included. */
  questions: () => Q[]
  /** The subset still owing an answer, which is what the submit button waits on. */
  pending: () => Q[]
  /** Record ONE answer against the block. */
  write: (blockId: string, questionId: string, answer: string) => Promise<unknown>
  /**
   * Whether this question's draft may be written at all. A question set aside as not-relevant had
   * its recorded answer cleared, so writing a stale local draft back would silently re-answer it.
   */
  writable?: (question: Q) => boolean
  /** Toast titles for a failed write: one answer lost, and several (which takes a `{ count }`). */
  failureTitleKeys: { one: string; many: string }
}) {
  const { present } = usePipelineErrorToast()

  const drafts = reactive<Record<string, string>>({})
  // Seeded from the entity and refreshed as new rounds arrive, without clobbering an answer the
  // human is mid-edit on.
  watch(
    opts.questions,
    (list) => {
      for (const question of list) {
        if (!(question.key in drafts)) drafts[question.key] = question.answer ?? ''
      }
    },
    { immediate: true },
  )

  /**
   * Whether an answer to this exchange can be RECORDED at all: the write addresses a question BY
   * ID, so one without an id has nowhere for an answer to go.
   *
   * Callers disable that question's input and say why. Accepting text into it instead would take an
   * answer the flush could only drop, which is the silent loss this seam exists to end.
   */
  function addressable(question: Q): boolean {
    return typeof question.id === 'string' && question.id.length > 0
  }

  /**
   * Questions still missing a drafted answer, which is what a submit button gates on (and renders,
   * because a disabled button with no stated reason is itself a "nothing happened").
   *
   * Unaddressable questions are excluded: nothing the human can type clears one, so counting it
   * would disable the submit for good.
   */
  const unanswered = computed(
    () => opts.pending().filter((q) => addressable(q) && !drafts[q.key]?.trim()).length,
  )

  /**
   * Persist one answer when its draft differs from what is recorded. The block id is threaded in
   * rather than read off `opts.blockId()`, so a flush that started as the window closed still writes
   * to the right board.
   */
  async function persist(blockId: string, question: Q): Promise<void> {
    const id = question.id
    if (!id || opts.writable?.(question) === false) return
    const next = (drafts[question.key] ?? '').trim()
    if (!next || next === (question.answer ?? '').trim()) return
    await opts.write(blockId, id, next)
  }

  /** Report a failed write, naming how many answers did not make it. */
  function report(failed: number, cause: unknown): void {
    present(cause, failed === 1 ? opts.failureTitleKeys.one : opts.failureTitleKeys.many, {
      count: failed,
    })
  }

  /**
   * Persist every dirty draft, each on its OWN: one rejection may not cost the answers after it.
   * Returns how many could not be written plus the first cause, which is what the caller reports.
   *
   * Sequential rather than concurrent because each write is a read-modify-write of the session's one
   * question-and-answer array, so two in flight would race to overwrite each other's answer.
   */
  async function flushAll(blockId: string, list: Q[]): Promise<{ failed: number; cause: unknown }> {
    let failed = 0
    let cause: unknown
    for (const question of list) {
      try {
        await persist(blockId, question)
      } catch (error) {
        failed += 1
        if (failed === 1) cause = error
      }
    }
    return { failed, cause }
  }

  /**
   * Save this ONE answer against the block that is open right now: the blur handler, and the same
   * call an adopted recommendation makes. Detached, because Vue discards a handler's returned
   * promise, so the failure is reported here or nowhere.
   */
  function saveAnswer(question: Q): void {
    const blockId = opts.blockId()
    if (!blockId) return
    void persist(blockId, question).catch((error) => report(1, error))
  }

  /**
   * Persist every dirty draft on the way out, detached so it can be called from the synchronous
   * close hook. A close-time flush is the one path with no button left on screen to have reported a
   * failure, so it reports the loss itself.
   */
  function flushDrafts(): void {
    const blockId = opts.blockId()
    if (!blockId) return
    const list = [...opts.questions()]
    void (async () => {
      const { failed, cause } = await flushAll(blockId, list)
      if (failed > 0) report(failed, cause)
    })()
  }

  /**
   * Flush every dirty draft, then run a window action, but ONLY if every draft was written: an
   * answer that failed to save may not be submitted as if it were there. On a failure the report is
   * the whole outcome, and the window is left as it is, with the same button on screen and the text
   * still in its box.
   */
  async function flushThen(
    action: (blockId: string) => Promise<unknown>,
    failureTitleKey: string,
  ): Promise<void> {
    const blockId = opts.blockId()
    if (!blockId) return
    const { failed, cause } = await flushAll(blockId, [...opts.questions()])
    if (failed > 0) {
      report(failed, cause)
      return
    }
    // The action rejects too (both backing stores rethrow) and it is reached from a click handler
    // whose promise Vue discards, so its failure is reported here or nowhere.
    await action(blockId).catch((error) => present(error, failureTitleKey))
  }

  return { drafts, addressable, unanswered, saveAnswer, flushDrafts, flushThen }
}
