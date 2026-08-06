import {
  isNamespacedId,
  matchesDescriptorCondition,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
} from '@cat-factory/contracts'
import type { CustomTaskType } from '@cat-factory/contracts'
import type {
  Block,
  Logger,
  PromptFragmentSource,
  TaskTypeFields,
  TaskTypeRegistry,
  TaskTypeSuppressionRepository,
} from '@cat-factory/kernel'
import { defaultPipelineIdForTaskType, ValidationError } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// What a new task's TYPE implies for the row `BoardService.addTask` writes: whether the workspace
// offers that type at all, the best-practice fragment set it owns from creation, the pipeline its
// Run controls default to, and whether the per-case values it arrived with are the ones its type
// actually declares. Every answer joins a deployment-registered descriptor (a REUSABLE OPERATION's
// bundle, `backend/docs/reusable-operations.md`) with the built-in per-type defaults, which is why
// they live together rather than inline: it is one lookup against one registry, read three times,
// plus the per-workspace hide-list that decides whether that registry entry applies here.
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
   * FOUR sources union. The SERVICE-inherited set is the create form's explicit list when it
   * provided one (the user edited the pre-seeded picker), INCLUDING an empty list, which means "the
   * user cleared the inherited picks", else the enclosing service's `serviceFragmentIds` (so a task
   * created without the form, e.g. via the public API, still inherits its service's standards).
   * Every task additionally always carries its TASK-TYPE defaults (the built-in document
   * writing-style set plus any deployment-registered per-type defaults). A REGISTERED custom type's
   * own `defaultFragmentIds` join those: an operation's standing context (an org's API guidelines,
   * its auth requirements) is part of the bundle, so every invocation carries it with no per-task
   * picking. And finally its `conditionalFragmentIds`, the entries whose condition holds against the
   * values this creation just collected.
   *
   * A task owns the result outright: the engine folds exactly this selection and does NOT re-union
   * the service's fragments at run time, so a per-task removal actually takes effect. Only the id SET
   * freezes here; bodies live-resolve per run, so editing a guideline reaches tasks created before
   * the edit.
   *
   * Async because the per-task-type default set is read through the app-owned
   * {@link PromptFragmentSource}, which on a mothership-mode node crosses the machine API. That read
   * THROWS on failure rather than answering empty, and the throw propagates: seeding a task with a
   * silently short standing context is the failure this whole seam exists to prevent, and creation
   * is a user action that can be retried, not a best-effort side channel.
   */
  fragmentIdsFor(input: {
    taskType: ResolvedTaskType
    /** The create form's explicit list, or undefined when it sent none. */
    explicit?: string[]
    /** The enclosing service's standing standards, used only when `explicit` is absent. */
    serviceFragmentIds?: string[]
    /**
     * The per-type values this creation collected, ALREADY sanitized (so a field hidden by its own
     * `showWhen` is absent, and a rule keyed on it correctly does not fire). Drives
     * `conditionalFragmentIds`; absent means no conditional entry holds.
     */
    fields?: TaskTypeFields
  }): Promise<string[]>
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
   * An ABSENT bag is checked too, against an empty one. A required field is unanswered whether the
   * caller sent `custom: {}` or sent no `custom` key at all, and the two spellings must refuse
   * alike or the whole check is opt-in: a headless caller would satisfy an operation's declared
   * form by omitting it, which is the door this exists to close.
   *
   * The descriptor's DEFAULTS are applied before either step, so "unanswered" means the deployment
   * declared no answer either. Without that, a `required` field carrying a `default` was enforced
   * at one door and not the other: the SPA seeds it into the form before submit, so only the
   * headless caller ever saw the refusal, for a value it had no way to know it had to restate.
   *
   * Three cases pass straight through, each deliberately:
   * - a BUILT-IN type, whose fields are the schema-typed top-level keys, already validated there;
   * - a type this process does not REGISTER, because an unregistered namespaced type is a supported
   *   row (task types are node-local by design) and degrading data must not brick creation;
   * - a descriptor declaring a `formPanel`, whose bespoke create-form section owns the whole bag
   *   (the platform cannot read its required semantics, the existing AddTaskModal contract).
   */
  validatedFields(
    taskType: ResolvedTaskType,
    fields: TaskTypeFields | undefined,
  ): TaskTypeFields | undefined
  /**
   * Refuse a task of an operation this workspace has SUPPRESSED, before any side effect.
   *
   * The picker not offering it is presentation; this is the rule. A suppressed type is absent from
   * the board snapshot's `customTaskTypes`, so the SPA cannot select it, but the internal API, the
   * public API, an initiative spawn and a tracker import all reach `addTask` without ever seeing a
   * picker. Refusing here is what makes "hidden on this board" mean the same thing at every door.
   *
   * A read failure PROPAGATES, unlike the snapshot's best-effort projection of the same rows. The
   * two are not the same call: the snapshot renders a picker and must never take a board load down
   * over one, while this decides whether a row is WRITTEN. Swallowing here would create the task
   * the workspace asked not to have and report nothing, and the store is the same database the
   * insert on the next line goes to, so there is no outage this could ride out.
   */
  assertNotSuppressed(workspaceId: string, taskType: ResolvedTaskType): Promise<void>
}

