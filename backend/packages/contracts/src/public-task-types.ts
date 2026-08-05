import * as v from 'valibot'
import { descriptorFieldSchema, type DescriptorField } from './form-fields.js'
import { BUILTIN_CREATE_TASK_TYPES, DOC_KINDS } from './primitives.js'

// ---------------------------------------------------------------------------
// The PUBLIC task-type surface: what `GET /api/v1/task-types` serves, and the vocabulary
// `createPublicTaskSchema.fields` is checked against.
//
// A headless caller could always name a task type; it could never fill one in. Both halves of
// that gap close here, and they close with ONE table rather than two: discovery serves the field
// descriptors, and creation validates against the same descriptors through the same shared
// `validateDescriptorFields` the SPA and the internal API use. A caller that reads the discovery
// response therefore knows exactly what creation will accept, which is the property a separately
// hand-written OpenAPI shape could not have offered.
//
// Custom types bring their own descriptors (the registry already stores them). The BUILT-IN types
// have none (their fields are schema-typed top-level keys on `taskTypeFieldsSchema`), so this
// module states them as descriptors, and that statement is the single source both directions read.
// ---------------------------------------------------------------------------

/**
 * The per-type fields a BUILT-IN task type accepts over the public API, as descriptors.
 *
 * A deliberate SUBSET of `taskTypeFieldsSchema`, not a mirror of it. Included is what a caller
 * filing work headlessly actually supplies: a bug's severity and repro, a spike's timebox and
 * question, a document's kind and audience, a review's PR and focus. Excluded are the per-DocKind
 * prose sections (`targetUsers`, `decisionDrivers`, …), which the SPA collects behind a chosen
 * `docKind` and which would triple this surface for fields an integration does not have, plus the
 * document `targetPath`, whose `.md` rule no descriptor type can state (see below). They stay
 * internal until something asks. Adding one later is additive, which is why the subset is safe.
 *
 * The BOUNDS restate `taskTypeFieldsSchema`'s and must stay in step with it. They are declared
 * rather than derived because a descriptor is data a client READS (the discovery response tells a
 * caller the limit before it sends), where a valibot pipe is only a check. `public-task-types.test.ts`
 * pins the relation that must hold in the direction that matters: every value a descriptor here
 * calls valid is one `taskTypeFieldsSchema` also accepts. It is what caught `targetPath`.
 */
export const BUILTIN_PUBLIC_TASK_FIELDS: Readonly<Record<string, readonly DescriptorField[]>> = {
  bug: [
    {
      key: 'severity',
      label: 'Severity',
      type: 'select',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'critical', label: 'Critical' },
      ],
    },
    {
      key: 'stepsToReproduce',
      label: 'Steps to reproduce',
      type: 'textarea',
      help: 'Reproduction steps, or observed versus expected behaviour.',
      maxLength: 2000,
    },
  ],
  spike: [
    { key: 'timeboxHours', label: 'Timebox (hours)', type: 'number', min: 0, max: 1000 },
    { key: 'successCriteria', label: 'Success criteria', type: 'textarea', maxLength: 2000 },
    { key: 'researchQuestion', label: 'Research question', type: 'textarea', maxLength: 2000 },
    { key: 'optionsToCompare', label: 'Options to compare', type: 'textarea', maxLength: 2000 },
  ],
  document: [
    {
      key: 'docKind',
      label: 'Document kind',
      type: 'select',
      options: DOC_KINDS.map((kind) => ({ value: kind, label: kind })),
    },
    { key: 'audience', label: 'Audience', type: 'text', maxLength: 300 },
    // `targetPath` is deliberately ABSENT. The internal schema holds it to `isSafeDocPath` (a
    // relative in-repo path ENDING IN `.md`), and no descriptor type states that rule: `path` is
    // the directory guard, and plain `text` would advertise a free string that creation then
    // refuses with a raw schema error naming no field. Advertising a bound the surface cannot
    // enforce is worse than omitting the field, and adding it later is additive.
    { key: 'outlineHints', label: 'Outline hints', type: 'textarea', maxLength: 2000 },
  ],
  review: [
    {
      key: 'prNumber',
      label: 'Pull request number',
      type: 'number',
      help: 'The open PR to review, on the service’s linked repository.',
      min: 1,
    },
    {
      key: 'prUrl',
      label: 'Pull request URL',
      type: 'text',
      help: 'The PR’s full web URL. Wins over the number when both are given.',
      maxLength: 500,
    },
    { key: 'reviewFocus', label: 'Review focus', type: 'textarea', maxLength: 2000 },
  ],
  feature: [],
  ralph: [],
}

/**
 * The descriptors a built-in type accepts, or an empty list for a type with no public fields.
 * Total, so a caller never has to distinguish "no fields" from "unknown type": the type itself is
 * already validated by `createTaskTypeSchema`.
 */
export function builtinPublicTaskFields(taskType: string): readonly DescriptorField[] {
  return BUILTIN_PUBLIC_TASK_FIELDS[taskType] ?? []
}

/** Whether `taskType` is one of the built-in create-form types (rather than a namespaced custom one). */
export function isBuiltinCreateTaskType(taskType: string): boolean {
  return (BUILTIN_CREATE_TASK_TYPES as readonly string[]).includes(taskType)
}

/**
 * One entry of `GET /api/v1/task-types`: a type a caller may name in `POST /services/:id/tasks`,
 * with the form it accepts.
 *
 * Deliberately omits `formPanel`. It names a FRONTEND component in the deployment's own SPA layer,
 * which is meaningless to an external client and would advertise an id nothing in this API can act
 * on. A type declaring one still appears here with its declared `fields`, which is the honest
 * answer: those are the values this API validates, whatever the app's own form renders.
 */
export const publicTaskTypeSchema = v.object({
  /** The id to pass as `taskType` (`feature`, `bug`, …, or a namespaced `acme:incident`). */
  taskType: v.string(),
  /** False for a type this deployment registered; true for one cat-factory ships. */
  builtin: v.boolean(),
  /** Human label for the type. Deployment-authored English for a custom type. */
  label: v.string(),
  /** One-line description, when the type carries one. */
  description: v.optional(v.string()),
  /** The picker grouping caption a custom type declares, when it has one. */
  category: v.optional(v.string()),
  /**
   * The fields `fields` accepts for this type, in declaration order. Empty means the type takes
   * title and description only.
   */
  fields: v.array(descriptorFieldSchema),
  /**
   * The pipeline a task of this type is pinned to at creation when the caller pins none. Present
   * only where the type declares one; `POST /tasks/:id/start` falls back to it.
   */
  defaultPipelineId: v.optional(v.string()),
})
export type PublicTaskType = v.InferOutput<typeof publicTaskTypeSchema>

/**
 * The whole catalog: the built-in types first, then the deployment's registered ones in
 * registration order. Not paginated, because a catalog is a handful of entries even for an org with a
 * large operation library, and a caller reads it whole at startup.
 *
 * SUPPRESSION applies: a type the key's workspace hides is absent, because this endpoint answers
 * "what may I create here", and a client offered a type creation then refuses has been misled.
 */
export const publicTaskTypeListSchema = v.object({ taskTypes: v.array(publicTaskTypeSchema) })
export type PublicTaskTypeList = v.InferOutput<typeof publicTaskTypeListSchema>
