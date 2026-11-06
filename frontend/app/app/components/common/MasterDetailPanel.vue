<script setup lang="ts">
// The body of a master-detail picker popover (<PipelinePicker>, <RiskPolicyPicker>): the options
// on the left, a preview of the hovered or focused one on the right, each column scrolling alone.
//
// Its height is FIXED, never sized by its content. The preview changes with every hover, so a
// content-sized panel resized on each one; Floating UI then repositioned the popover and slid a
// different row under a still pointer, whose `mouseenter` swapped the preview again. The cap is
// `height`, held inside the space Reka reports the popover has. That variable is set only after the
// first positioning pass, so it falls back to the cap: without one the first flip decision would be
// made against the uncapped natural height and could pin the panel to the cramped side.
//
// Must render inside a Reka popover's content, which defines that variable. Listeners and
// attributes (`data-testid`, `@mouseleave`, `@focusout`) fall through to the root.
import { useTemplateRef } from 'vue'

const props = defineProps<{
  /** Height cap as a CSS length, e.g. `28rem`. */
  height: string
  /** Width cap as a CSS length; the panel never exceeds 94vw. */
  width: string
}>()

const root = useTemplateRef<HTMLElement>('root')
defineExpose({ root })
</script>

<template>
  <div
    ref="root"
    class="flex"
    :style="{
      height: `min(${props.height}, var(--reka-popover-content-available-height, ${props.height}))`,
      width: `min(${props.width}, 94vw)`,
    }"
  >
    <ul class="w-1/2 shrink-0 overflow-y-auto border-e border-default p-1">
      <slot name="options" />
    </ul>
    <div class="w-1/2 overflow-y-auto p-3">
      <slot name="detail" />
    </div>
  </div>
</template>
