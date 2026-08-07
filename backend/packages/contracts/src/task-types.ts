import * as v from 'valibot'
import {
  descriptorFieldEntries,
  descriptorFieldOptionSchema,
  descriptorFieldShowWhenSchema,
  type DescriptorFieldOption,
} from './form-fields.js'
import { namespacedIdSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// The wire projection of a CUSTOM (deployment-registered) task type — the frontend analogue
// of `customAgentKindSchema` (`agent-presentation.ts`). A deployment registers a task type on
// its app-owned `TaskTypeRegistry`; the server serialises each registration's presentation +
// create-form fields into the workspace snapshot (`customTaskTypes`), and the SPA merges them
// into one task-type catalog so a proprietary work item (an "incident", "pentest",
// "compliance-audit") becomes a first-class create-task choice + card badge instead of the
// generic fallback — symmetric with agent kinds.
//
// The task type id itself widens `taskTypeSchema` (`primitives.ts`) from a closed picklist to
// `picklist ∪ namespaced`, exactly the shape `presentation.resultView` uses. An UNREGISTERED
// namespaced type (stale data after an extension was removed) degrades to the `feature`
// presentation on the frontend, so a leftover string never breaks a card.
// ---------------------------------------------------------------------------

/** Card-badge + create-form presentation for a custom task type (mirrors `agentPresentationSchema`). */
export const taskTypePresentationSchema = v.object({
  /** Human label, e.g. `Incident`. */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  /** Icon id (e.g. an `i-lucide-*` name). */
  icon: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Accent colour (CSS hex/keyword). */
  color: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  /** One-line description shown in the create-task type picker. */
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /**
   * Optional grouping caption for the create-task type picker (e.g. `API delivery`), mirroring
   * `agentPresentationSchema.category`, which already drives the pipeline builder's palette. An
   * org registering twenty reusable operations needs the picker to group them; types sharing a
   * category render under one caption, and an uncategorized type renders flat after them.
   */
  category: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))),
})
export type TaskTypePresentation = v.InferOutput<typeof taskTypePresentationSchema>

/** One choice of a `select` / `checkbox-group` field (the shared {@link descriptorFieldOptionSchema}). */
export const taskTypeFieldOptionSchema = descriptorFieldOptionSchema
export type TaskTypeFieldOption = DescriptorFieldOption

/**
 * Which of the shared descriptor-form input types a task-type field may declare.
 *
 * Everything the initiative-preset form admits EXCEPT `password`, excluded by construction rather
 * than by convention: a collected task field value is folded into agent prompts, projected onto the
 * board snapshot, and captured in agent-context telemetry, so it is the wrong home for a secret. A
 * capability an operation's agents need credentials for declares them by NAME against the
 * per-workspace capability-credential store, where the value never reaches a prompt.
 */
export const taskTypeFieldTypeSchema = v.picklist([
  'text',
  'textarea',
  'number',
  'select',
  'checkbox',
  'checkbox-group',
  'path',
])
export type TaskTypeFieldType = v.InferOutput<typeof taskTypeFieldTypeSchema>

/**
 * One data-driven field on a custom task type's create-form: the SHARED descriptor-form vocabulary
 * (`form-fields.ts`, which the initiative-preset form fills too), narrowed to the types above. Its
 * value lands in the sparse `taskTypeFields.custom` bag keyed by `key`, so adding a field never
 * needs a schema migration, and the shared `validateDescriptorFields` /
 * `sanitizeDescriptorFields` / `renderDescriptorFieldValue` rules apply verbatim: one renderer, one
 * validator, one prose projection across both surfaces.
 */
export const taskTypeFieldDescriptorSchema = v.object({
  ...descriptorFieldEntries,
  /** The control type; absent is treated as `text`. */
  type: v.optional(taskTypeFieldTypeSchema),
})
export type TaskTypeFieldDescriptor = v.InferOutput<typeof taskTypeFieldDescriptorSchema>

/**
 * A registered custom task type's wire projection — the snapshot entry the SPA merges into its
 * task-type catalog. Its `taskType` is ALWAYS namespaced ({@link namespacedIdSchema}); a
 * built-in type is never delivered this way.
 */
