import {
  frameAllowsVisualPipeline,
  pipelineAllowedForBlockLevel,
  pipelineAllowedForTaskType,
  pipelineRunsVisualStep,
  resolveRunServiceScope,
} from '@cat-factory/contracts'
import type { AgentKind, Block, BlockLevel, Pipeline } from '~/types/domain'

/**
 * Why a step in a preview might NOT run on a given task. A step is unconditional when both are
 * absent, which is the ordinary case.
 *
 *  - `estimate`  — an estimate gate (`gating[i]`): the step runs only on a task the earlier
 *                  `task-estimator` scores above its thresholds.
 *  - `frontend` / `backend` — a run condition (`stepOptions[i].condition`): the step runs only
 *                  where the task changes a service of that kind.
 *
 * They are DISTINCT rather than one `conditional` flag because a reader acts on them differently:
 * an estimate gate is a knob on the pipeline (raise the bar, or clear it), while a service
 * condition is a fact about the task, and nothing about the pipeline will change it.
 */
export type StepConditionKind = 'estimate' | 'frontend' | 'backend'

/** One agent step of a pipeline as shown in a preview: its kind + whether it's a human-gated step. */
export interface PipelineDisplayStep {
  kind: AgentKind
  /** A human approval gate pauses the run after this step (`gates[i]`). */
  gated: boolean
  /** Every reason this step may be skipped on a given task; empty ⇒ it always runs. */
  conditions: StepConditionKind[]
}

/** The reasons the step at `i` may be skipped, in the order a reader meets them. */
export function stepConditionsAt(pipeline: Pipeline, i: number): StepConditionKind[] {
  const conditions: StepConditionKind[] = []
  if (pipeline.gating?.[i]?.enabled) conditions.push('estimate')
  const scope = pipeline.stepOptions?.[i]?.condition?.serviceScope
  if (scope) conditions.push(scope)
  return conditions
}

/**
 * The steps a pipeline preview should render: the ENABLED steps in order (a step disabled by
 * default — `enabled[i] === false` — is skipped at run, so it would misrepresent the pipeline to
 * list it), each flagged when it carries a human approval gate and with every reason it may be
 * skipped on a given task. Companions are included as their own chips, mirroring how the run
 * timeline lists every step.
 *
 * A CONDITIONAL step is listed like any other, and says so, rather than being filtered out: which
 * of them run is a fact about the task, and this preview is read while choosing a pipeline —
 * before there is a task to answer it. Hiding them would understate what the pipeline does; a
 * silent full list would overstate it.
 */
export function pipelineDisplaySteps(pipeline: Pipeline): PipelineDisplayStep[] {
  return pipeline.agentKinds
    .map((kind, i) => ({
      kind,
      enabled: pipeline.enabled?.[i] !== false,
      gated: pipeline.gates?.[i] === true,
      conditions: stepConditionsAt(pipeline, i),
    }))
    .filter((s) => s.enabled)
    .map(({ kind, gated, conditions }) => ({ kind, gated, conditions }))
}

/**
 * The marker each condition renders as: its own icon and its own i18n key. Not one shared
 * "conditional" badge, because the two causes send a reader to different places — an estimate gate
 * is a knob on the pipeline, a service condition is a fact about the task — and a merged badge
 * would name neither. Lives here rather than in a component so the builder library and the picker
 * preview cannot label the same step differently.
 */
export const CONDITION_MARKERS: Record<StepConditionKind, { icon: string; key: string }> = {
  estimate: { icon: 'i-lucide-gauge', key: 'pipeline.preview.conditionEstimate' },
  frontend: { icon: 'i-lucide-monitor', key: 'pipeline.preview.conditionFrontend' },
  backend: { icon: 'i-lucide-server', key: 'pipeline.preview.conditionBackend' },
}

/** How many of a pipeline's displayed steps are conditional (the preview's headline count). */
export function pipelineConditionalCount(pipeline: Pipeline): number {
  return pipelineDisplaySteps(pipeline).filter((s) => s.conditions.length > 0).length
}

/**
 * How many times a run of `pipeline` will stop for a human. Counted off the DISPLAYED steps, not
 * `pipeline.gates`, because a gate declared on a step that is disabled by default gates nothing —
 * that step never runs, so promising a stop there would misstate what the pipeline does.
 */
export function pipelineGateCount(pipeline: Pipeline): number {
  return pipelineDisplaySteps(pipeline).filter((s) => s.gated).length
}

// Re-exported so a picker can import the purpose gates from the same module as the launch/frame
// gates they compose with (the classifiers themselves live in `@cat-factory/contracts`).
export { pipelineAllowedForBlockLevel, pipelineAllowedForTaskType }

