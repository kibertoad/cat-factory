<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { AGENT_BY_KIND } from '~/utils/catalog'

const execution = useExecutionStore()
const board = useBoardStore()
const ui = useUiStore()

const ctx = computed(() => ui.approvalContext)
const instance = computed(() => execution.getInstance(ctx.value?.instanceId))
const step = computed(() =>
  instance.value?.steps.find((s) => s.approval?.id === ctx.value?.approvalId),
)
const approval = computed(() => step.value?.approval ?? null)
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))
const agent = computed(() => (step.value ? AGENT_BY_KIND[step.value.agentKind] : null))

// Local, editable copy of the proposal — the human's edits are what flow to the
// next step on approval. Re-seeded whenever the gate being reviewed changes.
const draftProposal = ref('')
const feedback = ref('')
const showFeedback = ref(false)
const submitting = ref(false)

watch(
  approval,
  (a) => {
    draftProposal.value = a?.proposal ?? ''
    feedback.value = ''
    showFeedback.value = false
  },
  { immediate: true },
)

const open = computed({
  get: () => !!ctx.value && !!approval.value && approval.value.status === 'pending',
  set: (v: boolean) => {
    if (!v) ui.closeApproval()
  },
})

async function approve() {
  if (!ctx.value || submitting.value) return
  submitting.value = true
  try {
    await execution.approveStep(ctx.value.instanceId, ctx.value.approvalId, draftProposal.value)
    ui.closeApproval()
  } finally {
    submitting.value = false
  }
}

async function requestChanges() {
  if (!ctx.value || submitting.value) return
  if (!showFeedback.value) {
    showFeedback.value = true
    return
  }
  if (!feedback.value.trim()) return
  submitting.value = true
  try {
    await execution.requestStepChanges(
      ctx.value.instanceId,
      ctx.value.approvalId,
      feedback.value.trim(),
    )
    ui.closeApproval()
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Approval required" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="approval && agent" class="space-y-4">
        <div class="flex items-center gap-2 text-sm text-slate-400">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-lg"
            :style="{ backgroundColor: agent.color + '22' }"
          >
            <UIcon :name="agent.icon" class="h-4 w-4" :style="{ color: agent.color }" />
          </div>
          <div>
            <span class="font-medium text-slate-200">{{ agent.label }}</span>
            <span v-if="block"> on </span>
            <span v-if="block" class="font-medium text-slate-200">{{ block.title }}</span>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Proposal — review and edit before approving
          </label>
          <UTextarea
            v-model="draftProposal"
            :rows="12"
            autoresize
            size="sm"
            class="w-full"
            :ui="{ base: 'font-mono text-[12px] leading-relaxed max-h-[50vh]' }"
          />
        </div>

        <div v-if="showFeedback">
          <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            What should change?
          </label>
          <UTextarea
            v-model="feedback"
            :rows="3"
            autoresize
            size="sm"
            class="w-full"
            placeholder="Provide the missing information or describe the changes the agent should make…"
          />
        </div>

        <p class="text-[11px] text-slate-500">
          Approving advances the pipeline and passes your edited proposal to the next step.
          Requesting changes re-runs this step with your feedback.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton
          color="warning"
          variant="soft"
          size="sm"
          icon="i-lucide-rotate-ccw"
          :loading="submitting && showFeedback"
          :disabled="showFeedback && !feedback.trim()"
          @click="requestChanges"
        >
          {{ showFeedback ? 'Send & re-run' : 'Request changes' }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-check"
          :loading="submitting && !showFeedback"
          @click="approve"
        >
          Approve
        </UButton>
      </div>
    </template>
  </UModal>
</template>
