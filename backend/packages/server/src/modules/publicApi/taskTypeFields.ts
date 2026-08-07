import {
  BUILTIN_CREATE_TASK_TYPES,
  builtinPublicTaskFields,
  isBuiltinCreateTaskType,
  parseBuiltinPublicTaskFields,
  sanitizeDescriptorFields,
  supersededBuiltinFieldKeys,
  validateDescriptorFields,
  validatePatchedDescriptorFields,
  withDescriptorFieldDefaults,
} from '@cat-factory/contracts'
import type {
  Block,
  CreatePublicTaskInput,
  DescriptorField,
  DescriptorFieldValues,
  PublicTaskType,
  TaskTypeFields,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import type { TaskTypeRegistry } from '@cat-factory/kernel'

// The public API's task-type half: the CATALOG `GET /api/v1/task-types` serves, and the mapping
// from a caller's `fields` bag onto the internal `taskTypeFields` the board writes.
//
// One table stands behind both directions. Discovery serves the descriptors, creation checks
// against the same descriptors through the same shared `validateDescriptorFields` the app's own
// form and the internal API run, so a client that read the catalog knows exactly what creation
// accepts. The alternative D9 sketched (descriptors for custom types, a hand-written OpenAPI shape
// for the built-ins) would have been two statements of one fact, and the built-in half would have
// been the one nothing checks.

/** Presentation for a BUILT-IN type, which has no registered descriptor to read one off. */
const BUILTIN_LABELS: Readonly<Record<string, string>> = {
  feature: 'Feature',
  bug: 'Bug',
  document: 'Document',
  spike: 'Spike',
  review: 'Pull request review',
  ralph: 'Ralph',
}

/**
 * The catalog for one workspace: the built-in create types, then the deployment's registered custom
 * ones minus anything this board SUPPRESSES.
 *
 * Suppression applies because the question this endpoint answers is "what may I create HERE". A
 * hidden operation listed anyway would be offered to a client whose very next call is refused, and
 * the refusal names a board policy the client cannot see or act on.
 */
export function publicTaskTypeCatalog(
  registry: TaskTypeRegistry | undefined,
  suppressed: ReadonlySet<string>,
): PublicTaskType[] {
  const builtins: PublicTaskType[] = BUILTIN_CREATE_TASK_TYPES.map((taskType) => ({
    taskType,
    builtin: true,
    label: BUILTIN_LABELS[taskType] ?? taskType,
    fields: [...builtinPublicTaskFields(taskType)],
  }))
  const custom: PublicTaskType[] = (registry?.all() ?? [])
    .filter((type) => !suppressed.has(type.taskType))
    .map((type) => ({
      taskType: type.taskType,
      builtin: false,
      label: type.presentation.label,
      description: type.presentation.description,
      ...(type.presentation.category ? { category: type.presentation.category } : {}),
      // `formPanel` is deliberately not projected: it names a component in the deployment's own
      // SPA layer, which no external client can render or act on. Nor are the `fields` such a type
      // declares, and that is the same decision rather than an exception to it: a `formPanel`
      // type's bag is validated by NOTHING (see `descriptorsFor`, and `checkCustomFields` on the
      // internal door), so listing its descriptors would advertise a check that does not run. On
      // this entry `fields` is what creation validates against, or empty.
      fields: type.formPanel ? [] : [...(type.fields ?? [])],
      ...(type.defaultPipelineId ? { defaultPipelineId: type.defaultPipelineId } : {}),
    }))
  return [...builtins, ...custom]
}

/**
 * The descriptors a `fields` bag for this type is checked against, or `undefined` when the type
 * has no descriptor the platform can read.
 *
 * The undefined case is exactly one: a NAMESPACED type this process does not register. Task types
 * are node-local by design, so a deployment routinely runs a process whose package predates a
 * registration; creating such a task is supported (the internal door allows it too), and there is
 * nothing to validate the values against. A `formPanel` type is the same answer for a different
 * reason: its bespoke form owns the whole bag, and the platform cannot read its required
 * semantics.
 */
function descriptorsFor(
  taskType: string,
  registry: TaskTypeRegistry | undefined,
): readonly DescriptorField[] | undefined {
  if (isBuiltinCreateTaskType(taskType)) return builtinPublicTaskFields(taskType)
  const registered = registry?.get(taskType)
  if (!registered || registered.formPanel) return undefined
  return registered.fields ?? []
}

/**
 * Check a caller's `fields` against the chosen type's descriptors and return the internal
 * `taskTypeFields` bag to create the task with, or `undefined` when there is nothing to carry.
 *
 * The two types map DIFFERENTLY, and that asymmetry is the whole function. A custom type's values
 * are per-case data with no schema of their own, so they land in the sparse `custom` sub-bag the
 * dispatch-time projection reads. A built-in type's are schema-typed TOP-LEVEL keys the existing
 * creation machinery already knows how to use (the review task's PR resolution, the document
 * fields), so they land there and every downstream behaviour runs unchanged.
 *
 * Refusal is a `422` carrying every problem at once, not the first: a headless caller fixing one
 * field per round trip against a form it cannot see is the experience this surface exists to avoid.
 */
export function resolveTaskTypeFields(
  body: CreatePublicTaskInput,
  registry: TaskTypeRegistry | undefined,
): TaskTypeFields | undefined {
  const taskType = body.taskType ?? 'feature'
  const descriptors = descriptorsFor(taskType, registry)
  // No descriptor to check against: an unregistered namespaced type (or one whose bespoke form
  // owns its bag). Carry the values verbatim rather than dropping them: the internal door accepts
  // exactly this row, and silently discarding a caller's brief is the worse of the two failures.
  if (!descriptors) {
    return body.fields && Object.keys(body.fields).length ? { custom: body.fields } : undefined
  }
  const filled = withDescriptorFieldDefaults(descriptors, body.fields ?? {})
  const problems = validateDescriptorFields(descriptors, filled)
  if (problems.length > 0) {
    throw new ValidationError(
      `The fields supplied for task type '${taskType}' do not match what it accepts: ${problems.join(' ')}`,
      { reason: 'task_type_fields_invalid', problems },
    )
  }
  const sanitized = sanitizeDescriptorFields(descriptors, filled)
  if (Object.keys(sanitized).length === 0) return undefined
  if (!isBuiltinCreateTaskType(taskType)) return { custom: sanitized }
  // A built-in type's values are the internal schema's own TOP-LEVEL keys, so they are parsed by
  // it rather than asserted to satisfy it. `BUILTIN_PUBLIC_TASK_FIELDS` restates that schema as
  // descriptors and the descriptor vocabulary is the narrower language (it has no `integer`, no
  // `trim`), so a cast here is exactly where a rule the restatement cannot carry gets lost: a
  // `prNumber` of `3.7` passed the descriptor and landed on the block as the PR to review.
  const parsed = parseBuiltinPublicTaskFields(sanitized)
  if (!parsed.ok) {
    throw refusal(taskType, parsed.problems)
  }
  return parsed.fields
}

/** The ONE refusal shape for a `fields` bag, at either door and for either half. */
function refusal(taskType: string, problems: string[]): ValidationError {
  return new ValidationError(
    `The fields supplied for task type '${taskType}' do not match what it accepts: ${problems.join(' ')}`,
    { reason: 'task_type_fields_invalid', problems },
  )
}

/**
 * The values a task's stored bag already carries for the descriptors this type declares, minus the
 * keys this request SUPERSEDES (see {@link supersededBuiltinFieldKeys}).
 */
function storedValuesFor(
  descriptors: readonly DescriptorField[],
  stored: Readonly<Record<string, unknown>>,
  superseded: ReadonlySet<string>,
): DescriptorFieldValues {
  const current: DescriptorFieldValues = {}
  for (const { key } of descriptors) {
    const value = stored[key]
    if (value !== undefined && !superseded.has(key)) {
      current[key] = value as DescriptorFieldValues[string]
    }
  }
  return current
}

/**
 * The stored built-in keys to carry under a settled patch: everything on the row that is not the
 * `custom` sub-bag and not superseded.
 *
 * The carry-through is what keeps a built-in type's INTERNAL-only keys (a document's `targetPath`,
 * the per-`DocKind` prose the public descriptors deliberately omit) alive across a patch that
 * cannot name them. Supersession is the one exception, and it has to be applied HERE as well as to
 * the validated bag: a `prNumber` dropped from the values but left on the carry-through would be
 * spread straight back over the caller's `prUrl`, which is the revert this exists to prevent.
 */
function carriedBuiltinKeys(
  stored: Readonly<Record<string, unknown>>,
  superseded: ReadonlySet<string>,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (key !== 'custom' && !superseded.has(key)) carried[key] = value
  }
  return carried
}

