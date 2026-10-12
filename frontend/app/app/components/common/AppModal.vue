<script setup lang="ts">
// The app's modal: `UModal` at one of the named overlay widths (`utils/overlaySize.ts`, #2251).
//
// `UModal` has no `size` prop, and a `size` variant under `app.config.ts`'s `ui.modal` would never
// be selected (Nuxt UI passes only `transition`, `fullscreen`, `overlay` and `scrollable` into the
// variant function), so the width lives here and reaches the modal through `ui.content`. A call
// site still passes any other `ui` slot, and any other content class (a z-index), unchanged.
//
// Every other prop, listener and slot passes straight through to `UModal`.
import { computed } from 'vue'
import type { ModalProps } from '@nuxt/ui'
import { OVERLAY_WIDTH_CLASS, type OverlaySize } from '~/utils/overlaySize'

const props = defineProps<{
  /** What kind of dialog this is; the width follows from it. */
  size: OverlaySize
  ui?: ModalProps['ui']
}>()
defineOptions({ inheritAttrs: false })

const ui = computed(() => ({
  ...props.ui,
  content: [OVERLAY_WIDTH_CLASS[props.size], props.ui?.content].filter(Boolean).join(' '),
}))
</script>

<template>
  <UModal v-bind="$attrs" :ui="ui">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </UModal>
</template>