// Surface counterpart to the backend's slice-4c run-start gate: a pipeline with a visual step
// (`tester-ui` / `visual-confirmation`) may run only on a frame with a UI to exercise — a
// `frontend` frame, or a frame a `frontend` frame links to. The SPA hides such pipelines from
// the pickers where they can't run so a user never picks one the backend would refuse. Both
// sides share the pure predicates from `@cat-factory/contracts`, so the surface can't drift from
// the gate.

/**
 * Whether `pipeline` may run on a task under `frame`. Allowed when the frame has a UI (see
 * {@link frameAllowsVisualPipeline}), and otherwise only when no visual step would REACH a
 * dispatch there ({@link pipelineRunsVisualStep}). `blocks` is the board's block list, used to
 * find frontend→service links.
 *
 * The two halves mirror run admission, which filters the chain through the run conditions and
 * then gates the survivors on the frame. Asking only "does it list a visual step" hid every
 * build rung from every picker on every non-frontend service the moment the ladder adopted the
 * conditional tester pair: each rung lists a `tester-ui` scoped to `frontend`, which a backend
 * task skips.
 *
 * The scope is derived from the FRAME alone, where the engine also folds in the task's involved
 * services. That cannot disagree here: an involved service is always a non-frontend (a frontend
 * frame has no connection neighbours, see `RunServiceScope`), so it can only ever re-confirm the
 * `backend` half this frame already sets — and on a frontend frame the gate passes on the frame
 * itself. An unresolved frame yields an empty scope, which admits every condition and is then
 * refused by the frame half, exactly as the engine refuses it.
 */
export function pipelineAllowedForFrame(
  pipeline: Pipeline,
  frame: Block | undefined,
  blocks: readonly Block[],
): boolean {
  if (frameAllowsVisualPipeline(frame, blocks)) return true
  return !pipelineRunsVisualStep(pipeline, resolveRunServiceScope(frame ? [frame] : []))
}

// Launch-availability filters, the surface counterpart to the backend's start-origin gate (a
// `'recurring'`-only pipeline can't be started as a one-off manual task, and a `'one-off'`-only
// pipeline can't be attached to a schedule). `availability` absent ⇒ `'both'` (unrestricted), so
// legacy/unset pipelines pass both. Composed with {@link pipelineAllowedForFrame} at each picker.

/**
 * Whether `pipeline` may be started as a MANUAL one-off task run (the board/inspector Run menus,
 * the add-task modal, the task run-settings default). Excludes, in turn:
 *
 *  - `'recurring'`-only pipelines the backend would refuse;
 *  - visual pipelines on a frame with no UI;
 *  - pipelines whose `purpose` doesn't fit the given `taskType` (a `document` task offers only
 *    document pipelines; a `bug` task build + bugfix + research ones, and a `feature` the same
 *    minus the bugfix presets, which have no defect report to work from);
 *  - pipelines whose `purpose` doesn't fit the given `blockLevel` (planning pipelines run only on
 *    an initiative block, and an initiative block runs only those).
 *
 * `taskType` / `blockLevel` omitted ⇒ that restriction is not applied, so an un-typed context still
 * shows everything.
 */
export function pipelineAllowedForManualStart(
  pipeline: Pipeline,
  frame: Block | undefined,
  blocks: readonly Block[],
  taskType?: Block['taskType'],
  blockLevel?: BlockLevel,
): boolean {
  return (
    pipeline.availability !== 'recurring' &&
    pipelineAllowedForFrame(pipeline, frame, blocks) &&
    pipelineAllowedForTaskType(pipeline, taskType) &&
    pipelineAllowedForBlockLevel(pipeline, blockLevel)
  )
}

/**
 * Whether `pipeline` may be attached to a RECURRING schedule (the recurring-pipeline modal).
 * Excludes `'one-off'`-only pipelines the backend would refuse, visual pipelines on a frame with no
 * UI, and the planning presets.
 *
 * The block-level gate applies here for the same reason it applies to a manual start, and it is
 * keyed to `'task'` because a schedule seeds a `level: 'task'` block under its frame on every fire
 * (`RecurringPipelineService`). The planning presets carry no `availability`, so nothing else keeps
 * them out of this picker — and a schedule the engine refuses is WORSE than a manual start it
 * refuses: it fires unattended, so nobody sees the error and the work simply never happens.
 */
export function pipelineAllowedForSchedule(
  pipeline: Pipeline,
  frame: Block | undefined,
  blocks: readonly Block[],
): boolean {
  return (
    pipeline.availability !== 'one-off' &&
    pipelineAllowedForFrame(pipeline, frame, blocks) &&
    pipelineAllowedForBlockLevel(pipeline, 'task')
  )
}