export const customTaskTypeSchema = v.object({
  /** The namespaced task type id (`<ns>:<name>`, e.g. `acme:incident`). */
  taskType: namespacedIdSchema,
  /** Card badge + create-form presentation. */
  presentation: taskTypePresentationSchema,
  /** Data-driven create-form fields (optional; none ⇒ title + description only). */
  fields: v.optional(v.array(taskTypeFieldDescriptorSchema)),
  /**
   * The pipeline a task of this type defaults to when the creator pins none — pairs with a
   * pipeline the deployment also registered (validated at boot). Absent ⇒ the workspace's
   * positional default, exactly like an unmapped built-in type.
   */
  defaultPipelineId: v.optional(v.string()),
  /**
   * The STANDING CONTEXT a task of this type carries: best-practice fragment ids unioned onto
   * every new task's own `fragmentIds` at creation, beside whatever it inherits from its service.
   * This is what makes a reusable operation consistent: an org's API guidelines and auth
   * requirements reach every "introduce an API" run without per-task picking.
   *
   * Only the id SET freezes at creation (matching `serviceFragmentIds` semantics); the BODIES
   * live-resolve per run against the merged builtin ⊕ account ⊕ workspace catalog, so editing a
   * guideline reaches every future run of an already-created task. Ids resolve against the
   * universal code pool AND the tenant tiers, which is why boot validation WARNS rather than
   * refuses on an id it cannot see (a workspace-tier id is structurally invisible at boot).
   */
  defaultFragmentIds: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200)))),
  /**
   * Standing context that depends on the ANSWERS the create form just collected: each entry's
   * fragment ids join {@link defaultFragmentIds} when its condition holds against the filled bag.
   *
   * Without it, an operation collecting `protocol: rest | graphql` in the same form has two bad
   * options: seed the union and pay for every branch's guidance on every run, or fold the
   * conditional material into one long standard and lose the per-standard citation the reviewers'
   * adherence report is built on.
   *
   * The condition is a {@link DescriptorFieldShowWhen} verbatim, evaluated by the ONE evaluator the
   * form's own field visibility uses (`matchesDescriptorCondition`), rather than a second
   * `{ key, equals }` shape that would drift from it. That reuse is what carries the non-obvious
   * rule an independent implementation gets wrong: an ABSENT value reads as `false` against a
   * boolean condition.
   *
   * This is a creation-time REDUCTION, coherent with the rest of the model rather than a stretch of
   * it: the answers freeze at creation and the id set freezes at creation, so the union is computed
   * once, against values that can no longer move, and the task owns the result outright. Nothing is
   * re-evaluated at run time; editing a task's collected values later does not re-seed it, exactly
   * as editing a service's fragments does not re-union onto an existing task.
   *
   * A `when.key` naming a field the type does not declare fails BOOT (`task_type_field_unknown_condition`),
   * and a condition on a field hidden by its own `showWhen` reduces to false, matching what
   * `sanitizeDescriptorFields` actually freezes: a hidden field's value is dropped, so a rule keyed
   * on it must not fire on a value the row does not carry.
   */
  conditionalFragmentIds: v.optional(
    v.array(
      v.object({
        /** The condition, in the same vocabulary a field's own `showWhen` uses. */
        when: descriptorFieldShowWhenSchema,
        /** The fragment ids added when {@link when} holds. */
        fragmentIds: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
      }),
    ),
  ),
  /**
   * Optional id of a bespoke create-form section component (`<ns>:<name>`) the deployment
   * contributes to the frontend `taskTypeFormPanels` slot, shown INSTEAD of the descriptor
   * `fields` above. Unpaired ⇒ the descriptor fields render (degrade, never crash).
   */
  formPanel: v.optional(namespacedIdSchema),
})
export type CustomTaskType = v.InferOutput<typeof customTaskTypeSchema>

/**
 * One row of the workspace's operation-suppression screen: a registered custom task type and
 * whether THIS board hides it (`backend/docs/reusable-operations.md`).
 *
 * The list is its own read rather than a slice of the snapshot, for the same reason the
 * foundational-service suppression list is: a suppressed id is BY CONSTRUCTION absent from the
 * projected `customTaskTypes`, so nothing in the board's own catalog could offer the way back.
 */
export const taskTypeSuppressionSchema = v.object({
  taskType: customTaskTypeSchema,
  suppressed: v.boolean(),
})
export type TaskTypeSuppression = v.InferOutput<typeof taskTypeSuppressionSchema>

/** The whole suppression screen: every registered operation, in registration order. */
export const taskTypeSuppressionListSchema = v.object({
  taskTypes: v.array(taskTypeSuppressionSchema),
})
export type TaskTypeSuppressionList = v.InferOutput<typeof taskTypeSuppressionListSchema>
