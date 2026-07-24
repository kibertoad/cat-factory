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
import { computed, type Component } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { resolveComponentRegistry } from '@modular-vue/core'
import type { AppSlots } from '~/modular/slots'

const ui = useUiStore()
const slots = useReactiveSlots<AppSlots>()

// Index the merged `appOverlays` slot into an id → component registry. Duplicate ids throw by
// default (`resolveComponentRegistry`) — two modules claiming the same overlay id is a wiring
// bug, validated once at boot in `modular.client.ts` and cheaply memoized here.
const registry = computed(() => resolveComponentRegistry(slots.value.appOverlays ?? []))

const active = computed<Component | null>(() => {
  const id = ui.activeOverlay?.id
  if (!id) return null
  const component = registry.value.get(id) ?? null
  // A dangling open (`openOverlay('acme:x')` with no registered component — e.g. a stale nav
  // closure after an extension was removed) degrades to nothing rather than crashing.
  if (import.meta.dev && !component) {
    console.warn(
      `[AppOverlayHost] ui.openOverlay('${id}') has no registered component. ` +
        `Contribute { id: '${id}', component } to the appOverlays slot in a registerAppModule module.`,
    )
  }
  return component
})
</script>

<template>
  <component
    :is="active"
    v-if="active"
    :subject="ui.activeOverlay?.subject"
    @close="ui.closeOverlay()"
  />
</template>
