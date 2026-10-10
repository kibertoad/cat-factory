<script setup lang="ts">
// Shared icon-only button primitive that ENFORCES the accessible-name convention (UX-62/63):
// every icon button must carry a `label`, applied as BOTH `title` (pointer tooltip) and
// `aria-label` (screen readers) — `title` alone never fires on touch and is invisible to
// assistive tech, so an unlabeled icon button is a bug this component makes unrepresentable.
// All other UButton props/listeners (icon, color, variant, size, @click, :loading, :disabled)
// pass straight through via `$attrs`; `label` is declared as a prop so it strips off before
// reaching UButton (whose own `label` prop would otherwise render visible text). Mirrors the
// shape of `common/CopyButton.vue`.
defineProps<{
  /** Accessible name + tooltip. Required — the whole point of the primitive. */
  label: string
}>()
defineOptions({ inheritAttrs: false })
</script>

<template>
  <UButton v-bind="$attrs" :title="label" :aria-label="label" />
</template>
