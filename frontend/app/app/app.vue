<script setup lang="ts">
import AuthGate from '~/components/auth/AuthGate.vue'

// Drive the document's `lang`/`dir` from the active i18n locale. `useLocaleHead` derives
// these from the locale definitions in `nuxt.config.ts` (including the `dir: 'rtl'` flag on
// Hebrew), so switching to a RTL locale flips `<html dir="rtl" lang="he">` and the browser
// mirrors text alignment, flex/grid main-axis direction, and logical CSS properties. Wrapped
// in a getter so `useHead` tracks the reactive ref and re-applies on every locale change.
const localeHead = useLocaleHead()
useHead(() => ({
  htmlAttrs: {
    lang: localeHead.value.htmlAttrs?.lang,
    // `useLocaleHead` types `dir` loosely as string; our locales only ever set ltr/rtl.
    dir: localeHead.value.htmlAttrs?.dir as 'ltr' | 'rtl' | 'auto' | undefined,
  },
}))
</script>

<template>
  <UApp>
    <AuthGate>
      <NuxtPage />
    </AuthGate>
  </UApp>
</template>
