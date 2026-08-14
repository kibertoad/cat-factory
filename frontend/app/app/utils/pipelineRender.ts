// Shared rendering helpers for the run-step / pipeline views (PipelineProgress,
// TaskPipelineMini, AgentStepDetail), so the "is this step still live?" logic stays
// in one place rather than being re-derived as inline ternaries per component.

import type {
  AgentState,
  ExecutionInstance,
  ExecutionStatus,
  PipelineStep,
} from '~/types/execution'
import { isStepSkipReason } from '@cat-factory/contracts'

/**
 * Whether the engine is presently DRIVING this run, which is the one condition under which
 * infrastructure can still be moving (a container cold-booting, an environment coming up or
 * being torn down, a fresh provisioning attempt landing in the log).
 *
 * `running` is that condition and nothing else is. `done`/`failed` are terminal, and the other
 * two are parks where the durable driver is asleep on an event: `blocked` waits on a human
 * decision, `paused` on a spend budget that has to be raised. A parked run holds whatever infra
 * state it stopped at, so nothing about it is in flight.
 *
 * This is what every ANIMATED infra indicator is gated on. A spinner is a claim that something is
 * happening right now, so a container left `starting` or an environment left `provisioning` when
 * its run stopped must keep its label (that IS the last thing the provider reported) and stop
 * turning: the run's own status says why it stopped, and a perpetual spinner over a run nobody is
 * driving reads as a live cold-boot that is simply taking a while. The same rule governs the
 * infra-attempts drawer's background poll, which has nothing to re-read off a parked run.
 *
 * The step-level sibling is `stepIsRunning` (`useStepTimer`), which answers the narrower question
 * of whether one step's clock should tick; this one is about the run as a whole.
 */
export function runIsActive(status: ExecutionStatus | null | undefined): boolean {
  return status === 'running'
}

/**
 * Visual state of a conditionally-run companion attached to a gate step (today the
 * Tester's `fixer`): it MIGHT run (`possible`), is running now (`running`), ran at
 * least once (`completed`), the gate passed without ever needing it (`skipped`), or
 * it was mid-run when the pipeline failed and gave up (`failed`).
 */
export type CompanionState = 'possible' | 'running' | 'completed' | 'skipped' | 'failed'

/**
 * Visual language for a step (or its companion) that was left `working` when its
 * run failed. A failed mid-flight step is NOT live — it should read as "Failed" with
 * a red cross, never a frozen/spinning loader or a misleading "Working" label.
 */
export const FAILED_STEP_META = {
  label: 'Failed',
  color: '#ef4444',
  icon: 'i-lucide-circle-x',
} as const

/**
 * Whether a step left in `working` state should be rendered as failed: it never
 * finished, and its run has terminated as `failed`, so the engine gave up on it.
 */
export function isFailedStep(state: AgentState, runFailed: boolean): boolean {
  return runFailed && state === 'working'
}

/** Descriptor for the companion node a gate step renders beneath itself. */
export interface GateCompanion {
  /** Agent kind of the companion (resolved through `agentKindMeta` for icon/label). */
  kind: string
  state: CompanionState
}

/** Display metadata per companion state (badge label + Tailwind colour classes). */
export const COMPANION_STATE_META: Record<
  CompanionState,
  { label: string; dot: string; text: string; icon: string }
> = {
  possible: {
    label: 'May run',
    dot: 'border-slate-600 bg-slate-800/40',
    text: 'text-slate-400',
    icon: 'i-lucide-circle-dashed',
  },
  running: {
    label: 'Running',
    dot: 'border-amber-400 bg-amber-500/20',
    text: 'text-amber-300',
    icon: 'i-lucide-loader',
  },
  completed: {
    label: 'Ran',
    dot: 'border-emerald-500 bg-emerald-500/20',
    text: 'text-emerald-300',
    icon: 'i-lucide-circle-check',
  },
  skipped: {
    label: 'Skipped',
    dot: 'border-slate-700 bg-slate-800/40',
    text: 'text-slate-500',
    icon: 'i-lucide-circle-slash',
  },
  failed: {
    label: 'Gave up',
    dot: 'border-rose-500 bg-rose-500/20',
    text: 'text-rose-400',
    icon: 'i-lucide-circle-x',
  },
}

