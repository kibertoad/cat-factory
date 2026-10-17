<script setup lang="ts">
// Collapsible "Show detail" disclosure for a failure's extended `detail`, used by the run
// telemetry's failure summary (`RunFailureSummary`), which shows the message and hint itself.
// The task surfaces use `FailureNotes` instead, which puts the message, the hint and the detail
// behind one Details toggle. Renders nothing when there is no detail or it only repeats the
// message. The host passes the summary and pre classes, to match the surface it sits on.
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
    <template #default="{ open }">
      <UButton
        variant="link"
        color="neutral"
        size="xs"
        :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        :label="t('board.failure.showDetail')"
        :class="summaryClass"
        :ui="{ base: 'w-full justify-start gap-1 p-0' }"
      />
    </template>
    <!-- The stack trace / extended detail: the first thing a user does with it is copy it, so
         offer a copy affordance floated over the scroll box (UX-39). -->
    <template #content>
      <div class="relative mt-1">
        <CopyButton :text="detail" class="absolute end-1 top-1 z-10" />
        <pre
          class="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm p-1.5 pe-9"
          :class="preClass"
          >{{ detail }}</pre>
      </div>
    </template>
  </UCollapsible>
</template>
