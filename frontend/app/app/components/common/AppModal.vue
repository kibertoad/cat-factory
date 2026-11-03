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
import type { ModalProps } from '@nuxt/ui'
import { OVERLAY_WIDTH_CLASS, type OverlaySize } from '~/utils/overlaySize'

interface AppModalProps extends /* @vue-ignore */ Omit<ModalProps, 'ui'> {
  /** What kind of dialog this is; the width follows from it. */
  size: OverlaySize
  ui?: ModalProps['ui']
}

const props = defineProps<AppModalProps>()
defineOptions({ inheritAttrs: false })

// A fullscreen modal fills the viewport (`inset-0`, no max-width), so it takes no width. `fullscreen`
// arrives as an attr, so it is read where the template renders and follows a bound value such as
// `:fullscreen="isPhone"`. The bare attribute arrives as `''`.
function isFullscreen(attrs: Record<string, unknown>) {
  return attrs.fullscreen !== undefined && attrs.fullscreen !== false
}

type ContentClass = NonNullable<ModalProps['ui']>['content']

// The width joins the caller's `content` value as a class list. A replacer function in that list
// still gets the plain classes appended after its result (Nuxt UI's `tv.js` finds it inside the
// array), though the `ui` type only admits a replacer standing alone, hence the cast.
function uiWithWidth(attrs: Record<string, unknown>): ModalProps['ui'] {
  if (isFullscreen(attrs)) return props.ui
  const content = [OVERLAY_WIDTH_CLASS[props.size], props.ui?.content] as ContentClass
  return { ...props.ui, content }
}
</script>

<template>
  <UModal v-bind="$attrs" :ui="uiWithWidth($attrs)">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </UModal>
</template>