/**
 * The conditionally-run companion (if any) a gate step drives, with its current
 * state — so the pipeline views can render it as a distinct sub-node marked
 * possible / running / completed / skipped. The Tester's `fixer` loop is modelled via
 * `step.test`; the polling gates (`ci` → `ci-fixer`, `conflicts` → `conflict-resolver`)
 * via `step.gate`, which all share the same possible/running/completed/skipped shape.
 */
export function gateCompanionFor(step: PipelineStep, runFailed = false): GateCompanion | null {
  if (step.agentKind === 'tester-api' || step.agentKind === 'tester-ui') {
    const attempts = step.test?.attempts ?? 0
    if (step.state === 'done') {
      // The gate finished: it ran the fixer iff it ever dispatched one.
      return { kind: 'fixer', state: attempts > 0 ? 'completed' : 'skipped' }
    }
    // A fixer caught mid-loop by a failed run gave up, not "running".
    if (step.test?.phase === 'fixing')
      return { kind: 'fixer', state: runFailed ? 'failed' : 'running' }
    if (attempts > 0) return { kind: 'fixer', state: 'completed' }
    // Pending, or testing with no attempt yet — the fixer might still be needed.
    return { kind: 'fixer', state: 'possible' }
  }
  const helper =
    step.agentKind === 'ci'
      ? 'ci-fixer'
      : step.agentKind === 'conflicts'
        ? 'conflict-resolver'
        : null
  if (helper) {
    const attempts = step.gate?.attempts ?? 0
    if (step.state === 'done') {
      // The gate passed: it ran the helper iff it ever dispatched one.
      return { kind: helper, state: attempts > 0 ? 'completed' : 'skipped' }
    }
    // A helper (ci-fixer / conflict-resolver) caught mid-run when the gate exhausted
    // its attempt budget and the run failed gave up — never show it as "running".
    if (step.gate?.phase === 'working')
      return { kind: helper, state: runFailed ? 'failed' : 'running' }
    if (attempts > 0) return { kind: helper, state: 'completed' }
    // Checking the precheck with no escalation yet — the helper might still be needed.
    return { kind: helper, state: 'possible' }
  }
  return null
}

/**
 * Whether an agent kind is a companion of a producer step (the quality companions
 * that grade-and-loop, plus the Tester's `fixer`). Used to give companion steps a
 * visually distinct treatment in the pipeline.
 */
export function isCompanionKind(kind: string): boolean {
  return (
    kind === 'reviewer' ||
    kind === 'architect-companion' ||
    kind === 'spec-companion' ||
    kind === 'fixer'
  )
}

/**
 * The parks a surface must NOT answer with the generic approve rail, named so the tables below
 * and every consumer can be keyed exhaustively by them rather than by a string.
 */
export type DedicatedParkView = 'follow-ups' | 'fork-decision' | 'binary-candidates' | 'input-gate'

/**
 * The dedicated window that owns a step's approval park, when the park is NOT a generic
 * prose approval: the implementation-fork window while a coder waits on (or chats about)
 * an approach choice, the follow-up triage window while surfaced items are undecided, or the
 * candidate-comparison window while a generating step waits on which candidates survive.
 * The generic approve/request-changes/reject resolvers deliberately refuse these parks
 * server-side (`assertNotIterativeGate`), so every surface that offers a step's pending
 * approval must route these to their window instead of the generic "Approve & proceed"
 * rail — which would blink a 409 and resolve nothing.
 *
 * `input-gate` is the odd one out: it is resolved by an inline NOTICE rather than an overlay,
 * because its remedy is to go and edit the task, which is a board action rather than something
 * a modal could hold.
 */
