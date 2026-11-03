<script setup lang="ts">
// A failure's full output (an HTTP body, a stack trace, the container's last words) with a copy
// button: the first thing a reader does with it is copy it (UX-39). The one rendering of that
// block, shared by the failure block's Details (`FailureNotes`) and the run telemetry's
// "Show detail" (`FailureDetail`), so a fix to one (truncation, the copy button) reaches both.
// The caller decides if there is anything to show, through `failureOutput`.
import CopyButton from '~/components/common/CopyButton.vue'

defineProps<{
  text: string
  /** The tone of the surface it sits on. */
  preClass: string
}>()
</script>

<template>
  <div class="relative mt-1">
    <CopyButton :text="text" class="absolute end-1 top-1 z-10" />
    <pre
      class="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm p-1.5 pe-9"
      :class="preClass"
      >{{ text }}</pre>
  </div>
</template>
