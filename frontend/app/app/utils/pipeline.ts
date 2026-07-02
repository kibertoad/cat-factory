import { frameAllowsVisualPipeline, pipelineHasVisualStep } from '@cat-factory/contracts'
import type { Block, Pipeline } from '~/types/domain'

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
