/**
 * The tab an emitted `UTabs` value names, or `undefined` when it names none of the items.
 *
 * `UTabs` emits its model as `string | number`, and an item without a `value` falls back to its
 * index as a string. A surface's tab ref holds a narrower union, and `v-model` writes the emitted
 * value into it unchecked, so an unknown key would leave every panel's `v-if` false and the
 * surface blank with no type error. Bind `:model-value` and narrow the update through this, and
 * the ref only ever holds a tab that exists:
 *
 * `@update:model-value="(v) => (tab = knownTab(tabs, v) ?? tab)"`
 */
export function knownTab<T extends string>(
  items: readonly { value: T }[],
  value: string | number,
): T | undefined {
  return items.find((item) => item.value === value)?.value
}
