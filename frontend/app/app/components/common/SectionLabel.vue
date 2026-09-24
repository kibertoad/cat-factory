<script setup lang="ts">
// The one section "eyebrow": the small uppercase label that titles a group inside a panel, a
// result window, an inspector section or a dropdown (issue #2248).
//
// Before this component the same label existed in at least six hand-written recipes, crossing
// three sizes (`text-[11px]`, `text-[10px]`, `text-[9px]`), two weights (`font-semibold`,
// `font-medium`) and two colours (`text-dimmed`, `text-muted`), so two panels side by side
// disagreed about what a section heading looks like. The recipe below is the plurality of what
// was already there, so most call sites render byte-identically:
//
//   text-2xs  font-semibold  uppercase  tracking-wide  text-dimmed
//
// Those five are the whole component and are NOT overridable. A caller that wants a different
// size or colour wants a different thing, not a variant of this one.
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
  <component :is="as" class="text-2xs font-semibold uppercase tracking-wide text-dimmed">
    <slot />
  </component>
</template>
