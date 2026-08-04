import type { CustomTaskType } from '~/types/domain'

/**
 * The create-task type picker's layout rule (reusable-operations initiative, slice 3).
 *
 * The picker was one flat button row, which is right for the handful of built-in types and wrong
 * the moment a deployment registers a catalog of REUSABLE OPERATIONS: an org with twenty of them
 * ("Introduce API", "Retire endpoint", "Add tenant", …) turns the row into an undifferentiated
 * wall in which the everyday `feature` / `bug` choices are no longer findable. Each custom type
 * may declare a `presentation.category`, and this is where that axis becomes rows.
 *
 * Extracted rather than inlined in `AddTaskModal.vue` for the same reason as
 * `buildFragmentCategoryGroups`: the ORDER is the behaviour worth pinning, and a rule inside an
 * SFC is only reachable by mounting one.
 */

/** One selectable type in the picker. */
export interface TaskTypePickerChoice<T extends string = string> {
  /** The task type id submitted on create. */
  value: T
  /** Button label: an i18n string for a built-in, the verbatim wire presentation for a custom type. */
  label: string
  /** Icon id (`i-lucide-*`). */
  icon: string
  /**
   * The deployment-authored one-liner from a CUSTOM type's presentation, rendered verbatim (never
   * i18n). Absent for a built-in type, whose meaning is fixed and whose label is already localized.
   */
  description?: string
}

/** One row of the picker: the choices under an optional caption. */
export interface TaskTypePickerRow<T extends string = string> {
  /** Stable `v-for` key; never rendered. */
  id: string
  /** The deployment-authored category caption, or `null` for an UNCAPTIONED row. */
  caption: string | null
  choices: TaskTypePickerChoice<T>[]
}

/**
 * Lay the picker out as rows: the BUILT-IN types first in one uncaptioned row (the everyday
 * delivery loop stays where it has always been), then one captioned row per declared category in
 * first-appearance order (the deployment's own registration order, which is the only order it
 * expressed), then any uncategorized custom types in a trailing uncaptioned row.
 *
 * Deliberately no collapsing, no overflow menu and no alphabetical re-sort: an operation catalog
 * that needs those has outgrown what a create-task dialog should be asking, and each would hide a
 * choice behind a second interaction.
 */
export function buildTaskTypePickerRows<T extends string>(
  builtIns: readonly TaskTypePickerChoice<T>[],
  customTypes: readonly CustomTaskType[],
): TaskTypePickerRow<T>[] {
  const rows: TaskTypePickerRow<T>[] = []
  if (builtIns.length > 0) rows.push({ id: 'built-in', caption: null, choices: [...builtIns] })

  const byCategory = new Map<string, TaskTypePickerChoice<T>[]>()
  const uncategorized: TaskTypePickerChoice<T>[] = []
  for (const type of customTypes) {
    const choice = toChoice<T>(type)
    // A category is `v.trim()`-ed on the wire, but a CODE-shipped consumer type is trusted and
    // unvalidated (see `docs/consumer-extensions.md`), so a whitespace-only caption is possible
    // and must read as "no category" rather than render an empty heading.
    const caption = type.presentation.category?.trim()
    if (!caption) {
      uncategorized.push(choice)
      continue
    }
    const bucket = byCategory.get(caption)
    if (bucket) bucket.push(choice)
    else byCategory.set(caption, [choice])
  }

  for (const [caption, choices] of byCategory)
    rows.push({ id: `category:${caption}`, caption, choices })
  if (uncategorized.length > 0)
    rows.push({ id: 'uncategorized', caption: null, choices: uncategorized })
  return rows
}

/**
 * A registered custom type as a picker choice. The id assertion carries the widened `taskType`
 * contract (`<built-in> | <ns>:<name>`): a namespaced registered id IS a legal create-task value,
 * which is what let `AddTaskModal` offer these choices in the first place.
 */
function toChoice<T extends string>(type: CustomTaskType): TaskTypePickerChoice<T> {
  const { label, icon, description } = type.presentation
  return { value: type.taskType as T, label, icon, ...(description ? { description } : {}) }
}
