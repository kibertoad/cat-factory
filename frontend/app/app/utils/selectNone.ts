/**
 * The "no value" row of a `USelect` / `USelectMenu` (inherit, not set, the default), and the
 * mapping between it and the empty value the component stores and sends.
 *
 * Reka's `SelectItem` and `ComboboxItem` THROW in `setup` when an item's value is the empty
 * string, because Reka reserves `''` on the root to mean "cleared, show the placeholder". So the
 * row carries a non-empty sentinel instead, and each component maps at its boundary: the stored
 * value goes through {@link toSelectValue} on the way into the select and the picked value through
 * {@link fromSelectValue} on the way out. What the component stores and sends does not change.
 *
 * `scripts/check-frontend-select-values.mjs` refuses an item literal with `value: ''`, so a new
 * select builds its row with {@link selectNoneItem}.
 */
export const SELECT_NONE = '__none__'

/** The "no value" item, labelled with the caller's own translated copy. */
export function selectNoneItem(label: string): { label: string; value: typeof SELECT_NONE } {
  return { label, value: SELECT_NONE }
}

/** A stored value as the select's model: an empty or absent value becomes the sentinel. */
export function toSelectValue<T extends string>(
  value: T | '' | null | undefined,
): T | typeof SELECT_NONE {
  return value ? value : SELECT_NONE
}

/** A picked value as the component stores it: the sentinel becomes the empty string. */
export function fromSelectValue<T extends string>(value: T | typeof SELECT_NONE): T | '' {
  return value === SELECT_NONE ? '' : value
}
