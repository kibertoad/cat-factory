<script setup lang="ts">
import { ref } from 'vue'

// A run parked because its personal-subscription credential lapsed before a step could
// dispatch. The one action re-mints it: the resume rides the cached personal password, and the
// credential modal prompts when there is none, after which the same step re-dispatches.

const props = defineProps<{
  /** The parked run. */
  executionId: string
  /** Compact form drops the explanatory paragraph (used inside the step-detail rail). */
  compact?: boolean
}>()

const { t } = useI18n()
const execution = useExecutionStore()
const resuming = ref(false)

async function resume() {
  resuming.value = true
  try {
    await execution.resumeCredentialWait(props.executionId)
  } finally {
    resuming.value = false
  }
}
</script>

<template>
  <div
    class="rounded-lg border border-app-warning-800 bg-app-warning-950/40 p-3"
    data-testid="credential-wait-notice"
  >
    <div class="flex items-start gap-2">
      <UIcon name="i-lucide-key-round" class="mt-0.5 size-4 shrink-0 text-app-warning-400" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">{{ t('credentialWait.title') }}</p>
        <p v-if="!compact" class="text-muted mt-0.5 text-xs">{{ t('credentialWait.body') }}</p>
        <UButton
          class="mt-3"
          size="xs"
          icon="i-lucide-key-round"
          :loading="resuming"
          data-testid="credential-wait-resume"
          @click="resume"
        >
          {{ t('credentialWait.resume') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
