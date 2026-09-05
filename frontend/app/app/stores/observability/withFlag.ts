import type { Ref } from 'vue'

/** Add or remove a key from a reactive `Set` ref, replacing it so the reactivity fires. */
export function withFlag(set: Ref<Set<string>>, key: string, on: boolean) {
  const next = new Set(set.value)
  if (on) next.add(key)
  else next.delete(key)
  set.value = next
}
