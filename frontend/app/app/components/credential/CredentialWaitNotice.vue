<script setup lang="ts">
import { computed, ref } from 'vue'
import { mayResumeCredentialWait, type StepCredentialWait } from '@cat-factory/contracts'

// A run parked because a credential a step needs is not there. Three cases:
//  - a personal-subscription credential lapsed: the resume rides the cached personal password (the
//    credential modal prompts when there is none). Only the run's initiator holds that credential,
//    so anyone else is told who can resume it;
//  - a capability credential is not stored: the notice says which one and how to obtain it, links
//    to where it is stored, and any member resumes once it is (the server re-checks it resolves);
//  - a wait recorded before waits named their subject: it cannot be resumed, so the run restarts.

const props = defineProps<{
  /** The parked run. */
  executionId: string
  /** The run's initiator, whose personal credential a personal wait leases. */
  initiatedBy: string | null | undefined
  /** The parked step's wait. */
  wait: StepCredentialWait
  /** Compact form drops the explanatory paragraph (used inside the step-detail rail). */
  compact?: boolean
}>()

const { t } = useI18n()
const execution = useExecutionStore()
const auth = useAuthStore()
const ui = useUiStore()
const access = useWorkspaceAccess()
const resuming = ref(false)
const canResume = computed(
  () =>
    access.canWriteBoard.value &&
    mayResumeCredentialWait(props.wait, props.initiatedBy, auth.user?.id),
)
const capability = computed(() => (props.wait.subject === 'capability' ? props.wait : null))
const credentialName = computed(() => {
  const wait = capability.value
  if (!wait) return ''
  return wait.label ? `${wait.label} (${wait.key})` : wait.key
})

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
        <template v-if="wait.subject === 'unrecorded'">
          <p class="text-sm font-medium">{{ t('credentialWait.unrecordedTitle') }}</p>
          <p class="text-muted mt-0.5 text-xs">{{ t('credentialWait.unrecordedBody') }}</p>
        </template>
        <template v-else-if="capability">
          <p class="text-sm font-medium" data-testid="credential-wait-capability">
            {{ t('credentialWait.capabilityTitle', { name: credentialName }) }}
          </p>
          <p v-if="!compact" class="text-muted mt-0.5 text-xs">
            {{ t('credentialWait.capabilityBody') }}
          </p>
          <p v-if="capability.onboarding" class="mt-2 whitespace-pre-line text-xs">
            {{ capability.onboarding.instructions }}
          </p>
          <ULink
            v-if="capability.onboarding?.url"
            :to="capability.onboarding.url"
            target="_blank"
            class="mt-1 inline-block text-xs"
          >
            {{ capability.onboarding.url }}
          </ULink>
          <p v-if="capability.observed && !compact" class="text-muted mt-2 text-xs">
            {{ t('credentialWait.observed', { observed: capability.observed }) }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              size="xs"
              variant="outline"
              icon="i-lucide-lock-keyhole"
              data-testid="credential-wait-store"
              @click="ui.openInfrastructure('capability-credentials')"
            >
              {{ t('credentialWait.store') }}
            </UButton>
            <UButton
              v-if="canResume"
              size="xs"
              icon="i-lucide-play"
              :loading="resuming"
              data-testid="credential-wait-resume"
              @click="resume"
            >
              {{ t('credentialWait.resumeCapability') }}
            </UButton>
          </div>
        </template>
        <template v-else>
          <p class="text-sm font-medium">
            {{ canResume ? t('credentialWait.title') : t('credentialWait.othersTitle') }}
          </p>
          <p v-if="canResume && !compact" class="text-muted mt-0.5 text-xs">
            {{ t('credentialWait.body') }}
          </p>
          <p
            v-if="!canResume"
            class="text-muted mt-0.5 text-xs"
            data-testid="credential-wait-other"
          >
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
        </template>
      </div>
    </div>
  </div>
</template>
