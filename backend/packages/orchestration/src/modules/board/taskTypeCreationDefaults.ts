import {
  isNamespacedId,
  sanitizeDescriptorFields,
  validateDescriptorFields,
} from '@cat-factory/contracts'
import type { Block, Logger, TaskTypeFields, TaskTypeRegistry } from '@cat-factory/kernel'
import { defaultPipelineIdForTaskType, ValidationError } from '@cat-factory/kernel'
import { defaultFragmentIdsForTaskType } from '@cat-factory/prompt-fragments'

// ---------------------------------------------------------------------------
// What a new task's TYPE implies for the row `BoardService.addTask` writes: the best-practice
// fragment set it owns from creation, the pipeline its Run controls default to, and whether the
// per-case values it arrived with are the ones its type actually declares. All three answers join a
// deployment-registered descriptor (a REUSABLE OPERATION's bundle,
// `docs/initiatives/reusable-operations.md`) with the built-in per-type defaults, which is why they
// live together rather than inline: it is one lookup against one registry, read three times.
//
// Extracted from `BoardService` when the standing-context union pushed that file over its size
// budget. A collaborator over a small deps object, with thin delegates left behind at the call site.
// ---------------------------------------------------------------------------

/**
 * The task type `addTask` resolved for the row, never absent: the create form's choice or the
 * `feature` default it falls back to. Both answers below are keyed on it, so neither has to restate
 * what an omitted type means.
 */
export type ResolvedTaskType = NonNullable<Block['taskType']>

/** The task-type-derived defaults a newly created task row carries. */
export interface TaskTypeCreationDefaults {
  /**
   * The best-practice fragment ids the task OWNS from creation, deduped and in precedence order.
   *
   * Three sources union. The SERVICE-inherited set is the create form's explicit list when it
   * provided one (the user edited the pre-seeded picker), INCLUDING an empty list, which means "the
   * user cleared the inherited picks", else the enclosing service's `serviceFragmentIds` (so a task
   * created without the form, e.g. via the public API, still inherits its service's standards).
   * Every task additionally always carries its TASK-TYPE defaults (the built-in document
   * writing-style set plus any deployment-registered per-type defaults). And a REGISTERED custom
   * type's own `defaultFragmentIds` join both: an operation's standing context (an org's API
   * guidelines, its auth requirements) is part of the bundle, so every invocation carries it with no
   * per-task picking.
   *
   * A task owns the result outright: the engine folds exactly this selection and does NOT re-union
   * the service's fragments at run time, so a per-task removal actually takes effect. Only the id SET
   * freezes here; bodies live-resolve per run, so editing a guideline reaches tasks created before
   * the edit.
   */
  fragmentIdsFor(input: {
    taskType: ResolvedTaskType
    /** The create form's explicit list, or undefined when it sent none. */
    explicit?: string[]
    /** The enclosing service's standing standards, used only when `explicit` is absent. */
    serviceFragmentIds?: string[]
  }): string[]
  /**
   * The pipeline a new task of this type defaults to when the creator pins none. A `document` task
   * defaults to the document-authoring pipeline (`pl_document`) rather than the workspace's
   * positional default (the full build pipeline), which makes no sense for a document: it produces
   * no code and needs no spec/tests. A registered custom type may name its own canned pipeline.
   * Undefined ⇒ fall through to the run-time picker's positional default.
   */
  pipelineIdFor(taskType: Block['taskType']): string | undefined
  /**
   * The per-type field bag to FREEZE on the row: the submitted one with a registered custom type's
   * `custom` sub-bag checked against its descriptor and reduced to the declared, currently VISIBLE
   * fields. Throws a `ValidationError` naming every problem, so ONE rule covers the SPA, the
   * internal API and (from the public-API slice) a headless caller: the create form's `required`
   * markers and option lists mean nothing if only the form enforces them.
   *
   * Three cases pass straight through, each deliberately:
   * - a BUILT-IN type, whose fields are the schema-typed top-level keys, already validated there;
   * - a type this process does not REGISTER, because an unregistered namespaced type is a supported
   *   row (task types are node-local by design, D11) and degrading data must not brick creation;
   * - a descriptor declaring a `formPanel`, whose bespoke create-form section owns the whole bag
   *   (the platform cannot read its required semantics, the existing AddTaskModal contract).
   */
  validatedFields(
    taskType: ResolvedTaskType,
    fields: TaskTypeFields | undefined,
  ): TaskTypeFields | undefined
}