/**
 * The STANDING CONTEXT a registered custom task type contributes: a reusable operation's
 * `defaultFragmentIds` (`backend/docs/reusable-operations.md`).
 *
 * STATES a namespaced type this process does not register, rather than contributing nothing in
 * silence. Task types are node-local by design, so an org deployment routinely runs a process
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
  fields: TaskTypeFields | undefined,
): readonly string[] {
  const registered = registry?.get(taskType)
  if (registered) {
    return [...(registered.defaultFragmentIds ?? []), ...conditionalContextFor(registered, fields)]
  }
  if (isNamespacedId(taskType)) {
    log.warn(
      'Task created under a custom task type this process does not register; its standing-context fragments were not seeded and this task will not gain them later',
      { taskType },
    )
  }
  return []
}

/**
 * The `conditionalFragmentIds` entries whose condition holds against the values just collected.
 *
 * Evaluated through contracts' `matchesDescriptorCondition`, the SAME evaluator the form's own
 * field visibility uses, so the two can never disagree about what a condition means. That matters
 * for one rule above all: an absent value reads as `false` against a boolean condition, which a
 * second implementation gets wrong in the direction that silently seeds nothing.
 *
 * Reads the per-type `custom` sub-bag, which by this point has been through
 * `sanitizeDescriptorFields`: a field hidden by its own `showWhen` has already been dropped, so a
 * rule keyed on one reduces to false and matches what the row actually freezes. A rule keyed on a
 * field the type does not declare cannot reach here at all, because boot refuses it
 * (`task_type_field_unknown_condition`).
 */
function conditionalContextFor(
  registered: CustomTaskType,
  fields: TaskTypeFields | undefined,
): string[] {
  const rules = registered.conditionalFragmentIds ?? []
  if (rules.length === 0) return []
  const values = fields?.custom ?? {}
  return rules
    .filter((rule) => matchesDescriptorCondition(rule.when, values))
    .flatMap((rule) => rule.fragmentIds)
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
  const descriptor = registry?.get(taskType)
  if (!descriptor || descriptor.formPanel) return fields
  const declared = descriptor.fields ?? []
  // An absent bag is an EMPTY one, not an exemption: a required field is unanswered either way.
  // The descriptor's own DEFAULTS are folded in first, so a caller that omits a defaulted field is
  // answered by the deployment's stated value rather than refused for it: the same bag the create
  // form would have submitted, since the form seeds from the same helper.
  const custom = withDescriptorFieldDefaults(declared, fields?.custom ?? {})
  const problems = validateDescriptorFields(declared, custom)
  if (problems.length > 0) {
    throw new ValidationError(
      `The values collected for task type '${taskType}' do not match what it declares: ${problems.join(' ')}`,
      { reason: 'task_type_fields_invalid', problems },
    )
  }
  const sanitized = sanitizeDescriptorFields(declared, custom)
  if (Object.keys(sanitized).length > 0) return { ...fields, custom: sanitized }
  const { custom: _dropped, ...rest } = fields ?? {}
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Refuse a suppressed operation, per the contract on
 * {@link TaskTypeCreationDefaults.assertNotSuppressed}. A BUILT-IN type short-circuits without a
 * query: built-ins are not suppressible (they carry hardcoded creation affordances), so every
 * ordinary `feature` creation would otherwise pay a read to learn nothing.
 */
async function assertNotSuppressed(
  workspaceId: string,
  taskType: ResolvedTaskType,
  suppressions: TaskTypeSuppressionRepository | undefined,
): Promise<void> {
  if (!suppressions || !isNamespacedId(taskType)) return
  const suppressed = await suppressions.list(workspaceId)
  if (!suppressed.includes(taskType)) return
  throw new ValidationError(
    `The task type '${taskType}' is not offered on this board. A workspace admin hid it; restore it in the workspace's task-type settings to create work under it again.`,
    { reason: 'task_type_suppressed', taskType },
  )
}

export function createTaskTypeCreationDefaults(deps: {
  /** The app-owned registry a deployment registers its custom task types on. */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * Where the per-task-type DEFAULT SETS are read from: the app-owned source, which is this
   * deployment's own registry or (on a mothership-mode node) the mothership's. Absent ⇒ no
   * per-type defaults, the honest answer for a caller that wired no pool at all.
   */
  promptFragmentSource?: PromptFragmentSource
  /** The per-workspace hide-list; absent ⇒ nothing is suppressed. */
  taskTypeSuppressionRepository?: TaskTypeSuppressionRepository
  logger: Logger
}): TaskTypeCreationDefaults {
  return {
    assertNotSuppressed: (workspaceId, taskType) =>
      assertNotSuppressed(workspaceId, taskType, deps.taskTypeSuppressionRepository),
    fragmentIdsFor: async ({ taskType, explicit, serviceFragmentIds, fields }) => [
      ...new Set([
        ...(explicit ?? serviceFragmentIds ?? []),
        ...((await deps.promptFragmentSource?.defaultFragmentIdsFor(taskType)) ?? []),
        ...standingContextFor(taskType, deps.taskTypeRegistry, deps.logger, fields),
      ]),
    ],
    pipelineIdFor: (taskType) => defaultPipelineIdForTaskType(taskType, deps.taskTypeRegistry),
    validatedFields: (taskType, fields) =>
      checkCustomFields(taskType, fields, deps.taskTypeRegistry),
  }
}
