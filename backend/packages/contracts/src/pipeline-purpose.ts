import { type AgentCategory, isAgentCategory } from './agent-presentation.js'
import type { Pipeline } from './entities.js'
import { isPipelinePurpose, type PipelinePurpose } from './pipeline-purpose-vocabulary.js'
import type { BlockLevel, TaskType } from './primitives.js'

/**
 * The pipeline-purpose vocabulary itself ({@link PipelinePurpose} and what each member means)
 * lives in `pipeline-purpose-vocabulary.ts` and is re-exported here, so every consumer keeps
 * importing the classifier and the predicates that read it from one place.
 *
 * A non-`build` purpose hides the Implementation/Testing agent kinds in the builder
 * ({@link purposeAllowsAgentCategory}), narrows what its palette offers
 * ({@link purposeSuggestsAgentKind}) and its saved-pipeline library lists
 * ({@link pipelineMatchesPurpose}), and scopes the pipeline in the task pickers
 * ({@link pipelineAllowedForTaskType}). The `Pipeline.purpose` field references this schema.
 */
export * from './pipeline-purpose-vocabulary.js'

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
// `build` and `bugfix` are ONE classifier to three of those four surfaces: the same work, split
// only so the pickers can tell them apart. {@link classifierSuits} states that relation once, so a
// palette and a library looking at the same draft cannot answer it differently.
//
// Every pipeline carries one: `purpose` is mandatory at every write boundary (the entity, the
// create request, the seed spec and therefore every `PipelineRegistry` registration), and the row
// mapper resolves the pre-mandatory NULLs the back-fill missed. So none of these predicates has an
// "unclassified pipeline" case to invent a policy for.
//
// What they DO all take is a value TYPED as a member and only DECLARED to be one. See
// {@link classifierFor} for what an unrecognised value means and why they read it default-OPEN.
// ---------------------------------------------------------------------------

/** The agent-palette categories hidden from a pipeline that ships no code (runs no tests either). */
const NON_BUILD_HIDDEN_CATEGORIES: readonly AgentCategory[] = ['build', 'test']

/**
 * The purposes that SHIP CODE, and so have a use for every palette category. `bugfix` is here
 * beside `build` because the two differ only in what they are offered TO ({@link
 * pipelineAllowedForTaskType}): a bug fix designs, implements, tests and merges like any change.
 */
const CODE_SHIPPING_PURPOSES: readonly PipelinePurpose[] = ['build', 'bugfix']

/**
 * The purpose to narrow BY, or `null` for "this build has nothing to narrow by".
 *
 * `Pipeline.purpose` is MANDATORY, so a pipeline never reaches here unclassified; what does reach
 * here is a value UNRECOGNISED by the reader, and a browsing context that is deliberately at no
 * purpose at all (the library's "all purposes" option). Both collapse to the same answer, and
 * stating that once is the point of the helper. The predicates are typed against `PipelinePurpose`,
 * but the value reaching them is a stored classifier no boundary re-checks against the union THIS
 * build compiled: a browser holding a cached bundle sees a member shipped after it, and a member
 * retired from the union goes on living in saved rows. Neither is a value to guess a current
 * member from.
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
 * Whether something classified `own` suits a context being judged AT `classifier`: exact match,
 * plus the single relation "`build` satisfies `bugfix`", one way.
 *
 * The two members are the same WORK (a bug fix designs, implements, tests and merges exactly as a
 * build does), and are split only so the pickers can withhold a defect-report preset from a feature
 * task ({@link pipelineAllowedForTaskType}). So anything classified `build` is at home in a bugfix
 * context: every palette kind whose `purposes` list predates the member (the Bug Investigator
 * declares `build`, most absurdly of all), and the whole build ladder in the saved-pipeline library
 * of a bugfix draft, which would otherwise open holding two rows.
 *
 * The reverse does NOT hold: naming `bugfix` claims the defect-report context specifically and says
 * nothing about a general build.
 *
 * ONE definition, read by both surfaces that narrow by purpose ({@link purposeSuggestsAgentKind},
 * {@link pipelineMatchesPurpose}), because the palette and the library answering the same question
 * differently is what a user reads as one of them being broken.
 */
function classifierSuits(own: PipelinePurpose, classifier: PipelinePurpose): boolean {
  return own === classifier || (classifier === 'bugfix' && own === 'build')
}

