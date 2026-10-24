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
// Every takeover paints at the SAME z-index (`z-50`, as `ResultWindowShell` does) and is teleported
// to `<body>` when it opens, so DOM order is open order: the overlay stack's top ticket is also the
// top layer. A per-site z-index let a later-opened `z-50` takeover take focus and Escape while
// painting under an earlier `z-[60]` one.
//
// The takeover is OPEN while this shell is mounted: each site gates it with its own `v-if` inside
// its own `Teleport` and `Transition`, so a fade owned by a parent mount (`pages/index.vue` for the
// step reader) still plays in both directions.
import { useMounted } from '@vueuse/core'
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
const mounted = useMounted()

// Initial focus goes to the dialog root, not to its first control: a takeover is a whole screen of
// content, so the reader starts at its top and the first Tab reaches the first control.
const { dialogRef, isTop } = useModalBehavior({
  active: mounted,
  onClose: () => emit('close'),
  initialFocus: () => dialogRef.value,
  contentKey: () => props.contentKey,
})

// The trap wraps Tab only when focus is outside the dialog or on its first or last control, and the
// root is none of those, so the first Shift+Tab from the root would leave for the board behind
// (the browser moves to the last tabbable element before the root in DOM order). Wrap it here.
// Hidden controls (`display: none`, such as the reader's outline below `md`) cannot take focus, so
// they are skipped.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function wrapShiftTabFromRoot(event: KeyboardEvent): void {
  const root = dialogRef.value
  if (event.key !== 'Tab' || !event.shiftKey || !root || event.target !== root) return
  const controls = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const last = controls.findLast((el) => el.checkVisibility())
  if (!last) return
  event.preventDefault()
  last.focus()
}

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
    class="z-50 focus:outline-none"
    :class="FULL_BLEED_TAKEOVER_CLASS"
    @keydown="wrapShiftTabFromRoot"
  >
    <slot />
  </div>
</template>
