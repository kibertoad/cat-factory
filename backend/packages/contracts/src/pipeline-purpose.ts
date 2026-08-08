import * as v from 'valibot'
import { type AgentCategory, isAgentCategory } from './agent-presentation.js'
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
 * ({@link purposeAllowsAgentCategory}), narrows what its palette offers
 * ({@link purposeSuggestsAgentCategory}) and its saved-pipeline library lists
 * ({@link pipelineMatchesPurpose}), and scopes the pipeline in the task pickers
 * ({@link pipelineAllowedForTaskType}). The `Pipeline.purpose` field references this schema.
 */
export const PIPELINE_PURPOSES = ['build', 'document', 'review', 'research', 'planning'] as const
export const pipelinePurposeSchema = v.picklist(PIPELINE_PURPOSES)
export type PipelinePurpose = v.InferOutput<typeof pipelinePurposeSchema>

const PIPELINE_PURPOSE_SET: ReadonlySet<string> = new Set(pipelinePurposeSchema.options)

/**
 * Whether a value is a purpose THIS BUILD knows, DERIVED from the picklist for the same reason
 * {@link isAgentCategory} is: the vocabulary is closed but PERSISTED, on `Pipeline.purpose`, so a
 * member retired from the union goes on living in stored rows and in the SPA bundle a browser
 * cached before a new member shipped. Narrow with this before indexing anything by a purpose.
 */
export function isPipelinePurpose(value: string): value is PipelinePurpose {
  return PIPELINE_PURPOSE_SET.has(value)
}

// ---------------------------------------------------------------------------
// Pipeline-purpose gating (shared by the SPA pickers + the builder palette).
//
// A pipeline's `purpose` (see `PIPELINE_PURPOSES` in entities) is its use-case
// classifier, set in the builder and stamped on every built-in preset. Four surfaces
// key off it, and all share these pure predicates so they can't drift:
//   - the task pickers: a `document` task authors a document, so it is offered ONLY
//     `purpose: 'document'` pipelines (a build/test pipeline makes no sense for it);
//   - the builder palette, which offers only the categories the purpose makes sense of
//     ({@link purposeSuggestsAgentCategory});
//   - the builder's saved-pipeline library, which lists the pipelines built for the
//     purpose being edited ({@link pipelineMatchesPurpose});
//   - the builder's save gate, which refuses a draft holding a step the purpose is
//     INCOMPATIBLE with ({@link purposeAllowsAgentCategory}).
//
// The palette and the save gate are deliberately different questions. RELEVANCE narrows
// a catalog of ~30 kinds to the ones worth offering, and is free to be opinionated
// because a wrong guess costs one purpose switch. COMPATIBILITY blocks a save, so it
// states only what is actually contradictory (a pipeline that writes no code carrying
// an implementation step), or tightening the relevance table would make somebody's
// stored pipeline unsaveable in the editor it was built in. Relevance is a SUBSET of
// compatibility (asserted in the tests): the palette may hide what the save gate
// tolerates, never the reverse, which would offer a kind that cannot then be saved.
//
// An absent `purpose` means UNCLASSIFIED (a legacy/custom pipeline never given one):
// treated as `build` for the palette (unrestricted) and hidden from a `document` task
// (which requires the explicit classifier), rather than silently narrowing everything.
//
// Both narrowing predicates take a value that is TYPED as a member and only DECLARED to be
// one. See {@link classifierFor} for what an unrecognised value means and why.
// ---------------------------------------------------------------------------

/** The agent-palette categories hidden from a non-`build` pipeline (writes no code, runs no tests). */
const NON_BUILD_HIDDEN_CATEGORIES: readonly AgentCategory[] = ['build', 'test']

/**
 * The purpose to narrow BY, or `null` for "this build has nothing to narrow by".
 *
 * Absent and UNRECOGNISED collapse to the same answer, and stating that once is the point of the
 * helper. Both predicates are typed against `PipelinePurpose`, but the value reaching them is a
 * stored `Pipeline.purpose` that no boundary re-checks against the union THIS build compiled: a
 * browser holding a cached bundle sees a member shipped after it, and a member retired from the
 * union goes on living in saved rows. Neither is a value to guess a current member from.
 *
 * The two predicates must agree about that, not merely each handle it: relevance is a SUBSET of
 * compatibility, so a purpose the palette stops narrowing by while the save gate keeps narrowing
 * by it would offer exactly the kind whose step then blocks the save. Reading through one helper
 * is what keeps them from drifting into opposite readings of the same unknown value.
 */
