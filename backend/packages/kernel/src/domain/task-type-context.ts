import {
  type CustomTaskType,
  type TaskTypeFieldDescriptor,
  isNamespacedId,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The RUN-TIME projection of a custom task type's collected form values: what a REUSABLE
// OPERATION's per-case parameters look like by the time a prompt renders them.
//
// A registered `CustomTaskType` collects a small form at creation and freezes the answers in the
// sparse `taskTypeFields.custom` bag on the block. The bag is keys and raw values; the DESCRIPTOR
// holds the human labels and the option captions. This module joins the two, once, so every
// prompt-assembling path renders the same thing (see `docs/initiatives/reusable-operations.md` D3).
//
// The join is VALUE-AUTHORITATIVE and that is the whole design: the descriptor lives in the
// deployment's code while the bag lives in a row, so the two drift by construction (a node one
// build behind, a type whose registration was removed, a field renamed since the task was
// created). Drift may therefore cost a LABEL and never a VALUE: an undeclared bag key is rendered
// under its raw key rather than dropped, and an unregistered type renders every key it holds. The
// opposite (render only what the descriptor declares) silently deletes exactly the per-case brief
// the operation was invoked with, and nothing downstream could tell.
//
// The one thing that is NOT drift is a BUILT-IN task type carrying a `custom` bag. A custom type is
// namespaced by construction (`customTaskTypeSchema.taskType`), so `feature` will never have a
// descriptor however current the build is, and the raw-id fallback that honestly names a WITHDRAWN
// operation would instead invent one: a `## Task parameters (feature)` heading over keys nothing
// declared, which reads to the model as a specification. So an un-namespaced type yields no
// projection at all. That is not the value-authoritative rule bending, it is the rule not applying:
// there was no operation, so there is no per-case brief to preserve.
// ---------------------------------------------------------------------------

/**
 * One collected parameter, resolved for rendering: the descriptor's label when it declares the
 * key, and the value already rendered as prose (an option's caption rather than its enum value).
 */
export interface CustomTaskFieldContext {
  /** The bag key the value is stored under. */
  key: string
  /** The descriptor's human label; absent when the descriptor does not declare this key. */
  label?: string
  /** The value as prose (option label where one is declared, else the raw value stringified). */
  value: string
}

/**
 * A run's custom-task-type parameters: the operation's per-case brief, ready to render. Present
 * only when the block carries a non-empty `taskTypeFields.custom` bag.
 */
export interface CustomTaskTypeContext {
  /** The namespaced task type id (`<ns>:<name>`). */
  taskType: string
  /** The registered presentation label, or the raw id when nothing is registered for it. */
  label: string
  /** The collected values: declared fields in descriptor order, then any undeclared bag key. */
  fields: CustomTaskFieldContext[]
}

/**
 * A collected value that says NOTHING, and so is left out rather than rendered as an empty line: a
 * string holding only whitespace (an absent key is checked by the caller, which needs the narrowing).
 * A `0` is a real answer and stays.
 */
function isBlank(value: string | number): boolean {
  return typeof value === 'string' && value.trim() === ''
}

/**
 * Render one collected value as prose: an option's caption where the descriptor declares one.
 * Trimmed, because a `textarea` value routinely arrives with a trailing newline and the section
 * renders one value per line.
 */
function renderValue(
  value: string | number,
  descriptor: TaskTypeFieldDescriptor | undefined,
): string {
  if (typeof value === 'number') return String(value)
  // Matched against the descriptor's options BEFORE trimming, so a stored enum value still finds
  // its caption; only the fallback (the value itself) is what gets trimmed.
  return descriptor?.options?.find((option) => option.value === value)?.label ?? value.trim()
}

/**
 * Join a block's collected custom-task-type values with the registered descriptor for its type.
 * Returns undefined when the bag is absent or empty, so a run without collected parameters carries
 * no context field and every existing prompt stays byte-identical. Also undefined when `taskType`
 * is not namespaced: only a custom type has collected parameters, so a built-in carrying a bag is a
 * malformed row rather than drift (see the header note).
 *
 * `descriptor` is the registration for `taskType`, or undefined when the deployment registers none
 * (see the drift note above: an absent registration costs labels and ordering, never values).
 */
export function describeCustomTaskType(
  taskType: string,
  custom: Record<string, string | number> | undefined,
  descriptor: CustomTaskType | undefined,
): CustomTaskTypeContext | undefined {
  if (!isNamespacedId(taskType)) return undefined
  const entries = Object.entries(custom ?? {})
  if (entries.length === 0) return undefined
  const declared = descriptor?.fields ?? []
  const byKey = new Map(declared.map((field) => [field.key, field]))
  const fields: CustomTaskFieldContext[] = []
  // Declared fields FIRST, in descriptor order: the org authored that order as the shape of its
  // brief, and a bag's key order is whatever the create form happened to send.
  for (const field of declared) {
    const value = custom?.[field.key]
    if (value === undefined || isBlank(value)) continue
    fields.push({ key: field.key, label: field.label, value: renderValue(value, field) })
  }
  // Then whatever the descriptor does not declare, under its raw key.
  for (const [key, value] of entries) {
    if (byKey.has(key) || isBlank(value)) continue
    fields.push({ key, value: renderValue(value, undefined) })
  }
  if (fields.length === 0) return undefined
  return { taskType, label: descriptor?.presentation.label ?? taskType, fields }
}