/**
 * Whether a pipeline of `purpose` may use an agent kind in `category`: the builder's SAVE
 * gate. A code-shipping pipeline ({@link CODE_SHIPPING_PURPOSES}) may use anything; every other
 * purpose refuses the Implementation (`build`) and Testing (`test`) categories, the two that
 * contradict the classifier outright. Uncategorized kinds (no `category`) are always allowed,
 * the caller showing them regardless.
 *
 * For what the palette OFFERS, see {@link purposeSuggestsAgentCategory}: it narrows further,
 * and the difference is what keeps a stored pipeline editable after this file gets an opinion
 * it did not have when that pipeline was built. A purpose this build does not RECOGNISE is the
 * limit case of the same rule ({@link classifierFor}), and refusing there would be the worst
 * version of it: a save blocked over a classifier the editor cannot even name.
 */
export function purposeAllowsAgentCategory(
  purpose: Pipeline['purpose'],
  category: AgentCategory,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null || CODE_SHIPPING_PURPOSES.includes(classifier)) return true
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
  // Ships product code too, so the same row. What differs is the task type it is offered to,
  // which this table does not decide.
  bugfix: { review: true, design: true, build: true, test: true, docs: true, gates: true },
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
 * A `purpose` this build cannot NAME (see {@link classifierFor}) offers everything, for the same
 * reason it saves everything: a classifier the reader has no table row for has told it nothing to
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
  purpose: Pipeline['purpose'],
  category: AgentCategory,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null || !isAgentCategory(category)) return true
  return PURPOSE_SUGGESTED_CATEGORIES[classifier][category]
}

/**
 * What a palette entry declares for the purpose dial to judge it by: the section it groups under
 * and, when it knows better than its section does, the purposes it is worth offering to.
 */
export interface AgentPurposeRelevance {
  /** The palette section, i.e. what {@link purposeSuggestsAgentCategory} reads. */
  category?: AgentCategory
  /** The kind's OWN answer, from `AgentPresentation.purposes`. */
  purposes?: readonly PipelinePurpose[]
}

/**
 * Whether an agent KIND is worth OFFERING to a pipeline of `purpose`: what the builder palette
 * actually filters on.
 *
 * A category is a SHELF LABEL, not a statement of what a kind does, so
 * {@link purposeSuggestsAgentCategory} can only ever remove whole sections: keeping `docs` for a
 * `review` pipeline so the Domain Rules Reviewer survives also offered it the two agents that
 * WRITE documentation into the repo, and `document` and `research` had identical rows, so moving
 * the dial between them narrowed nothing at all. A kind that knows it belongs to one use-case says
 * so itself, and the section keeps deciding for every kind that does not.
 *
 * The two narrowings INTERSECT: a declaration may only ever hide MORE than the section already
 * does, never buy a kind back into a purpose its section is not offered to. That is not a
 * convenience, it is what keeps relevance a SUBSET of compatibility
 * ({@link purposeAllowsAgentCategory}) no matter what a deployment declares: a kind offered
 * outside its category's row would be a palette entry whose step then blocks the save, the one
 * dead end this pair of tables exists to prevent.
 *
 * Declaring nothing is the normal case and stays exactly as permissive as before. A declared list
 * naming only purposes this build cannot NAME is read as declaring nothing rather than as
 * excluding everything, the same default-open reading its siblings give an unrecognised value: a
 * kind whose entire list was retired would otherwise vanish from every palette in the build that
 * has to fix it. An AUTHORED empty list never reaches here at all: `agentPresentationSchema`
 * refuses one at registration, so this reading cannot double as a way of saying "offer me
 * nowhere", which is what someone typing `purposes: []` means and the opposite of what it does.
 *
 * A declaration is matched through {@link classifierSuits}, so declaring `build` also answers for
 * `bugfix`: the two members are the same work, and without that the new one would silently empty
 * out a bugfix palette.
 */
export function purposeSuggestsAgentKind(
  purpose: Pipeline['purpose'],
  kind: AgentPurposeRelevance,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null) return true
  if (kind.category && !purposeSuggestsAgentCategory(purpose, kind.category)) return false
  const declared = kind.purposes?.filter((p) => isPipelinePurpose(p)) ?? []
  if (declared.length === 0) return true
  return declared.some((p) => classifierSuits(p, classifier))
}

