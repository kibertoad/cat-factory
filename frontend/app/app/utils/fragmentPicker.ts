import type { DropdownMenuItem } from '@nuxt/ui'
import type { PromptFragment } from '~/types/domain'

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
  const groups = new Map<string, DropdownMenuItem[]>()
  for (const f of pool) {
    if (isSelected(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => onSelect(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.entries()].map(([category, items]): DropdownMenuItem[] => [
    { type: 'label', label: category },
    ...items,
  ])
}