export function dedicatedParkView(
  step: PipelineStep,
  instance: ExecutionInstance | null | undefined,
): DedicatedParkView | null {
  // The PRE-DISPATCH INPUT GATE parks whatever step 0 happens to be, so it leaves nothing on the
  // STEP to recognise it by: its verdict is a fact about the RUN. Checked first, and off the
  // instance: approving it generically would mark the run's first working step done and skip
  // the work the run exists to do.
  //
  // `instance` is REQUIRED, and nullable rather than optional on purpose. Every park surface has
  // the run in hand, and an optional parameter is how one of them silently stops passing it: the
  // function would go on returning `null` for a gate-parked step, which each caller reads as
  // "the generic approve rail applies" — the exact 409-blinking rail this exists to prevent.
  // It still ACCEPTS an absent run (a store lookup that has not resolved), because that is a real
  // state a caller has to be able to express; what it does not accept is not being asked.
  if (instance?.inputGate?.status === 'blocked' && step.approval?.status === 'pending') {
    return 'input-gate'
  }
  // The fork park sits BEFORE the coder's build dispatch; `answering` (a chat turn in
  // flight) still belongs to the fork window, which renders the pending reply.
  const fork = step.forkDecision?.status
  if (fork === 'awaiting_choice' || fork === 'answering') return 'fork-decision'
  // A generating step parked between its candidate pass and its delivering pass. Approving it
  // generically would mark a step done that has staged files and delivered nothing.
  if (step.binaryCandidates?.status === 'awaiting_choice') return 'binary-candidates'
  // Follow-ups only own the park itself: while the coder is still WORKING (streaming
  // items, no approval raised) a step click should keep opening the ordinary detail.
  if (
    step.approval?.status === 'pending' &&
    step.followUps?.enabled &&
    step.followUps.items.some((i) => i.status === 'pending')
  ) {
    return 'follow-ups'
  }
  return null
}

/**
 * The parks a dedicated WINDOW answers: every member of {@link DedicatedParkView} except the
 * pre-dispatch input gate, which is answered by an inline notice because its remedy is to go and
 * edit the task.
 */
export type RedirectParkView = Exclude<DedicatedParkView, 'input-gate'>

/** How a redirect park presents itself on a surface that has to send a human to its window. */
export interface RedirectParkPresentation {
  icon: string
  /** Prose explaining why the generic approve rail is not offered here. */
  noticeKey: string
  /** The label on the step overlay's redirect button, which has room for a full phrase. */
  actionKey: string
  /**
   * The label on the inspector's compact action rail. A separate key rather than a reuse of
   * {@link actionKey}: that rail sits in a list of one-line step rows and words the same action
   * more tersely, and collapsing the two would silently restyle copy that is already shipped.
   */
  railActionKey: string
}

/**
 * What each redirect park LOOKS like, in one exhaustive table.
 *
 * A `Record` over the vocabulary rather than a ternary at each of the three surfaces that render
 * one (the step overlay's redirect notice, the pipeline chip, the inspector's action rail),
 * because a ternary has no arm for a member it has never heard of: adding `binary-candidates` to
 * {@link dedicatedParkView} left every one of those surfaces rendering the FORK's copy and icon
 * for it, which is worse than rendering nothing: it names the wrong decision, and the surfaces
 * kept compiling and kept passing. Keyed this way, a new park fails the build here until it says
 * how it presents itself, and each surface picks the entry up with no edit of its own.
 *
 * Presentation only. WHICH window opens is the caller's, because the openers differ in what they
 * need to resolve, and a park with no window (`input-gate`) is excluded from the type entirely
 * rather than carrying null fields nobody may read.
 */
