<script setup lang="ts">
// A stored document rendered as a link to its origin page, or as a plain element when it has none.
//
// Not every document came from a page: an `upload` is a body handed to the platform through the
// public API, so it stores an empty `url`. An anchor with an empty `href` navigates to the current
// page, which reads as a link that BROKE rather than as a document that never had one — the same
// distinction kernel's `originSuffix` / `originHeaderLine` draw for the agent-facing renderers.
// One component so the three places the SPA lists documents cannot each get it half right.
//
// `hoverClass` is the caller's hover affordance, applied ONLY when there is somewhere to go: a
// hover style on an element that does not navigate is the same lie as the empty `href`, one
// rendering later. It lives here rather than at each call site so a caller cannot pass the style
// and forget the condition.
const props = defineProps<{ url: string; hoverClass?: string }>()
const { t } = useI18n()
</script>

<template>
  <component
    :is="props.url ? 'a' : 'span'"
    :class="props.url ? props.hoverClass : undefined"
    v-bind="
      props.url
        ? { href: props.url, title: props.url, target: '_blank', rel: 'noopener' }
        : { title: t('documents.taskDocs.uploadedHint') }
    "
  >
    <slot />
  </component>
</template>
