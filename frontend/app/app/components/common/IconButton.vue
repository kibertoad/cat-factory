<script setup lang="ts">
// Shared icon-only button primitive that ENFORCES the accessible-name convention (UX-62/63):
// every icon button must carry a `label`, applied as BOTH the tooltip and `aria-label` (screen
// readers): an unlabeled icon button is a bug this component makes unrepresentable.
//
// The hint is a UTooltip, not a `title` attribute: `title` never fires on touch, is not styled,
// takes about a second to appear, and is not what the rest of the app's tooltips look like.
// `aria-label` stays on the button itself, because the tooltip is a hover/focus affordance and
// the accessible NAME has to be there whether or not one ever opens.
//
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
  <UTooltip :text="label">
    <!-- The trigger is a SPAN around the button, not the button. A disabled `<button>` fires no
         pointer or focus event, so a tooltip bound straight to it never opens: the one state
         where the hint is the only thing explaining why the control does nothing (a blocked
         delete naming its reason) was exactly the state that lost it. The span is
         `inline-flex` so it adds no box of its own. -->
    <span class="inline-flex">
      <UButton v-bind="$attrs" :aria-label="label" />
    </span>
  </UTooltip>
</template>
