<script setup lang="ts">
// Collapsible "Show detail" disclosure for a failure's extended `detail`, used by the run
// telemetry's failure summary (`RunFailureSummary`), which shows the message and hint itself.
// The task surfaces use `FailureNotes` instead, which puts the message, the hint and the detail
// behind one Details toggle. Renders nothing when there is no detail or it only repeats the
// message. The host passes the summary and pre classes, to match the surface it sits on.
import FailureOutput from '~/components/board/FailureOutput.vue'
import { failureOutput } from '~/utils/failureCause'

const props = defineProps<{
  detail: string | null
  message: string
  summaryClass: string
  preClass: string
}>()

const { t } = useI18n()
const output = computed(() => failureOutput(props))
</script>

<template>
  <UCollapsible v-if="output" class="mt-1">
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
    <template #content>
      <FailureOutput :text="output" :pre-class="preClass" />
    </template>
  </UCollapsible>
</template>
