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
  /**
   * Stable `v-for` key, also published as the row's `data-task-type-row` attribute so a caption
   * (whose `data-testid` repeats per row, exactly as `pipeline-step`'s does) is addressable through
   * its row instead of by position. Never rendered as text: `built-in`, `other`, or
   * `category:<folded caption>`.
   */
  id: string
  /**
   * The row's heading, or `null` for an UNCAPTIONED row. Deployment-authored and rendered verbatim
   * for a category row; the caller's localized chrome string for the leftovers row.
   */
  caption: string | null
  choices: TaskTypePickerChoice<T>[]
}

/** The localized CHROME captions the picker needs; every other caption is deployment-authored. */
export interface TaskTypePickerCaptions {
  /** Heading for the trailing row of custom types that declared no category. */
  other: string
}

/**
 * Lay the picker out as rows: the BUILT-IN types first in one uncaptioned row (the everyday
 * delivery loop stays where it has always been), then one captioned row per declared category in
 * first-appearance order (the deployment's own registration order, which is the only order it
 * expressed), then any uncategorized custom types in a trailing row captioned `captions.other`.
 *
 * Deliberately no collapsing, no overflow menu and no alphabetical re-sort: an operation catalog
 * that needs those has outgrown what a create-task dialog should be asking, and each would hide a
 * choice behind a second interaction.
 */
export function buildTaskTypePickerRows<T extends string>(
  builtIns: readonly TaskTypePickerChoice<T>[],
  customTypes: readonly CustomTaskType[],
  captions: TaskTypePickerCaptions,
): TaskTypePickerRow<T>[] {
  const rows: TaskTypePickerRow<T>[] = []
  if (builtIns.length > 0) rows.push({ id: 'built-in', caption: null, choices: [...builtIns] })

  const byCategory = new Map<string, { caption: string; choices: TaskTypePickerChoice<T>[] }>()
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
    const key = categoryKey(caption)
    const bucket = byCategory.get(key)
    if (bucket) bucket.choices.push(choice)
    else byCategory.set(key, { caption, choices: [choice] })
  }

  for (const [key, { caption, choices }] of byCategory)
    rows.push({ id: `category:${key}`, caption, choices })
  // The leftovers are captioned only when something PRECEDES them: as the picker's only row they
  // are the whole catalog, and a heading would then name a distinction the user cannot see.
  if (uncategorized.length > 0)
    rows.push({
      id: 'other',
      caption: rows.length > 0 ? captions.other : null,
      choices: uncategorized,
    })
  return rows
}

/**
 * The bucket a caption falls in: its own text folded on CASE and on whitespace runs, so two
 * spellings of one category ("API delivery" / "api  delivery") are ONE row rather than
 * near-duplicate headings sitting beside each other. The row still renders the FIRST-SEEN
 * spelling verbatim, because the caption is the deployment's own words.
 *
 * Deliberately NOT slugified: a caption is arbitrary Unicode (a deployment writes it in its own
 * language), so stripping it to an id-safe `[a-z0-9-]` key would fold genuinely distinct captions
 * onto each other ("Ámbito" and "Émbito" both reduce to `mbito`). That is also why the row id
 * carries the folded caption as-is and is addressed as an attribute VALUE rather than a testid.
 */
function categoryKey(caption: string): string {
  return caption.toLowerCase().replace(/\s+/g, ' ')
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
