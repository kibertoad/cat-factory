<script setup lang="ts">
// The one place `animate-spin` is written (`scripts/check-frontend-feedback.mjs` enforces it).
//
// Use it only where no Nuxt UI component carries the state: `UButton`, `UInput`, `USelectMenu` and
// the rest take `:loading`, and that prop is the answer there. This is for a bare icon that shows
// work in progress: a step-status glyph, a "loading…" line, a full-panel wait.
//
// `spinning` lets a status icon keep ONE element across its states (a step glyph that spins while
// it runs and stops when it settles) instead of two branches. `name` defaults to Nuxt UI's own
// loading icon, so a plain spinner matches the one `:loading` draws inside a button. Size and
// colour are the caller's classes, which land on the icon.
//
// `motion-safe:` so a reader who asked the OS for reduced motion sees the icon still; the state
// is carried by the icon itself and its surrounding copy, never by the motion alone.
withDefaults(defineProps<{ name?: string; spinning?: boolean }>(), {
  name: undefined,
  spinning: true,
})

const appConfig = useAppConfig()
</script>

<template>
  <UIcon
    :name="name ?? appConfig.ui.icons.loading"
    :class="spinning ? 'motion-safe:animate-spin' : ''"
  />
</template>
