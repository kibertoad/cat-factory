<script setup lang="ts">
import { computed, ref } from 'vue'
import { mayResumeCredentialWait } from '@cat-factory/contracts'

// A run parked because its personal-subscription credential lapsed before a step could
// dispatch. The one action re-mints it: the resume rides the cached personal password, and the
// credential modal prompts when there is none, after which the same step re-dispatches. Only the
// run's initiator holds the credential the step leases, so anyone else is told who can resume it
// instead of being offered a password prompt that could not help.

const props = defineProps<{
  /** The parked run. */
  executionId: string
  /** The run's initiator, whose personal credential the parked step leases. */
  initiatedBy: string | null | undefined
  /** Compact form drops the explanatory paragraph (used inside the step-detail rail). */
  compact?: boolean
}>()

const { t } = useI18n()
const execution = useExecutionStore()
const auth = useAuthStore()
const resuming = ref(false)
const canResume = computed(() => mayResumeCredentialWait(props.initiatedBy, auth.user?.id))

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
        <p class="text-sm font-medium">
          {{ canResume ? t('credentialWait.title') : t('credentialWait.othersTitle') }}
        </p>
        <p v-if="canResume && !compact" class="text-muted mt-0.5 text-xs">
          {{ t('credentialWait.body') }}
        </p>
        <p v-if="!canResume" class="text-muted mt-0.5 text-xs" data-testid="credential-wait-other">
          {{ t('credentialWait.othersRun') }}
        </p>
        <UButton
          v-else
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
