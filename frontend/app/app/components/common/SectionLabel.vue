<script setup lang="ts">
// The one section "eyebrow": the small uppercase label that titles a group inside a panel, a
// result window, an inspector section or a dropdown (issue #2248).
//
// The recipe:
//
//   text-2xs  font-semibold  uppercase  tracking-wide  text-muted
//
// Those five are the whole component and are NOT overridable. A caller that wants a different
// size or colour wants a different thing, not a variant of this one.
//
// The colour is `text-muted`, not `text-dimmed`, for contrast: at this size `text-dimmed` is 2.63:1
// on a light surface, under WCAG AA's 4.5:1 and under the 3:1 large-text floor. `text-muted` is
// 4.76:1. Do not "correct" it to the fainter token.
//
// A label that merely SHARES the uppercase styling is not this component: a pill or chip carrying
// a fill and a radius, an accent-coloured label signalling state or category, or a metadata row
// (`board/nodes/BlockNode.vue`'s composition line) that states counts rather than titling the
// block after it. Those keep their own classes on a named step.
//
// What a caller DOES control:
//   - `as`, the element. The default `div` suits a label that titles a region without being a
//     document heading; pass `h3` / `h4` when the section is a real heading, `label` with an `:id`
//     when it names a field, `button` when the section collapses.
//   - Layout, through the ordinary `class` attribute (`mb-2`, `px-2 pt-2`), which Vue merges onto
//     the root. Spacing is the caller's business because it belongs to the surrounding block.
//   - Every other attribute and listener, which fall through to the root element.
withDefaults(defineProps<{ as?: string }>(), { as: 'div' })
</script>

<template>
  <component :is="as" class="text-2xs font-semibold uppercase tracking-wide text-muted">
    <slot />
  </component>
</template>
