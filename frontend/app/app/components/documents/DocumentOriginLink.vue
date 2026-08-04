<script setup lang="ts">
// A stored document rendered as a link to its origin page, or as a plain element when it has none.
//
// Not every document came from a page: an `upload` is a body handed to the platform through the
// public API, so it stores an empty `url`. An anchor with an empty `href` navigates to the current
// page, which reads as a link that BROKE rather than as a document that never had one — the same
// distinction kernel's `originSuffix` / `originHeaderLine` draw for the agent-facing renderers.
// One component so the three places the SPA lists documents cannot each get it half right.
const props = defineProps<{ url: string }>()
const { t } = useI18n()
</script>

<template>
  <component
    :is="props.url ? 'a' : 'span'"
    v-bind="
      props.url
        ? { href: props.url, title: props.url, target: '_blank', rel: 'noopener' }
        : { title: t('documents.taskDocs.uploadedHint') }
    "
  >
    <slot />
  </component>
</template>
