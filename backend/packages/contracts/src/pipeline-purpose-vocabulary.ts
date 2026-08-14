import * as v from 'valibot'

/**
 * The USE-CASE of a pipeline: what kind of work it exists to do. Chosen in the pipeline
 * builder and stamped on every built-in preset, it is the classifier the SPA filters on:
 *
 *   - `build`      produces or changes application code (the default for engineering
 *                  pipelines: full builds, refactors, dependency updates, …).
 *   - `bugfix`     fixes a REPORTED DEFECT: it ships code exactly as `build` does, and it is
 *                  built around a report to investigate, triage and reproduce, so it is offered
 *                  to a `bug` task and withheld from a `feature` one. The two are otherwise the
 *                  same classifier, which is why the palette and the save gate treat them alike
 *                  and only `pipelineAllowedForTaskType` tells them apart.
 *   - `document`   authors or updates documentation (a PRD/RFC/runbook, business rules, …);
 *                  a `document` task offers ONLY these.
 *   - `review`     reviews existing code / a pull request and reports findings; writes no code.
 *   - `research`   timeboxed investigation / analysis that delivers findings (a spike, an
 *                  environment analysis).
 *   - `planning`   decomposes and plans an initiative (no code, no repo write of its own).
 *   - `media`      produces BINARY deliverables (images, 3D models, audio) through the
 *                  generative integrations its step selects, stored through the step's asset
 *                  storage; a `media` task offers ONLY these. Its own member rather than a
 *                  flavour of `build` because none of the code-shipping machinery applies: it
 *                  opens no pull request, has nothing to test and nothing to merge, and the
 *                  palette it wants is the one nothing else asks for.
 *
 * The gating predicates that read it live in `pipeline-purpose.ts`, which re-exports this
 * module. The vocabulary sits apart from them because `agent-presentation.ts` has to name a
 * purpose too (`AgentPresentation.purposes`) and the predicates have to name an
 * `AgentCategory`: keeping the two halves in one file makes those a cycle, and a cycle whose
 * modules both build a `Set` at evaluation time resolves to an empty one on whichever side
 * loses the race.
 */
export const PIPELINE_PURPOSES = [
  'build',
  'bugfix',
  'document',
  'review',
  'research',
  'planning',
  'media',
] as const
export const pipelinePurposeSchema = v.picklist(PIPELINE_PURPOSES)
export type PipelinePurpose = v.InferOutput<typeof pipelinePurposeSchema>

const PIPELINE_PURPOSE_SET: ReadonlySet<string> = new Set(pipelinePurposeSchema.options)

/**
 * Whether a value is a purpose THIS BUILD knows, DERIVED from the picklist for the same reason
 * `isAgentCategory` is: the vocabulary is closed but PERSISTED, on `Pipeline.purpose`, so a
 * member retired from the union goes on living in stored rows and in the SPA bundle a browser
 * cached before a new member shipped. Narrow with this before indexing anything by a purpose.
 */
export function isPipelinePurpose(value: string): value is PipelinePurpose {
  return PIPELINE_PURPOSE_SET.has(value)
}
