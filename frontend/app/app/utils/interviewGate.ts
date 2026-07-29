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
 *  - `preparing` — the run is working on an EARLIER step; the interview has not begun.
 *  - `working` — an interviewer pass is running; the human waits.
 *  - `awaiting` — the run is parked on the human's answers.
 *  - `converged` — the interview settled; the run moved on.
 *  - `failed` — the run stopped before the interview settled.
 */
export type InterviewGatePhase =
  | 'idle'
  | 'preparing'
  | 'working'
  | 'awaiting'
  | 'converged'
  | 'failed'

/**
 * The agent kind of each gate's own step, which is what {@link interviewStepReached} locates in the
 * run's chain. Kept here beside the phase they feed rather than inline at each window, so the two
 * surfaces can't drift onto different spellings of the same step.
 */
export const INITIATIVE_INTERVIEWER_KIND = 'initiative-interviewer'
export const DOC_INTERVIEWER_KIND = 'doc-interviewer'

/**
 * Whether the run has REACHED the interview gate's own step — i.e. whether a running run is
 * running the interviewer, or something ahead of it.
 *
 * Neither gate leads its pipeline: `pl_initiative` explores the codebase first, and the document
 * pipeline researches and outlines first. Without this the whole of that lead-in reads as
 * `working`, so the window claims an interviewer pass is chewing on answers the human has not
 * given yet — for however long a container step takes.
 *
 * Degrades to `true` (today's reading, no `preparing` claim) when the run is not cached yet or the
 * chain carries no such step: a phase that over-reports "we are still preparing" would leave a
 * genuinely-parked interview looking dormant, which is worse than the copy being generic.
 */
export function interviewStepReached(
  run: Pick<ExecutionInstance, 'steps' | 'currentStep'> | undefined,
  agentKind: string,
): boolean {
  if (!run) return true
  const index = run.steps.findIndex((step) => step.agentKind === agentKind)
  return index < 0 || index <= run.currentStep
}

/**
 * Resolve the phase from the interview entity's status, its run's status, and whether the run has
 * reached the interview step ({@link interviewStepReached}).
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
 * `stepReached` splits that running window in two, because "a pass is in flight" and "your turn is
 * still coming" are different things to be told and the difference is minutes long. It is a
 * REQUIRED argument rather than an optional one: a caller that omitted it would silently get the
 * misleading half, which is the bug this exists to fix.
 *
 * `converged` wins over `failed` on purpose: once the interview settled, a later failure belongs
 * to the step that failed (the planner, the writer), and the block's own failure surface reports
 * it — the interview window claiming the interview broke would be wrong.
 */
export function interviewGatePhase(
  status: 'awaiting' | 'done' | undefined,
  runStatus: ExecutionInstance['status'] | undefined,
  stepReached: boolean,
): InterviewGatePhase {
  if (status === 'done') return 'converged'
  if (runStatus === 'failed') return 'failed'
  // Before `status === 'awaiting'`: on a re-plan the entity still carries the PREVIOUS run's
  // questions until the gate's `resetForFreshRun` fires, which now happens after the lead-in
  // steps. Reading those as "awaiting your answers" would invite a human to answer a round that
  // is about to be discarded.
  if (runStatus === 'running') return stepReached ? 'working' : 'preparing'
  if (status === 'awaiting') return 'awaiting'
  return 'idle'
}
