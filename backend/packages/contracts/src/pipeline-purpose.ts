import * as v from 'valibot'
import type { AgentCategory } from './agent-presentation.js'
import type { Pipeline } from './entities.js'
import type { TaskType } from './primitives.js'

/**
 * The USE-CASE of a pipeline — what kind of work it exists to do. Chosen in the pipeline
 * builder and stamped on every built-in preset, it is the classifier the SPA filters on:
 *
 *   - `build`      — produces or changes application code (the default for engineering
 *                    pipelines: full builds, bug fixes, refactors, dependency updates, …).
 *   - `document`   — authors or updates documentation (a PRD/RFC/runbook, business rules, …);
 *                    a `document` task offers ONLY these.
 *   - `review`     — reviews existing code / a pull request and reports findings; writes no code.
 *   - `research`   — timeboxed investigation / analysis that delivers findings (a spike, an
 *                    environment analysis).
 *   - `planning`   — decomposes and plans an initiative (no code, no repo write of its own).
 *
 * A non-`build` purpose hides the Implementation/Testing agent kinds in the builder
 * ({@link purposeAllowsAgentCategory}) and scopes the pipeline in the task pickers
 * ({@link pipelineAllowedForTaskType}). The `Pipeline.purpose` field references this schema.
 */
export const PIPELINE_PURPOSES = ['build', 'document', 'review', 'research', 'planning'] as const
export const pipelinePurposeSchema = v.picklist(PIPELINE_PURPOSES)
export type PipelinePurpose = v.InferOutput<typeof pipelinePurposeSchema>

// ---------------------------------------------------------------------------
// Pipeline-purpose gating (shared by the SPA pickers + the builder palette).
//
// A pipeline's `purpose` (see `PIPELINE_PURPOSES` in entities) is its use-case
// classifier — set in the builder, stamped on every built-in preset. Two surfaces
// key off it, and both share these pure predicates so they can't drift:
//   - the task pickers: a `document` task authors a document, so it is offered ONLY
//     `purpose: 'document'` pipelines (a build/test pipeline makes no sense for it);
//   - the builder palette: a non-`build` pipeline writes no product code and runs no
//     tests, so the Implementation (`build`) and Testing (`test`) agent kinds are hidden.
//
// An absent `purpose` means UNCLASSIFIED (a legacy/custom pipeline never given one):
// treated as `build` for the palette (unrestricted) and hidden from a `document` task
// (which requires the explicit classifier), rather than silently narrowing everything.
// ---------------------------------------------------------------------------

/** The agent-palette categories hidden from a non-`build` pipeline (writes no code, runs no tests). */
const NON_BUILD_HIDDEN_CATEGORIES: readonly AgentCategory[] = ['build', 'test']

/**
 * Whether a pipeline of `purpose` may use an agent kind in `category` — the builder palette
 * gate. A `build` (or unclassified) pipeline may use anything; every other purpose hides the
 * Implementation (`build`) and Testing (`test`) categories. Uncategorized kinds (no
 * `category`) are always allowed — the caller shows them regardless.
 */
export function purposeAllowsAgentCategory(
  purpose: Pipeline['purpose'] | null | undefined,
  category: AgentCategory,
): boolean {
  if (!purpose || purpose === 'build') return true
  return !NON_BUILD_HIDDEN_CATEGORIES.includes(category)
}

/**
 * Whether `pipeline` should be offered when starting a task of `taskType` — the pickers' gate.
 * A `document` task authors a document and a `review` task reviews an existing PR, so each narrows
 * the set to ONLY its matching purpose (`document` / `review`): every other pipeline writes/ships
 * code, which is meaningless for those tasks. Every OTHER task type (and an undefined `taskType`) is
 * unrestricted. A pipeline with no `purpose` is therefore hidden from a document/review task (it
 * requires the explicit classifier) and shown for every other. Composed with the launch-availability
 * / visual-frame filters at each picker.
 */
export function pipelineAllowedForTaskType(
  pipeline: Pick<Pipeline, 'purpose'>,
  taskType: TaskType | undefined,
): boolean {
  if (taskType === 'document') return pipeline.purpose === 'document'
  if (taskType === 'review') return pipeline.purpose === 'review'
  return true
}
