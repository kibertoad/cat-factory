import type { ExecutionInstance, PipelineStep } from './execution.js'

/**
 * The board snapshot's LEAN EXECUTION PROJECTION.
 *
 * A board load (and every full refresh behind it) carries every run in the workspace. The heavy
 * half of a run is captured TEXT: the agent's prose per step, the prose a restart superseded, the
 * proposal a reviewer bounced, and the tester-quality assessor's per-attempt verdicts. None of it
 * is rendered on the board or in the inspector; all of it is read in a step-detail overlay a human
 * opens one run at a time. On an active board that text dominates snapshot bytes, valibot parse
 * time and store hydration, paid on every refresh, for prose nobody is looking at.
 *
 * So the wire snapshot serves this projection and the overlays fetch the whole run by id.
 *
 * WITHHELD is not ABSENT. Every consumer of a projected instance has to be able to tell "this run
 * produced no prose" from "this read did not carry it", so the projection states itself: the
 * instance is stamped {@link ExecutionInstance.projected}, and `output` (the one withheld field
 * the board still asks a question about) leaves {@link PipelineStep.hasOutput} behind in its
 * place. Ask through {@link stepHasOutput}, never through either field alone.
 *
 * WHAT STAYS. `custom` (a registered kind's structured result) is read off the environment
 * wizard's analyst step and the inspector's merger decision, neither of which is an overlay, and
 * it is structured JSON rather than prose. `judge` / `ralph` / `validation` / `reproduction` /
 * `prReview` carry bounded histories and drive park ROUTING (`dedicatedParkView`) on the board
 * itself. Both are future slices; adding one means moving its board reads first, not just adding
 * a key here.
 */
export function projectExecutionForBoard(instance: ExecutionInstance): ExecutionInstance {
  const { outputHistory: _outputHistory, ...rest } = instance
  return {
    ...rest,
    projected: true,
    steps: instance.steps.map(projectStepForBoard),
  }
}

function projectStepForBoard(step: PipelineStep): PipelineStep {
  const { output, rework: _rework, testerQuality: _testerQuality, ...rest } = step
  return output === undefined ? rest : { ...rest, hasOutput: output.length > 0 }
}

/**
 * Whether the step produced prose a reader can open: the board/inspector affordance, answered
 * identically on a whole run (`output` is present) and on a projection (`output` is withheld and
 * `hasOutput` stands in its place). Reading `step.output` alone silently drops the affordance on
 * every projected run; reading `hasOutput` alone drops it on every full one.
 */
export function stepHasOutput(step: Pick<PipelineStep, 'output' | 'hasOutput'>): boolean {
  return step.output !== undefined ? step.output.length > 0 : (step.hasOutput ?? false)
}
