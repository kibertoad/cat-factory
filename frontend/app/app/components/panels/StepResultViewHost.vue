<script setup lang="ts">
// Universal dedicated-result-view host (slice 2 of the modular-vue adoption —
// docs/initiatives/modular-vue-adoption.md). An agent archetype can declare a
// `resultView` id (see `~/utils/catalog`); when a step of that kind is opened,
// `ui.resultView` is set and this host mounts the matching registered window
// instead of the generic `AgentStepDetail` prose panel.
//
// The registry is no longer a hardcoded `Record` here — every built-in window is
// contributed to the modular `resultViews` slot (`~/modular/result-views`), and
// a consumer deployment adds its OWN window to the SAME slot from a
// `registerAppModule` module. This host reads the merged slot reactively via
// `useReactiveSlots` and indexes it with `resolveComponentRegistry`; the kind's
// (or custom kind's) `resultView` id selects the component. Adding a bespoke
// visualization for a new agent is: declare `resultView: '<id>'` on its
// archetype + contribute `{ id: '<id>', component }` to the `resultViews` slot.
//
// Each registered window builds on `useResultView(viewId, { onOpen })`, which
// owns the seam contract (open/blockId/close + Escape + load-on-open) so a new
// window can't reintroduce the route-dependent empty-state bug by forgetting to
// fetch on mount.
import { computed, watchEffect, type Component } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { pairById, resolveComponentRegistry } from '@modular-vue/core'
import type { AppSlots } from '~/modular/slots'

const ui = useUiStore()
const agents = useAgentsStore()
const slots = useReactiveSlots<AppSlots>()

// Index the merged `resultViews` slot into an id → component registry. Duplicate
// ids throw by default (`resolveComponentRegistry`) — two modules claiming the
// same view id is a wiring bug, not a silent last-wins. Recomputed if a consumer
// module's contributions change (they don't after boot, but the read is cheap).
const registry = computed(() => resolveComponentRegistry(slots.value.resultViews ?? []))

const active = computed<Component | null>(() => {
  const view = ui.resultView?.view
  if (!view) return null
  return registry.value.get(view) ?? null
})

// Dev guard: surface any CUSTOM kind whose declared `resultView` id resolves to
// no registered component (a dangling reference — e.g. a backend kind naming a
// consumer view this build doesn't ship). `pairById`'s `missing` bucket makes
// the degradation explicit instead of a silent fall-through to the prose panel.
if (import.meta.dev) {
  watchEffect(() => {
    const { missing } = pairById(agents.customArchetypes, registry.value, (a) => a.resultView)
    if (missing.length) {
      console.warn(
        `[StepResultViewHost] custom agent kind(s) reference unregistered resultView id(s): ` +
          missing.map((m) => `${m.item.kind}→${m.id}`).join(', ') +
          `. Register a component for the id in a resultViews-slot module.`,
      )
    }
  })
}
</script>

<template>
  <component :is="active" v-if="active" />
</template>
