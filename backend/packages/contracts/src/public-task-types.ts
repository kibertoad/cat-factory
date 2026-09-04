import {
  BUG_FISHING_DEFAULT_PASS_BUDGET,
  BUG_FISHING_MAX_PASS_BUDGET,
  BUG_FISHING_PHASES,
} from './bugFishing.js'
import * as v from 'valibot'
import {
  descriptorFieldSchema,
  type DescriptorField,
  type DescriptorFieldValues,
} from './form-fields.js'
import {
  BUILTIN_CREATE_TASK_TYPES,
  DOC_KINDS,
  taskTypeFieldsSchema,
  type TaskTypeFields,
} from './primitives.js'

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
      // Says the NUMBER wins because `resolvePrNumber` does, at creation and at dispatch alike;
      // the help previously claimed the opposite, which no code path has ever implemented. Sending
      // both is only ambiguous in the one request that names them: the target is canonicalised
      // against the provider immediately after, so the stored pair always agrees from then on. A
      // URL naming a DIFFERENT repository is refused outright rather than silently outranked
      // (`assertRepoMatches`).
      help: 'The PR’s full web URL. Supply this or the number; the number wins when both are given.',
      maxLength: 500,
    },
    { key: 'reviewFocus', label: 'Review focus', type: 'textarea', maxLength: 2000 },
    // `reviewSkillIds` is deliberately ABSENT, for the reason `targetPath` is: no descriptor can
    // state its vocabulary. The valid values are the ids in the CALLING ACCOUNT's skill catalog,
    // which is tenant data, where this table is one static statement served to every caller. A
    // `checkbox-group` with no options would advertise a free-string list that creation then
    // refuses against a catalog the caller was never shown. Adding it later (as its own
    // discovery read) is additive.
  ],
  'bug-fishing': [
    // The angle list is a CHECKBOX GROUP over the shipped catalog, and the empty selection is the
    // meaningful default (fish every angle), which is exactly what a checkbox group with nothing
    // ticked says — so the surface and the internal schema agree with no extra rule.
    {
      key: 'fishingPhaseIds',
      label: 'Angles to fish',
      type: 'checkbox-group',
      help: 'Leave empty to fish every angle. Each angle is its own read-only pass over the codebase.',
      options: BUG_FISHING_PHASES.map((phase) => ({ value: phase.id, label: phase.title })),
    },
    {
      key: 'fishingFocus',
      label: 'Where to concentrate',
      type: 'textarea',
      help: 'Subsystems, directories, or the kind of defect to look hardest for. Narrows where each angle looks, not which angles run.',
      maxLength: 2000,
    },
    // Only bites on a codebase large enough to be split into territories, where the planned
    // matrix is territories x angles. Offered as a number rather than left implicit because
    // what the budget cuts is recorded as unfished, and a caller who set it should recognise
    // its own cut in that record.
    {
      key: 'fishingMaxPasses',
      label: 'Maximum passes',
      type: 'number',
      help: `Most read-only passes this expedition may run. Leave empty for ${BUG_FISHING_DEFAULT_PASS_BUDGET}. On a large codebase the expedition fishes each angle per territory, and whatever the budget cuts is recorded as unfished.`,
      min: 1,
      max: BUG_FISHING_MAX_PASS_BUDGET,
    },
  ],
  feature: [],
  ralph: [],
  // A media task takes its title and description and nothing else: what to generate, through
  // which integrations, into which storage, in which formats, is the STEP'S configuration
  // (`stepOptions.binaryOutput`), authored once on the pipeline and reused by every task pinned
  // to it. Listed explicitly rather than left out, because an absent entry and an empty one read
  // the same to `builtinPublicTaskFields` and the opposite to a person: this says "no per-case
  // fields", where silence would say "nobody has looked at this type yet".
  media: [],
}

