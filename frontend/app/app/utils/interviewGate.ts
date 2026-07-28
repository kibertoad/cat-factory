import type { ExecutionInstance } from '~/types/domain'

// The frontend dual of the backend's shared `InterviewGateController` spine. Both interview gates
// — the initiative-planning interviewer and the document interviewer — park their run on a
// decision-wait, expose the SAME `awaiting | done` status on their entity, and resume the same
// way, so how their windows read "what is happening right now" is shared vocabulary rather than
// two copies. See `docs/initiatives/clarification-items.md`.

/**
 * What an interview gate is doing right now, from the human's point of view. Drives the interview
 * window's body AND (for the initiative) the card/inspector affordances, so the surfaces can't
 * disagree about whether there is anything to answer.
 *
 *  - `idle` — the interview has not run yet (nothing to answer, nothing in flight).
 *  - `working` — an interviewer pass is running; the human waits.
 *  - `awaiting` — the run is parked on the human's answers.
 *  - `converged` — the interview settled; the run moved on.
 *  - `failed` — the run stopped before the interview settled.
 */
export type InterviewGatePhase = 'idle' | 'working' | 'awaiting' | 'converged' | 'failed'

/**
 * Resolve the phase from the interview entity's status AND its run's status.
 *
 * The RUN status is load-bearing, not redundant. Continue/proceed are ASYNC by design: the HTTP
 * call only records the intent on the parked step and wakes the durable driver, which then runs
 * the (slow) interviewer LLM — so the response carries the PRE-resume entity, with the same
 * questions and the same `awaiting` status. Keyed on the entity alone a window is therefore
 * byte-identical before and after the click, which is indistinguishable from the button doing
 * nothing for however long the pass takes. A resumed run flips `blocked` → `running` and emits,
 * so `running` while the interview is unsettled is exactly "a pass is in flight".
 *
 * Deriving this from the run rather than a local in-flight flag also survives a reload and cannot
 * wedge: a pass that FAILS takes the run to `failed`, so the window drops out of `working` and
 * says so instead of spinning forever. An unknown run (no instance cached yet) degrades to the
 * entity-only reading, never to a spinner.
 *
 * `converged` wins over `failed` on purpose: once the interview settled, a later failure belongs
 * to the step that failed (the analyst/planner, the writer), and the block's own failure surface
 * reports it — the interview window claiming the interview broke would be wrong.
 */
export function interviewGatePhase(
  status: 'awaiting' | 'done' | undefined,
  runStatus: ExecutionInstance['status'] | undefined,
): InterviewGatePhase {
  if (status === 'done') return 'converged'
  if (runStatus === 'failed') return 'failed'
  if (runStatus === 'running') return 'working'
  if (status === 'awaiting') return 'awaiting'
  return 'idle'
}