/**
 * Turn a caller's PARTIAL `fields` bag on `PATCH /api/v1/tasks/:taskId` into the internal patch
 * keys, checked against the same descriptors creation uses.
 *
 * The public surface MERGES where the internal one replaces, and the asymmetry is the point: this
 * API does not serve the bag back (see `updatePublicTaskSchema.fields`), so a replacing patch
 * would ask a caller to restate values it cannot read. The merge therefore happens HERE, at the
 * door that offers the ergonomic, and what reaches `updateBlock` is a whole half exactly as the
 * app's own form sends one. Validation runs on the MERGED bag rather than the fragment, or a type
 * whose descriptor declares a required field would refuse every patch that does not restate it.
 *
 * A built-in type's INTERNAL-only keys (a document's `targetPath`, the per-`DocKind` prose the
 * public descriptors deliberately omit) are carried through untouched: the caller cannot name
 * them, and a replace that dropped what it could not see would delete a value the app collected.
 *
 * Two things the merge is careful about, both of them cases where "what is stored" is not simply
 * "what the caller kept":
 *
 * - Values the caller did NOT name are not re-judged (`validatePatchedDescriptorFields`). The
 *   public descriptors for a built-in type are a deliberately NARROWER restatement of
 *   `taskTypeFieldsSchema` (`stepsToReproduce` is 2000 here against the schema's 4000), so judging
 *   a stored value by them refuses a patch for something the patch did not do, and refuses every
 *   later one identically: a task authored in the app with a 2500-character reproduction would be
 *   permanently un-repairable over the surface that exists to repair it.
 * - Keys the request SUPERSEDES are dropped before merging rather than merged back in. Today that
 *   is a `review` task's two spellings of one target; see {@link supersededBuiltinFieldKeys}.
 */
