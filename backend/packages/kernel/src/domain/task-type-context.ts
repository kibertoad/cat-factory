import type { CustomTaskType, TaskTypeFieldDescriptor } from '@cat-factory/contracts'

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

/** Render one collected value as prose: an option's caption where the descriptor declares one. */
function renderValue(
  value: string | number,
  descriptor: TaskTypeFieldDescriptor | undefined,
): string {
  if (typeof value === 'number') return String(value)
  return descriptor?.options?.find((option) => option.value === value)?.label ?? value
}

/**
 * Join a block's collected custom-task-type values with the registered descriptor for its type.
 * Returns undefined when the bag is absent or empty, so a run without collected parameters carries
 * no context field and every existing prompt stays byte-identical.
 *
 * `descriptor` is the registration for `taskType`, or undefined when the deployment registers none
 * (see the drift note above: an absent registration costs labels and ordering, never values).
 */
export function describeCustomTaskType(
  taskType: string,
  custom: Record<string, string | number> | undefined,
  descriptor: CustomTaskType | undefined,
): CustomTaskTypeContext | undefined {
  const entries = Object.entries(custom ?? {})
  if (entries.length === 0) return undefined
  const declared = descriptor?.fields ?? []
  const byKey = new Map(declared.map((field) => [field.key, field]))
  const fields: CustomTaskFieldContext[] = []
  // Declared fields FIRST, in descriptor order: the org authored that order as the shape of its
  // brief, and a bag's key order is whatever the create form happened to send.
  for (const field of declared) {
    const value = custom?.[field.key]
    if (value === undefined || value === '') continue
    fields.push({ key: field.key, label: field.label, value: renderValue(value, field) })
  }
  // Then whatever the descriptor does not declare, under its raw key.
  for (const [key, value] of entries) {
    if (byKey.has(key) || value === '') continue
    fields.push({ key, value: renderValue(value, undefined) })
  }
  if (fields.length === 0) return undefined
  return { taskType, label: descriptor?.presentation.label ?? taskType, fields }
}