/**
 * Keys of a built-in type that are alternate SPELLINGS of ONE value, grouped.
 *
 * A `review` task's target is a single pull request, named either by number or by URL, and
 * `resolvePrNumber` prefers the number when it sees both. At CREATION that preference is exactly
 * what the descriptor help promises, because both spellings came from the same author in the same
 * request. On a MERGING patch it inverts: a caller that repoints the task by sending `prUrl` alone
 * would have the stored `prNumber` merged back in beside it, win, and silently revert the target to
 * the pull request the caller was replacing, answered `200`.
 *
 * So a patch naming any member of a group supersedes the group's stored members: the value the
 * caller did not send is not a value it kept, it is the same value spelled the other way. Stated
 * here beside the descriptors rather than at the patch door, because the help text that claims the
 * URL "wins" and the merge that must not contradict it are two statements of one fact.
 */
const BUILTIN_PUBLIC_FIELD_ALIASES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  review: [['prNumber', 'prUrl']],
}

/**
 * The stored keys a patch NAMING `named` supersedes for this type: every other member of an alias
 * group one of the named keys belongs to. Empty for a type that declares no groups, which is all of
 * them but `review`.
 */
export function supersededBuiltinFieldKeys(taskType: string, named: readonly string[]): string[] {
  const groups = BUILTIN_PUBLIC_FIELD_ALIASES[taskType]
  if (!groups) return []
  const supplied = new Set(named)
  return groups
    .filter((group) => group.some((key) => supplied.has(key)))
    .flatMap((group) => group.filter((key) => !supplied.has(key)))
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
 * A built-in type's descriptor-checked values as the internal {@link taskTypeFieldsSchema} shape,
 * PARSED through that schema rather than asserted to match it.
 *
 * The table above restates the schema as descriptors, and a descriptor cannot state every rule a
 * valibot pipe can. `prNumber` is `v.integer()` in the schema and a plain `number` here, because
 * the vocabulary has no integer flag: a caller sending `3.7` satisfied the public surface and the
 * value landed on the block as the pull request to review. `prUrl` likewise loses the schema's
 * `v.trim()`. Casting was what let that through, so the fix is to stop casting: this parse is what
 * makes "everything the public surface accepts, the internal schema also accepts" true at RUN TIME
 * rather than a claim its conformity test samples one value per field.
 *
 * A discriminated result, not a throw: contracts states the RULE and cannot see the error
 * vocabulary that decides how a refusal reaches a caller (the kernel `ValidationError` the public
 * route raises). A failure is a drift between the two tables rather than an ordinary bad request,
 * but the value still came from the request, so the caller is told which field and why.
 */
export function parseBuiltinPublicTaskFields(
  values: DescriptorFieldValues,
): { ok: true; fields: TaskTypeFields } | { ok: false; problems: string[] } {
  const parsed = v.safeParse(taskTypeFieldsSchema, values)
  if (parsed.success) return { ok: true, fields: parsed.output }
  return {
    ok: false,
    problems: parsed.issues.map((issue) => {
      const key = issue.path?.map((segment) => String(segment.key)).join('.')
      return key ? `${key}: ${issue.message}.` : `${issue.message}.`
    }),
  }
}

/**
 * One entry of `GET /api/v1/task-types`: a type a caller may name in `POST /services/:id/tasks`,
 * with the form it accepts.
 *
 * Deliberately omits `formPanel`. It names a FRONTEND component in the deployment's own SPA layer,
 * which is meaningless to an external client and would advertise an id nothing in this API can act
 * on. A type declaring one still appears here, because it IS creatable, but with an EMPTY `fields`
 * list: its bespoke form owns the whole bag, so neither this API nor the internal create door
 * validates one key of it. Projecting the descriptors it happens to declare would advertise a
 * contract nothing enforces, and `fields` on this entry means exactly one thing everywhere
 * (see {@link PublicTaskType.fields}).
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
   * The descriptors task creation CHECKS a `fields` bag against for this type, in declaration
   * order. Exactly that, on every entry: a client that reads this list knows what the create call
   * will accept, which is the property the one-table design exists to hold.
   *
   * EMPTY therefore means "this API validates nothing per-case here", which covers two different
   * types and neither of them is a lie. A built-in like `feature` takes title and description
   * only, so there is nothing to send. A custom type with a `formPanel`, or one this process does
   * not register, accepts an arbitrary bag NOTHING checks (the internal create door does not
   * either), so there is no list that would describe it. Both answer "do not expect this API to
   * check what you send"; what a `formPanel` type's own form collects is the deployment's to
   * document.
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
