import { describe, it, expect } from 'vitest'
import { useUiStore } from '~/stores/ui'
import { createUiNavigation } from '~/stores/ui/navigation'
import { createUiResultViews } from '~/stores/ui/resultViews'
import { createUiModals } from '~/stores/ui/modals'

/**
 * `ui.ts` is a thin facade composing three slices (`navigation` / `resultViews` / `modals`)
 * behind ONE unchanged public surface (refactoring candidate #4). These tests pin that
 * invariant so a future slice edit can't silently drop, shadow, or duplicate a key that a
 * `useUiStore()` consumer depends on — the split must stay purely internal.
 */
describe('ui store — facade composes the slices with no surface drift', () => {
  it('exposes exactly the union of the three slices, with no cross-slice key collisions', () => {
    const nav = Object.keys(createUiNavigation())
    const results = Object.keys(createUiResultViews())
    const modals = Object.keys(createUiModals())
    const sliceKeys = [...nav, ...results, ...modals]

    // No two slices declare the same key — a collision would silently drop one on spread.
    expect(new Set(sliceKeys).size).toBe(sliceKeys.length)

    // The store surface is precisely the union of the slices — nothing added, nothing lost.
    // (Filter out Pinia's own `$`/`_`-prefixed API, which no slice key uses.)
    const storeKeys = Object.keys(useUiStore()).filter(
      (k) => !k.startsWith('$') && !k.startsWith('_'),
    )
    expect(storeKeys.sort()).toEqual([...new Set(sliceKeys)].sort())
  })
})
