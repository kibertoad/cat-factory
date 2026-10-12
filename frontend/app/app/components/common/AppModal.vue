<script setup lang="ts">
// The app's modal: `UModal` at one of the named overlay widths (`utils/overlaySize.ts`, #2251).
//
// `UModal` has no `size` prop, and a `size` variant under `app.config.ts`'s `ui.modal` would never
// be selected (Nuxt UI passes only `transition`, `fullscreen`, `overlay` and `scrollable` into the
// variant function), so the width lives here and reaches the modal through `ui.content`. A call
// site still passes any other `ui` slot, and any other content class (a z-index), unchanged.
//
// Every other prop, listener and slot passes straight through to `UModal`. The props interface
// extends `ModalProps` so a call site is still type-checked against `UModal`, and `@vue-ignore`
// keeps those props out of the runtime declaration: declared, an absent boolean such as
// `dismissible` would arrive as `false` and override `UModal`'s own default.
import { computed } from 'vue'
import type { ModalProps } from '@nuxt/ui'
import { OVERLAY_WIDTH_CLASS, type OverlaySize } from '~/utils/overlaySize'

interface AppModalProps extends /* @vue-ignore */ Omit<ModalProps, 'ui'> {
  /** What kind of dialog this is; the width follows from it. */
  size: OverlaySize
  ui?: ModalProps['ui']
}

const props = defineProps<AppModalProps>()
defineOptions({ inheritAttrs: false })

type ContentClass = NonNullable<ModalProps['ui']>['content']

// A `ui` slot takes any class value or a replacer function (`(defaults) => classes`), so the width
// joins the caller's value as a class list, never as a joined string. A replacer returns the slot's
// whole class list, which can keep the theme's default `max-w-lg`, so the width goes after it.
function withWidth(width: string, content: ContentClass): ContentClass {
  if (typeof content === 'function') return (defaults) => [content(defaults), width]
  return [width, content]
}

const ui = computed(() => ({
  ...props.ui,
  content: withWidth(OVERLAY_WIDTH_CLASS[props.size], props.ui?.content),
}))
</script>

<template>
  <UModal v-bind="$attrs" :ui="ui">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </UModal>
</template>
