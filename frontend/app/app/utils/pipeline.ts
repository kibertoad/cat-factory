import {
  frameAllowsVisualPipeline,
  pipelineAllowedForBlockLevel,
  pipelineAllowedForTaskType,
  pipelineHasVisualStep,
} from '@cat-factory/contracts'
import type { AgentKind, Block, BlockLevel, Pipeline } from '~/types/domain'

/** One agent step of a pipeline as shown in a preview: its kind + whether it's a human-gated step. */
export interface PipelineDisplayStep {
  kind: AgentKind
  /** A human approval gate pauses the run after this step (`gates[i]`). */
  gated: boolean
}

/**
 * The steps a pipeline preview should render: the ENABLED steps in order (a step disabled by
 * default — `enabled[i] === false` — is skipped at run, so it would misrepresent the pipeline to
 * list it), each flagged when it carries a human approval gate. Companions are included as their
 * own chips, mirroring how the run timeline lists every step.
 */
export function pipelineDisplaySteps(pipeline: Pipeline): PipelineDisplayStep[] {
  return pipeline.agentKinds
    .map((kind, i) => ({
      kind,
      enabled: pipeline.enabled?.[i] !== false,
      gated: pipeline.gates?.[i] === true,
    }))
    .filter((s) => s.enabled)
    .map(({ kind, gated }) => ({ kind, gated }))
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
 * Whether `pipeline` may run on a task under `frame`. A non-visual pipeline is always allowed;
 * a visual one only when the frame has a UI (see {@link frameAllowsVisualPipeline}). `blocks` is
 * the board's block list, used to find frontend→service links.
 */
export function pipelineAllowedForFrame(
  pipeline: Pipeline,
  frame: Block | undefined,
  blocks: readonly Block[],
): boolean {
  return !pipelineHasVisualStep(pipeline) || frameAllowsVisualPipeline(frame, blocks)
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
 *    document pipelines; a `feature`/`bug` task only build + research ones);
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
