<script setup lang="ts">
// The one section "eyebrow": the small uppercase label that titles a group inside a panel, a
// result window, an inspector section or a dropdown (issue #2248).
//
// Before this component the same label existed in at least six hand-written recipes, crossing
// three sizes (`text-[11px]`, `text-[10px]`, `text-[9px]`), two weights (`font-semibold`,
// `font-medium`) and two colours (`text-dimmed`, `text-muted`), so two panels side by side
// disagreed about what a section heading looks like. The recipe:
//
//   text-2xs  font-semibold  uppercase  tracking-wide  text-muted
//
// Those five are the whole component and are NOT overridable. A caller that wants a different
// size or colour wants a different thing, not a variant of this one.
//
// SIZE and WEIGHT are the plurality of what was already there. COLOUR deliberately is NOT, and
// that is the one line here worth not "correcting" later: 211 of the 313 labels were
// `text-dimmed`, but at this size that token is 2.63:1 on a light surface, under WCAG AA's 4.5:1
// and under even the 3:1 large-text floor. `text-muted` is 4.76:1. A plurality counts what the
// codebase drifted into; it does not decide which value is legible, and here the two answers
// diverge. So the 211 get DARKER rather than 102 getting fainter.
//
// Adopting the component is still a VISIBLE change at every site that was not already on the
// recipe: a label that was `text-[10px]` or `text-[9px]` grows to 11px, one that was `text-xs`
// or `text-sm` shrinks to 11px, and one that carried no weight gains `font-semibold`. That is
// the "decide it once" half of #2248 rather than a side effect.
//
// The SPA's overall contrast floor (`text-dimmed` is used well beyond this component) is
// separate work and is NOT what this recipe is trying to fix.
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