function classifierFor(purpose: Pipeline['purpose'] | null | undefined): PipelinePurpose | null {
  return purpose && isPipelinePurpose(purpose) ? purpose : null
}

/**
 * Whether a pipeline of `purpose` may use an agent kind in `category`: the builder's SAVE
 * gate. A `build` (or unclassified) pipeline may use anything; every other purpose refuses the
 * Implementation (`build`) and Testing (`test`) categories, the two that contradict the
 * classifier outright. Uncategorized kinds (no `category`) are always allowed, the caller
 * showing them regardless.
 *
 * For what the palette OFFERS, see {@link purposeSuggestsAgentCategory}: it narrows further,
 * and the difference is what keeps a stored pipeline editable after this file gets an opinion
 * it did not have when that pipeline was built. A purpose this build does not RECOGNISE is the
 * limit case of the same rule ({@link classifierFor}), and refusing there would be the worst
 * version of it: a save blocked over a classifier the editor cannot even name.
 */
export function purposeAllowsAgentCategory(
  purpose: Pipeline['purpose'] | null | undefined,
  category: AgentCategory,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null || classifier === 'build') return true
  return !NON_BUILD_HIDDEN_CATEGORIES.includes(category)
}

/**
 * Which palette categories each purpose is worth offering. A doubly-exhaustive `Record`
 * rather than a per-purpose deny list: adding a purpose OR an {@link AgentCategory} fails to
 * compile until every cell has been decided, which is the whole value of the table: the
 * silent outcome is a new category quietly offered to every purpose, or a new purpose
 * quietly offered the whole catalog, and neither reads as a missing decision at the call site.
 */
const PURPOSE_SUGGESTED_CATEGORIES: Record<
  PipelinePurpose,
  Readonly<Record<AgentCategory, boolean>>
> = {
  // Ships product code: every category is in play.
  build: { review: true, design: true, build: true, test: true, docs: true, gates: true },
  // Authors a document: researched, drafted, reviewed and merged like any change, but
  // nothing is implemented or tested.
  document: { review: true, design: true, build: false, test: false, docs: true, gates: true },
  // Reviews an EXISTING pull request and opens none: it designs nothing and builds nothing,
  // so only the judging kinds apply. `docs` stays because the Domain Rules Reviewer is a
  // review activity that groups under Documentation.
  review: { review: true, design: false, build: false, test: false, docs: true, gates: true },
  // Timeboxed investigation: the design kinds (spike, researcher, brainstorms) do the work
  // and it lands as a findings document.
  research: { review: true, design: true, build: false, test: false, docs: true, gates: true },
  // Decomposes an initiative: no code, no repo documentation of its own (the plan is the
  // in-repo tracker its own steps commit) and no pull request, so nothing to gate either.
  planning: { review: true, design: true, build: false, test: false, docs: false, gates: false },
}

/**
 * Whether an agent kind in `category` is worth OFFERING to a pipeline of `purpose`: the
 * builder palette's filter, sitting beside the agent-tier dial on the same control row.
 *
 * Unclassified (absent or unrecognised `purpose`, see {@link classifierFor}) offers everything,
 * for the same reason it saves everything: a pipeline nobody classified has told us nothing to
 * narrow by. A category this build does not recognise is offered for the mirror reason: the
 * table has no cell to read for it, and the honest reading of a missing cell is that a kind a
 * deployment registered stays visible in the palette, rather than vanishing from a catalog whose
 * save gate would have accepted it.
 *
 * Both narrowings are DEFAULT-OPEN on an unknown value, and deliberately: the compile-time guard
 * (the doubly-exhaustive table below) is what forces a decision for every member this build has,
 * and the runtime one exists only for the values it structurally cannot have.
 */
export function purposeSuggestsAgentCategory(
  purpose: Pipeline['purpose'] | null | undefined,
  category: AgentCategory,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null || !isAgentCategory(category)) return true
  return PURPOSE_SUGGESTED_CATEGORIES[classifier][category]
}

