<script setup lang="ts">
// Shared collapsible "Show detail" disclosure for a failure's extended `detail`, used by
// both the failure banner (`AgentFailureCard`) and the prior-errors history
// (`AgentFailureHistory`). Renders nothing when there is no detail or it merely repeats the
// message. Tone (summary/pre classes) is passed by the host so it blends into each surface
// (rose banner vs slate history) while the guard + the `showDetail` key + the whitespace-
// preserving `<pre>` structure live in one place.
import CopyButton from '~/components/common/CopyButton.vue'

defineProps<{
  detail: string | null
  message: string
  summaryClass: string
  preClass: string
}>()

const { t } = useI18n()
</script>

<template>
  <UCollapsible v-if="detail && detail !== message" class="mt-1">
    <UButton
      variant="link"
      color="neutral"
      size="xs"
      :label="t('board.failure.showDetail')"
      :class="summaryClass"
      :ui="{ base: 'w-full justify-start p-0' }"
    />
    <!-- The stack trace / extended detail: the first thing a user does with it is copy it, so
         offer a copy affordance floated over the scroll box (UX-39). -->
    <template #content>
      <div class="relative mt-1">
        <CopyButton :text="detail" class="absolute end-1 top-1 z-10" />
        <pre
          class="max-h-32 overflow-auto whitespace-pre-wrap rounded p-1.5 pe-9"
          :class="preClass"
          >{{ detail }}</pre>
      </div>
    </template>
  </UCollapsible>
</template>
