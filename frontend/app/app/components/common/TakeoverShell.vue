<script setup lang="ts">
// The one root of every full-bleed takeover: the step reader (`AgentStepDetail`), the model
// configuration takeover, the observability, reports, operator dashboard and Kaizen panels, and the
// artifact lightbox. It owns the root element and the modal BEHAVIOUR; each takeover keeps its own
// layout, header and backdrop inside it.
//
// The behaviour is the upstream `useModalBehavior` (`@modular-vue/core`), the same composable
// `ResultWindowShell` uses: a focus trap, focus return, a body-scroll lock, and a ticket on the
// shared overlay STACK, so Escape closes only the top overlay. Before this shell, six of the seven
// takeovers hand-rolled a window Escape listener instead. Tab then walked out to the board behind
// them, and one Escape closed every overlay that listened, so a result window or the observability
// panel opened over the step reader took the reader down with it.
//
// Why not `UModal fullscreen` (the shape `GuidedReviewModal` uses): a Reka modal makes the body
// inert while it is up (`pointer-events: none` on `<body>`, a `focusin` trap, and a dismiss on any
// pointer or focus outside its content). The windows opened ON TOP of a takeover
// (`ResultWindowShell`, the lightbox, a modular overlay) are not Reka layers, so they would open
// unclickable and lose focus to the takeover under them. The shared stack is what both sides
// agree on: every open Nuxt UI menu, select, popover and modal holds a ticket on it
// (`utils/foreignLayers.ts`), so one opened inside a takeover is the top overlay and keeps its own
// Escape.
//
// The takeover is OPEN while this shell is mounted: each site gates it with its own `v-if` inside
// its own `Teleport` and `Transition`, so a fade owned by a parent mount (`pages/index.vue` for the
// step reader) still plays in both directions.
import { onMounted, ref } from 'vue'
import { useModalBehavior } from '@modular-vue/core'
import { FULL_BLEED_TAKEOVER_CLASS } from '~/utils/safeArea'

const props = defineProps<{
  /** The accessible name of the dialog. */
  label: string
  /**
   * What the takeover shows now, for a takeover that swaps its content without closing (the step
   * reader moving to another step). A change moves focus back to the top of the dialog.
   */
  contentKey?: string | number | null
}>()

const emit = defineEmits<{ close: [] }>()

// The behaviour activates on MOUNT, not in setup. Most takeovers are async views, and on their first
// open Nuxt's Suspense defers the mount, so focus moved during setup would find no element yet and
// stay on the board.
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

// Initial focus goes to the dialog root, not to its first control: a takeover is a whole screen of
// content, so the reader starts at its top and the first Tab reaches the first control.
const { dialogRef, isTop } = useModalBehavior({
  active: mounted,
  onClose: () => emit('close'),
  initialFocus: () => dialogRef.value,
  contentKey: () => props.contentKey,
})

// A takeover with its own keys (the lightbox's arrows and zoom) reads this, so its keys stay inert
// while another overlay is on top of it.
defineExpose({ isTop })
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    :aria-label="label"
    class="focus:outline-none"
    :class="FULL_BLEED_TAKEOVER_CLASS"
  >
    <slot />
  </div>
</template>
