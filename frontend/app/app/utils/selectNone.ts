/**
 * The "no value" row of a `USelect` / `USelectMenu` (inherit, not set, the default), and the
 * mapping between it and the empty value the component stores and sends.
 *
 * Reka's `SelectItem` and `ComboboxItem` THROW in `setup` when an item's value is the empty
 * string, because Reka reserves `''` on the root to mean "cleared, show the placeholder". So the
 * row carries a non-empty sentinel instead, and the component binds the select through
 * {@link selectNoneModel}, which maps both ways in one place. What the component stores and sends
 * does not change.
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

/** The select's model, read and written through the sentinel mapping. */
export interface SelectNoneModel<T extends string> {
  value: T | typeof SELECT_NONE
}

/**
 * A `v-model` target for a select with a "no value" row: `get` reads the stored value and `set`
 * receives the picked one with the sentinel already mapped back to `''`. Bind it as
 * `v-model="model.value"`. It is a plain accessor, not a ref, so a row inside a `v-for` can build
 * its own with a call in the template. Reads stay reactive because `get` reads the store.
 */
export function selectNoneModel<T extends string>(
  get: () => T | '' | null | undefined,
  set: (value: T | '') => void,
): SelectNoneModel<T> {
  return {
    get value() {
      return toSelectValue(get())
    },
    set value(picked) {
      set(fromSelectValue(picked))
    },
  }
}
