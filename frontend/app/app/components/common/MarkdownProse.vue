<script setup lang="ts">
// Shared inline markdown renderer for agent prose (a rationale, a synthesis, a summary).
// Routes text through the secure `renderMarkdown` reader (markdown-it, `html: false`, links
// decorated to open safely in a new tab) instead of the `whitespace-pre-wrap` plain-text
// dumps several result views used to show (UX-43) — so `**bold**`, lists, code, and links in
// an agent's output read as formatted prose, consistently with `AgentStepDetail`'s reader.
import { computed } from 'vue'
import { renderMarkdown } from '~/utils/agentOutput'

const props = defineProps<{
  /** The agent's raw markdown text. */
  text: string | null | undefined
}>()

const html = computed(() => renderMarkdown(props.text))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html (sanitized by renderMarkdown, html: false) -->
  <div class="cf-prose" v-html="html" />
</template>

<style scoped>
/* Prose styling for the sanitized markdown injected via v-html (out of scoped reach
   without :deep), mirroring the inspector reader's prose styling. */
.cf-prose :deep(p) {
  margin: 0.5rem 0;
}
.cf-prose :deep(p:first-child) {
  margin-top: 0;
}
.cf-prose :deep(p:last-child) {
  margin-bottom: 0;
}
.cf-prose :deep(ul),
.cf-prose :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.cf-prose :deep(ul) {
  list-style: disc;
}
.cf-prose :deep(ol) {
  list-style: decimal;
}
.cf-prose :deep(li) {
  margin: 0.2rem 0;
}
.cf-prose :deep(strong) {
  font-weight: 600;
  color: rgb(226 232 240);
}
.cf-prose :deep(em) {
  font-style: italic;
}
.cf-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(30 41 59 / 0.8);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  color: rgb(199 210 254);
}
.cf-prose :deep(pre) {
  margin: 0.6rem 0;
  overflow: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem 0.9rem;
}
.cf-prose :deep(pre code) {
  background: transparent;
  padding: 0;
  color: rgb(203 213 225);
}
.cf-prose :deep(blockquote) {
  margin: 0.6rem 0;
  border-left: 3px solid rgb(99 102 241 / 0.5);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
.cf-prose :deep(h1),
.cf-prose :deep(h2),
.cf-prose :deep(h3),
.cf-prose :deep(h4) {
  margin: 0.7rem 0 0.4rem;
  font-weight: 600;
  color: rgb(226 232 240);
}
</style>
