import * as v from 'valibot'
import type { AgentCategory } from './agent-presentation.js'
import type { Pipeline } from './entities.js'
import type { BlockLevel, TaskType } from './primitives.js'

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
 * The purposes a PROGRAMMATIC task (`feature` / `bug`) may be offered. It ships code, so a
 * `document` or `review` pipeline is meaningless for it — the reverse of the narrowing those task
 * types already got. `research` is included because reaching for a spike before committing to an
 * approach is a legitimate move on a feature someone has not yet scoped; `planning` is not, being
 * initiative-level work that the block-level gate refuses anyway.
 */
const PROGRAMMATIC_PURPOSES: readonly PipelinePurpose[] = ['build', 'research']

/**
 * Whether `pipeline` should be offered when starting a task of `taskType` — the pickers' gate.
 *
 * Each built-in task type narrows to the purposes that can actually do its work:
 *
 *  - `document` → only `document` pipelines (it authors a document; nothing else applies).
 *  - `review` → only `review` pipelines (it reviews an existing PR and opens none).
 *  - `feature` / `bug` → `build` + `research` ({@link PROGRAMMATIC_PURPOSES}). These ship code, so
 *    offering them a document-authoring or PR-review preset was noise in the one picker people use
 *    most.
 *  - anything else, including a CUSTOM (namespaced) type and an undefined `taskType`, is
 *    unrestricted — a deployment's own task type has no purpose mapping we could infer.
 *
 * A pipeline with no `purpose` is UNCLASSIFIED and therefore hidden from every narrowed type: the
 * narrowing requires the explicit classifier rather than guessing. Composed with the
 * launch-availability / block-level / visual-frame filters at each picker.
 */
export function pipelineAllowedForTaskType(
  pipeline: Pick<Pipeline, 'purpose'>,
  taskType: TaskType | undefined,
): boolean {
  if (taskType === 'document') return pipeline.purpose === 'document'
  if (taskType === 'review') return pipeline.purpose === 'review'
  if (taskType === 'feature' || taskType === 'bug') {
    return pipeline.purpose !== undefined && PROGRAMMATIC_PURPOSES.includes(pipeline.purpose)
  }
  return true
}

/**
 * Whether `pipeline` may run on a block at `blockLevel` — the surface counterpart to the engine's
 * BIDIRECTIONAL initiative guard (`assertInitiativeShapeAllowed`): a planning pipeline may only
 * start on an `initiative` block, and an initiative block accepts only a planning pipeline.
 *
 * Without this the three planning presets were offered on every ordinary task and then REFUSED at
 * start with a 409 — the worst failure shape, since the user has already chosen before learning it
 * cannot run.
 *
 * Keyed on `purpose: 'planning'` rather than on the initiative AGENT KINDS the engine tests, because
 * the SPA cannot see the kernel's kind vocabulary (it depends on `@cat-factory/contracts` only) —
 * and because a purpose is the more general classifier: a deployment's own planning pipeline is
 * filtered correctly even if it uses kinds this repo has never heard of. For the built-in catalog
 * the two coincide, and a kernel drift guard (`seed.test.ts`) pins that they keep coinciding.
 *
 * `blockLevel` undefined ⇒ unrestricted (an un-typed context shows everything).
 */
export function pipelineAllowedForBlockLevel(
  pipeline: Pick<Pipeline, 'purpose'>,
  blockLevel: BlockLevel | undefined,
): boolean {
  if (blockLevel === undefined) return true
  if (blockLevel === 'initiative') return pipeline.purpose === 'planning'
  return pipeline.purpose !== 'planning'
}