/**
 * Whether `pipeline` belongs in a library being browsed AT `purpose`: the builder's saved-pipeline
 * list, the third surface the purpose dial narrows (the palette's catalog and the save gate being
 * the other two).
 *
 * A BROWSE filter, so it reads the two unknowns the way its siblings do rather than inventing a
 * third policy:
 *
 *  - `purpose` null (the library's explicit "all purposes") or a value this build cannot name has
 *    nothing to narrow by ({@link classifierFor}), so the whole library shows;
 *  - a pipeline whose OWN `purpose` this build cannot name is shown at every purpose. It is not
 *    known-wrong for any of them, and the alternative is a row that vanishes from every library in
 *    the editor it was built in, with nothing on screen to explain the absence. The same asymmetry
 *    {@link pipelineAllowedForTaskType} draws, and for the same reason.
 *
 * Unlike the pickers' gate this narrows a list somebody is BROWSING rather than one they are about
 * to run from, so it may be exact where that one is permissive: two known purposes mix only where
 * {@link classifierSuits} says they are the same work, and the caller states how many rows the dial
 * is holding back and offers the way out of it.
 */
export function pipelineMatchesPurpose(
  pipeline: Pick<Pipeline, 'purpose'>,
  purpose: Pipeline['purpose'] | null | undefined,
): boolean {
  const classifier = classifierFor(purpose)
  if (classifier === null) return true
  const own = classifierFor(pipeline.purpose)
  if (own === null) return true
  return classifierSuits(own, classifier)
}

/**
 * The purposes a `bug` task may be offered. It ships code, so a `document` or `review` pipeline is
 * meaningless for it — the reverse of the narrowing those task types already got. `research` is
 * included because reaching for a spike before committing to an approach is a legitimate move on
 * work someone has not yet scoped; `planning` is not, being initiative-level work that the
 * block-level gate refuses anyway.
 *
 * Applied as a DENY list (everything not named here is hidden) rather than an allow list, which is
 * the one place this narrowing differs in direction from `document` / `review` — see
 * {@link pipelineAllowedForTaskType} for why a classifier this build cannot NAME has to stay
 * visible here.
 */
const BUG_PURPOSES: readonly PipelinePurpose[] = ['build', 'bugfix', 'research']

/**
 * The purposes a `feature` task may be offered: {@link BUG_PURPOSES} minus `bugfix`.
 *
 * A bugfix preset is built around a DEFECT REPORT — it investigates one against the codebase,
 * triages it with a human for fixability, and writes a failing reproduction test before anything
 * is fixed. On a feature there is no report to investigate and nothing red to make green, so the
 * front half of such a run has no input and the reproduction proof it exists to produce is
 * vacuous. That is a narrowing in the same spirit as the document / review ones, drawn one notch
 * finer because both sides of it ship code.
 */
const FEATURE_PURPOSES: readonly PipelinePurpose[] = BUG_PURPOSES.filter((p) => p !== 'bugfix')

/**
 * Whether `pipeline` should be offered when starting a task of `taskType` — the pickers' gate.
 *
 * Each built-in task type narrows to the purposes that can actually do its work:
 *
 *  - `document` → only `document` pipelines (it authors a document; nothing else applies).
 *  - `review` → only `review` pipelines (it reviews an existing PR and opens none).
 *  - `bug` → everything EXCEPT `document` / `review` / `planning` ({@link BUG_PURPOSES}). It ships
 *    code, so offering it a document-authoring or PR-review preset was noise in the one picker
 *    people use most.
 *  - `feature` → the same, minus `bugfix` ({@link FEATURE_PURPOSES}): a preset that investigates a
 *    defect report and reproduces it has neither input on a feature.
 *  - anything else, including a CUSTOM (namespaced) type and an undefined `taskType`, is
 *    unrestricted — a deployment's own task type has no purpose mapping we could infer.
 *
 * The two narrowings run in OPPOSITE directions, and the asymmetry is deliberate. It is drawn on
 * the classifier this build can NAME ({@link classifierFor}), which is the only thing left for the
 * two to disagree about now that every pipeline carries one:
 *
 *  - `document` / `review` require the explicit member, because a build pipeline on a document
 *    task is actively wrong — running it would author no document and open a code PR nobody asked
 *    for. A purpose this build cannot name is hidden there: guessing costs more than an absence
 *    the user resolves by picking a preset the build does know.
 *  - `feature` / `bug` merely EXCLUDE the known purposes that do not fit, so an unnameable one
 *    stays visible. It is not known-wrong for a feature, and hiding it would take a deployment's
 *    own pipeline out of the picker people use most the moment its classifier outlives the bundle
 *    reading it, with nothing on screen to explain the absence.
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
    const own = classifierFor(pipeline.purpose)
    const offered = taskType === 'bug' ? BUG_PURPOSES : FEATURE_PURPOSES
    return own === null || offered.includes(own)
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
