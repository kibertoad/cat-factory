import {
  BUILTIN_CREATE_TASK_TYPES,
  builtinPublicTaskFields,
  isBuiltinCreateTaskType,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
} from '@cat-factory/contracts'
import type {
  CreatePublicTaskInput,
  DescriptorField,
  DescriptorFieldValues,
  PublicTaskType,
  TaskTypeFields,
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
      // SPA layer, which no external client can render or act on. Its declared `fields` are.
      fields: [...(type.fields ?? [])],
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
  return isBuiltinCreateTaskType(taskType)
    ? (sanitized as TaskTypeFields)
    : { custom: sanitized as DescriptorFieldValues }
}
