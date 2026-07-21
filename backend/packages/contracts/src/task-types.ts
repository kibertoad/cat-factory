import * as v from 'valibot'
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
})
export type TaskTypePresentation = v.InferOutput<typeof taskTypePresentationSchema>

/** One choice of a `select` {@link taskTypeFieldDescriptorSchema}. */
export const taskTypeFieldOptionSchema = v.object({
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
})
export type TaskTypeFieldOption = v.InferOutput<typeof taskTypeFieldOptionSchema>

/**
 * One data-driven field on a custom task type's create-form — the descriptor-driven form
 * vocabulary (the `credentialFieldSchema` / `agentConfigDescriptorSchema` shape generalized):
 * a label + input kind + options. Its value lands in the sparse `taskTypeFields.custom` bag
 * keyed by {@link key}, so adding a field never needs a schema migration.
 */
export const taskTypeFieldDescriptorSchema = v.object({
  /** Stable key the collected value is stored under in `taskTypeFields.custom`. */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  /** Human label shown next to the field. */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** The control type: free text, multi-line text, a number, or one of {@link options}. */
  type: v.picklist(['text', 'textarea', 'number', 'select']),
  /** One-line helper text shown under the field. */
  help: v.optional(v.pipe(v.string(), v.maxLength(300))),
  /** Placeholder shown in an empty `text`/`textarea`/`number` input. */
  placeholder: v.optional(v.pipe(v.string(), v.maxLength(200))),
  /** The choices for a `select` descriptor; absent (and ignored) for the other types. */
  options: v.optional(v.array(taskTypeFieldOptionSchema)),
  /** Whether the field must be filled before the task can be created. */
  required: v.optional(v.boolean()),
  /** Max length for a `text`/`textarea` value (characters). */
  maxLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000))),
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
   * Optional id of a bespoke create-form section component (`<ns>:<name>`) the deployment
   * contributes to the frontend `taskTypeFormPanels` slot, shown INSTEAD of the descriptor
   * `fields` above. Unpaired ⇒ the descriptor fields render (degrade, never crash).
   */
  formPanel: v.optional(namespacedIdSchema),
})
export type CustomTaskType = v.InferOutput<typeof customTaskTypeSchema>
