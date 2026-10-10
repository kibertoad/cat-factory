import type { DropdownMenuItem } from '@nuxt/ui'
import type { PromptFragment } from '~/types/domain'

/** One category bucket: its heading plus the pool fragments that fall under it, in pool order. */
export interface FragmentCategoryGroup {
  category: string
  fragments: PromptFragment[]
}

/**
 * Bucket the pool fragments by `category`, preserving first-appearance category order and
 * per-category pool order. Unlike {@link buildFragmentPickerGroups} this keeps ALL fragments
 * (selected included) and returns the raw fragments, so a multi-select surface can render each
 * as a toggle that stays visible whether or not it is currently picked.
 */
export function buildFragmentCategoryGroups(pool: PromptFragment[]): FragmentCategoryGroup[] {
  const groups = new Map<string, PromptFragment[]>()
  for (const f of pool) {
    const items = groups.get(f.category) ?? []
    items.push(f)
    groups.set(f.category, items)
  }
  return [...groups.entries()].map(([category, fragments]) => ({ category, fragments }))
}

/**
 * Build the category-grouped groups for a fragment "add" dropdown: the pool fragments not
 * already selected, bucketed by `category`, each bucket prefixed with a non-interactive
 * `type: 'label'` heading so the catalog reads as labelled sections instead of one flat,
 * undifferentiated list. This matters now that the catalog spans distinct tracks that a
 * single block can pin together — the technical collections (Node / React / …) AND the
 * document Writing-style fragments — so the headings keep the longer, mixed list navigable.
 *
 * Category order follows first appearance in `pool`; empty categories are dropped. Each
 * inner array is one Nuxt UI menu group (rendered divider-separated); callers append their
 * own trailing groups (e.g. the library-management links) after the returned groups.
 */
export function buildFragmentPickerGroups(
  pool: PromptFragment[],
  isSelected: (id: string) => boolean,
  onSelect: (id: string) => void,
): DropdownMenuItem[][] {
  return buildFragmentCategoryGroups(pool)
    .map(({ category, fragments }): DropdownMenuItem[] => {
      const items = fragments
        .filter((f) => !isSelected(f.id))
        .map((f): DropdownMenuItem => ({ label: f.title, onSelect: () => onSelect(f.id) }))
      return items.length ? [{ type: 'label', label: category }, ...items] : []
    })
    .filter((group) => group.length > 0)
}
