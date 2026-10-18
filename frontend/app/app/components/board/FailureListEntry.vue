<script setup lang="ts">
// The body of one earlier failure in a list: when it occurred, its one-line cause, and the
// backend's text behind a Details toggle. Shared by the inspector's "previous errors" list
// (`FailureHistoryList`) and the step panel's execution history (`StepExecutionHistory`), so an
// earlier failure reads the same as the failure block (`AgentFailureCard`) above it. The host
// owns the list item and its frame.
import type { AgentFailure } from '~/types/domain'
import { presentFailure } from '~/utils/failureCause'
import FailureNotes from '~/components/board/FailureNotes.vue'

const props = defineProps<{ failure: AgentFailure }>()

const { t, d } = useI18n()
const auth = useAuthStore()

// Both lists hold the earlier failures of a task run, never of a bootstrap.
const presented = computed(() =>
  presentFailure(props.failure, {
    runKind: 'execution',
    localMode: auth.localMode?.enabled === true,
  }),
)
</script>

<template>
  <div class="flex items-center gap-1.5 text-3xs text-dimmed">
    <UIcon name="i-lucide-alert-triangle" class="h-3 w-3 shrink-0 text-app-error-400/70" />
    <time>{{ d(new Date(failure.occurredAt), 'long') }}</time>
  </div>

  <p class="mt-1 text-2xs leading-snug text-toned" data-testid="failure-entry-cause">
    {{ t(presented.causeKey, presented.causeParams) }}
  </p>

  <UCollapsible class="mt-1">
    <template #default="{ open }">
      <UButton
        variant="link"
        color="neutral"
        size="xs"
        :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        :label="t('board.failure.details')"
        class="text-3xs text-dimmed hover:text-toned"
        :ui="{ base: 'w-full justify-start gap-1 p-0' }"
      />
    </template>
    <template #content>
      <FailureNotes :failure="failure" tone="neutral" />
    </template>
  </UCollapsible>
</template>