export const REDIRECT_PARK_PRESENTATION: Record<RedirectParkView, RedirectParkPresentation> = {
  'follow-ups': {
    icon: 'i-lucide-compass',
    noticeKey: 'panels.stepDetail.followUpsParked',
    actionKey: 'panels.stepDetail.openFollowUps',
    railActionKey: 'inspector.execution.triageFollowUps',
  },
  'fork-decision': {
    icon: 'i-lucide-git-fork',
    noticeKey: 'panels.stepDetail.forkParked',
    actionKey: 'panels.stepDetail.chooseApproach',
    railActionKey: 'inspector.execution.chooseApproach',
  },
  'binary-candidates': {
    icon: 'i-lucide-images',
    noticeKey: 'panels.stepDetail.candidatesParked',
    actionKey: 'panels.stepDetail.chooseCandidates',
    railActionKey: 'inspector.execution.chooseCandidates',
  },
}

/**
 * The friendly label for a container's live phase (clone → "Preparing workspace",
 * agent → "Agent running", …), falling back to the raw phase string for an unknown/new
 * phase (the phase vocabulary is harness-controlled and open-ended). `null` when there's
 * no phase to show. Kept here so the three views that render it (the step-detail card,
 * the inspector label, the board node) resolve it identically rather than re-deriving the
 * key + `te()`-fallback inline. `t`/`te` are passed in since this is a pure util, not a
 * composable.
 */
export function containerPhaseLabel(
  phase: string | null | undefined,
  i18n: { t: (key: string) => string; te: (key: string) => boolean },
): string | null {
  if (!phase) return null
  const key = `panels.stepMeta.container.phase.${phase}`
  return i18n.te(key) ? i18n.t(key) : phase
}

/**
 * The i18n key naming WHY a skipped step was skipped, or null when the step ran.
 *
 * The engine records a machine-readable {@link StepSkipReason} rather than a sentence, so the
 * sentence is composed here where it can be translated. The `condition` case narrows further off
 * the step's own `stepOptions.condition.serviceScope` — the condition stays on the step, so the
 * copy and the scope it names are read from one place and cannot drift.
 *
 * An UNRECOGNISED reason (a stored run naming a member this bundle no longer knows, or a browser
 * older than the member it reads) falls back to the bare "skipped" line rather than rendering
 * nothing or guessing onto a current member: what a reader must not lose is that the step did not
 * run. A `skipped` step with NO reason is the same case — runs predating the field.
 */
export function stepSkipReasonKey(step: PipelineStep): string | null {
  if (!step.skipped) return null
  if (!isStepSkipReason(step.skipReason)) return 'pipeline.progress.skipped.unknown'
  switch (step.skipReason) {
    case 'gated':
      return 'pipeline.progress.skipped.gated'
    case 'producer_skipped':
      return 'pipeline.progress.skipped.producerSkipped'
    case 'run_complete':
      return 'pipeline.progress.skipped.runComplete'
    case 'condition':
      return step.stepOptions?.condition?.serviceScope === 'frontend'
        ? 'pipeline.progress.skipped.conditionFrontend'
        : 'pipeline.progress.skipped.conditionBackend'
    default:
      return describeUnhandledSkipReason(step.skipReason)
  }
}

/**
 * The `never` sink that keeps {@link stepSkipReasonKey}'s switch total: adding a member to
 * `stepSkipReasonSchema` fails the build here until it has copy, while the runtime narrowing above
 * still renders a RETIRED member honestly.
 */
function describeUnhandledSkipReason(reason: never): string {
  void reason
  return 'pipeline.progress.skipped.unknown'
}

/**
 * Tailwind classes for a subtask-item status icon. An in-progress item spins only
 * while the run is live: once the run has failed, a step left mid-flight (its item
 * state still `in_progress`) keeps its colour but stops spinning, matching the frozen
 * failure card. Completed items are emerald, everything else muted.
 */
export function subtaskIconClass(status: string, runFailed: boolean): string[] {
  return [
    status === 'in_progress'
      ? runFailed
        ? 'text-indigo-400'
        : 'animate-spin text-indigo-400'
      : '',
    status === 'completed' ? 'text-emerald-400' : 'text-slate-500',
  ]
}