/**
 * The STANDING CONTEXT a registered custom task type contributes: a reusable operation's
 * `defaultFragmentIds` (`docs/initiatives/reusable-operations.md` D4).
 *
 * STATES a namespaced type this process does not register, rather than contributing nothing in
 * silence. Task types are node-local by design (D11), so an org deployment routinely runs a process
 * whose package predates a registration, or has none at all; a task created there is ACCEPTED (an
 * unregistered namespaced type is a supported row) and would then carry NONE of the operation's
 * standing context. Unlike the run-time projection, which degrades to raw keys and self-heals as
 * soon as the descriptor is there, only the id SET freezes at creation: this task never gains the
 * guidelines its agents are supposed to be held to, and a later build does not go back for it.
 *
 * A BUILT-IN type is not warned about, having no registration to miss.
 */
function standingContextFor(
  taskType: ResolvedTaskType,
  registry: TaskTypeRegistry | undefined,
  log: Logger,
): readonly string[] {
  const registered = registry?.get(taskType)
  if (registered) return registered.defaultFragmentIds ?? []
  if (isNamespacedId(taskType)) {
    log.warn(
      'Task created under a custom task type this process does not register; its standing-context fragments were not seeded and this task will not gain them later',
      { taskType },
    )
  }
  return []
}

/**
 * Validate + sanitize a registered custom type's collected values, per the contract on
 * {@link TaskTypeCreationDefaults.validatedFields}. A bag that sanitizes to nothing drops the key
 * rather than freezing an empty object, so a row's `custom` presence keeps meaning "parameters were
 * collected" (which is what the dispatch-time projection reads it as).
 */
function checkCustomFields(
  taskType: ResolvedTaskType,
  fields: TaskTypeFields | undefined,
  registry: TaskTypeRegistry | undefined,
): TaskTypeFields | undefined {
  const custom = fields?.custom
  if (!fields || !custom) return fields
  const descriptor = registry?.get(taskType)
  if (!descriptor || descriptor.formPanel) return fields
  const declared = descriptor.fields ?? []
  const problems = validateDescriptorFields(declared, custom)
  if (problems.length > 0) {
    throw new ValidationError(
      `The values collected for task type '${taskType}' do not match what it declares: ${problems.join(' ')}`,
      { reason: 'task_type_fields_invalid', problems },
    )
  }
  const sanitized = sanitizeDescriptorFields(declared, custom)
  if (Object.keys(sanitized).length > 0) return { ...fields, custom: sanitized }
  const { custom: _dropped, ...rest } = fields
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function createTaskTypeCreationDefaults(deps: {
  /** The app-owned registry a deployment registers its custom task types on. */
  taskTypeRegistry?: TaskTypeRegistry
  logger: Logger
}): TaskTypeCreationDefaults {
  return {
    fragmentIdsFor: ({ taskType, explicit, serviceFragmentIds }) => [
      ...new Set([
        ...(explicit ?? serviceFragmentIds ?? []),
        ...defaultFragmentIdsForTaskType(taskType),
        ...standingContextFor(taskType, deps.taskTypeRegistry, deps.logger),
      ]),
    ],
    pipelineIdFor: (taskType) => defaultPipelineIdForTaskType(taskType, deps.taskTypeRegistry),
    validatedFields: (taskType, fields) =>
      checkCustomFields(taskType, fields, deps.taskTypeRegistry),
  }
}
