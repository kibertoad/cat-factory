<script setup lang="ts">
// Universal CONSUMER-overlay host (extension slice D — the frontend-extension-mechanism
// initiative, docs/initiatives/frontend-extension-mechanism.md). The one top-level surface a
// consumer deployment could not extend before: `pages/index.vue` hand-mounts every first-party
// modal as a `v-if`, so a consumer nav item's `run` closure had nothing to open. This host is
// the seam — a deployment registers `{ id: '<ns>:<name>', component }` in the `appOverlays` slot
// and opens it with `ui.openOverlay(id, subject?)` (usually via `useAppOverlays().open(...)`).
//
// The mechanism is the same slice-2 pick-one primitive `StepResultViewHost` uses: index the
// merged `appOverlays` slot into an id → component registry via `resolveComponentRegistry`, and
// mount the entry whose id matches the active `ui.activeOverlay` pointer. Only ONE consumer
// overlay is open at a time. The mounted overlay receives the optional `subject` as a prop and
// emits `close` (the consumer overlay composes `ResultWindowShell` / `useModalBehavior` for its
// own chrome, so Escape/backdrop/focus-trap are inherited — see the consumer-extensions guide).
//
// First-party modals stay hand-mounted in `index.vue`; this seam is deliberately scoped to
// consumer extensions (strangler discipline — the ~34 existing lazy modals are not migrated).
import { computed, watchEffect, type Component } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import type { AppSlots } from '~/modular/slots'
import { selectOverlay } from './AppOverlayHost.logic'

const ui = useUiStore()
const slots = useReactiveSlots<AppSlots>()

// Pick the component for the active overlay id via the pure `selectOverlay` helper (indexes the
// merged `appOverlays` slot with `resolveComponentRegistry`; duplicate ids throw, validated once
// at boot in `modular.client.ts`). Recomputed if a consumer module's contributions change (they
// don't after boot, but the read is cheap).
const selection = computed(() => selectOverlay(slots.value.appOverlays ?? [], ui.activeOverlay?.id))
const active = computed<Component | null>(() => selection.value.component)

// Dev guard: a dangling open (`openOverlay('acme:x')` with no registered component — e.g. a stale
// nav closure after an extension was removed) degrades to nothing rather than crashing. Kept in a
// `watchEffect` — not the `computed` above — so the selection stays side-effect-free, mirroring
// `StepResultViewHost`.
if (import.meta.dev) {
  watchEffect(() => {
    if (selection.value.missing) {
      const id = ui.activeOverlay?.id
      console.warn(
        `[AppOverlayHost] ui.openOverlay('${id}') has no registered component. ` +
          `Contribute { id: '${id}', component } to the appOverlays slot in a registerAppModule module.`,
      )
    }
  })
}
</script>

<template>
  <component
    :is="active"
    v-if="active"
    :subject="ui.activeOverlay?.subject"
    @close="ui.closeOverlay()"
  />
</template>