/**
 * Whether `pipeline` belongs in a library being browsed AT `purpose`: the builder's saved-pipeline
 * list, the third surface the purpose dial narrows (the palette's catalog and the save gate being
 * the other two).
 *
 * A BROWSE filter, so it reads the two unknowns the way its siblings do rather than inventing a
 * third policy:
 *
 *  - an unclassified or unrecognised `purpose` to browse at has nothing to narrow by
 *    ({@link classifierFor}), so the whole library shows;
 *  - a pipeline whose OWN `purpose` is absent or unrecognised is shown at every purpose. It is not
 *    known-wrong for any of them, and `purpose` is optional at every write boundary (the builder
 *    leaves it unset by default), so matching on it would hide exactly the hand-built pipelines a
 *    workspace has, with nothing on screen to explain the absence. The same asymmetry
 *    {@link pipelineAllowedForTaskType} draws for `feature` / `bug`, and for the same reason.
 *
 * Unlike the pickers' gate this narrows a list somebody is BROWSING rather than one they are about
 * to run from, so it may be exact where that one is permissive: two purposes never mix, and the
 * caller states how many rows the dial is holding back.
 */
export function pipelineMatchesPurpose(
  pipeline: Pick<Pipeline, 'purpose'>,
  purpose: Pipeline['purpose'] | null | undefined,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null) return true
  const own = classifierFor(pipeline.purpose)
  if (own === null) return true
  return own === classifier
}

/**
 * The purposes a PROGRAMMATIC task (`feature` / `bug`) may be offered. It ships code, so a
 * `document` or `review` pipeline is meaningless for it — the reverse of the narrowing those task
 * types already got. `research` is included because reaching for a spike before committing to an
 * approach is a legitimate move on a feature someone has not yet scoped; `planning` is not, being
 * initiative-level work that the block-level gate refuses anyway.
 *
 * Applied as a DENY list (everything not named here is hidden) rather than an allow list, which is
 * the one place this narrowing differs in direction from `document` / `review` — see
 * {@link pipelineAllowedForTaskType} for why an UNCLASSIFIED pipeline has to stay visible here.
 */
const PROGRAMMATIC_PURPOSES: readonly PipelinePurpose[] = ['build', 'research']

/**
 * Whether `pipeline` should be offered when starting a task of `taskType` — the pickers' gate.
 *
 * Each built-in task type narrows to the purposes that can actually do its work:
 *
 *  - `document` → only `document` pipelines (it authors a document; nothing else applies).
 *  - `review` → only `review` pipelines (it reviews an existing PR and opens none).
 *  - `feature` / `bug` → everything EXCEPT `document` / `review` / `planning`
 *    ({@link PROGRAMMATIC_PURPOSES}). These ship code, so offering them a document-authoring or
 *    PR-review preset was noise in the one picker people use most.
 *  - anything else, including a CUSTOM (namespaced) type and an undefined `taskType`, is
 *    unrestricted — a deployment's own task type has no purpose mapping we could infer.
 *
 * The two narrowings run in OPPOSITE directions, and the asymmetry is deliberate:
 *
 *  - `document` / `review` require the EXPLICIT classifier, because a build pipeline on a document
 *    task is actively wrong — running it would author no document and open a code PR nobody asked
 *    for. Guessing there costs more than hiding an unclassified preset.
 *  - `feature` / `bug` merely EXCLUDE the purposes that cannot ship code. An unclassified pipeline
 *    is not known-wrong for a feature, and `purpose` is optional at every write boundary — the
 *    builder leaves it unset by default and a `PipelineRegistry` entry need not declare one — so
 *    requiring it here would silently hide a workspace's own hand-built pipelines from the picker
 *    they were built for, with nothing on screen to explain the absence.
 *
 * Composed with the launch-availability / block-level / visual-frame filters at each picker.
 */
export function pipelineAllowedForTaskType(
  pipeline: Pick<Pipeline, 'purpose'>,
  taskType: TaskType | undefined,
): boolean {
  if (taskType === 'document') return pipeline.purpose === 'document'
  if (taskType === 'review') return pipeline.purpose === 'review'
  if (taskType === 'feature' || taskType === 'bug') {
    return pipeline.purpose === undefined || PROGRAMMATIC_PURPOSES.includes(pipeline.purpose)
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
