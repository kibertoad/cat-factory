/**
 * The fields that mark the current row of a `UDropdownMenu`: the menu's own selected-state
 * attribute (`aria-current`), and a `current` slot whose `#current-trailing` template draws the
 * check. Nuxt UI's dropdown item has no `trailingIcon` field, and its `checkbox` type renders
 * without the item's `data-*` attributes, which the board rows' test hooks need. Spread it into
 * an item; a row that is not current gets nothing.
 */
export function currentMenuItem(isCurrent: boolean): { slot?: 'current'; 'aria-current'?: 'true' } {
  return isCurrent ? { slot: 'current', 'aria-current': 'true' } : {}
}