export function resolveTaskTypeFieldsPatch(
  block: Block,
  fields: DescriptorFieldValues,
  registry: TaskTypeRegistry | undefined,
): Pick<UpdateBlockInput, 'customTaskTypeFields' | 'builtinTaskTypeFields'> {
  const taskType = block.taskType ?? 'feature'
  const stored = block.taskTypeFields ?? {}
  const descriptors = descriptorsFor(taskType, registry)
  const named = Object.keys(fields)
  // Nothing to check against (an unregistered namespaced type, or one whose bespoke form owns the
  // bag): carry the values verbatim, as creation does, merged over what is there.
  if (!descriptors) return { customTaskTypeFields: { ...stored.custom, ...fields } }

  const builtin = isBuiltinCreateTaskType(taskType)
  const superseded = new Set(builtin ? supersededBuiltinFieldKeys(taskType, named) : [])
  const current = builtin ? storedValuesFor(descriptors, stored, superseded) : (stored.custom ?? {})
  const merged = withDescriptorFieldDefaults(descriptors, { ...current, ...fields })
  const problems = validatePatchedDescriptorFields(descriptors, merged, named)
  if (problems.length > 0) throw refusal(taskType, problems)
  const sanitized = sanitizeDescriptorFields(descriptors, merged)
  // A stored CUSTOM key the descriptor no longer declares does not survive: `sanitizeDescriptorFields`
  // keeps the declared keys only, which is what the internal door writes on every save from the
  // app's own form, and what `checkCustomFields` (the authority behind that door) would refuse to
  // accept back. Carrying it here would diverge the two doors and then be rejected one layer down.
  if (!builtin) return { customTaskTypeFields: sanitized }

  const parsed = parseBuiltinPublicTaskFields(sanitized)
  if (!parsed.ok) throw refusal(taskType, parsed.problems)
  return { builtinTaskTypeFields: { ...carriedBuiltinKeys(stored, superseded), ...parsed.fields } }
}
