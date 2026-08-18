<script setup lang="ts">
// The plan gate's DECISION half: the overall-feedback field plus the two commands that resolve the
// park — accept the plan, or send it back to the planner.
//
// It is its own component because the gate has two surfaces: the full document review
// (`InitiativePlanReview`, which owns the tracker window while a rendered plan is parked) and the
// compact notice a gate with no rendered plan falls back to (`InitiativePlanNotice`). Both must
// word the commands identically, gate them on the same RBAC fact, and refuse an empty send-back
// the same way — so the state machine and its markup live here once rather than in each.
//
// Deliberately NOT offered: "approve with corrections". The plan was ingested into the
// `initiatives` entity before this gate was raised, so the document is a VIEW of committed state —
// an edit typed over it would reach nothing, and the engine refuses it outright
// (`outputIsRendered` → 422). Requesting changes is the route for a correction, which is why an
// anchored comment is worth having: it quotes the planner's own text back to it on the re-plan.
import { computed, onUnmounted, ref, watch } from 'vue'
import type { RequestStepChangesInput } from '@cat-factory/contracts'

const props = defineProps<{
  /** The parked gate being resolved. */
  approvalId: string
  /** The run the gate belongs to, for the approve / request-changes commands. */
  instanceId: string
  /** Whether the viewer may resolve runs at all (RBAC); false renders the actions disabled. */
  canExecute: boolean
  /**
   * The anchored per-block comments to send with a send-back, from the surface that offers
   * commenting. Absent on the notice surface, which has no document to anchor to.
   */
  comments?: RequestStepChangesInput['comments']
}>()

const emit = defineEmits<{
  /** A send-back succeeded: the surface drops its anchored drafts (the feedback is cleared here). */
  sent: []
  /**
   * Whether unsent feedback is typed here right now. Reported UPWARD because the field lives two
   * components below the window that owns closing, and the window is what Escape and a backdrop
   * click reach (UX-79) — without this the host has no way to know a review is in progress.
   */
  'update:dirty': [boolean]
}>()

const execution = useExecutionStore()
const { t } = useI18n()

const feedback = ref('')
const submitting = ref(false)

watch(feedback, (value) => emit('update:dirty', value.trim().length > 0))
// The gate resolving unmounts this surface; retract the claim rather than leaving the host holding
// a dirty flag for a field that no longer exists.
onUnmounted(() => emit('update:dirty', false))

/** Changes can only be requested with something to act on — an empty send would re-plan blind. */
const canRequestChanges = computed(
  () => !!feedback.value.trim() || (props.comments?.length ?? 0) > 0,
)

/** A fresh gate (a re-plan parked again) reviews the new plan clean, drafts dropped. */
watch(
  () => props.approvalId,
  () => {
    feedback.value = ''
  },
)

/**
 * Accept the plan: the run advances to the committer, which persists it and arms the execution
 * loop. The window stays open — the review disappears with the approval (live) and the tracker it
 * gives the window back to is where the plan then executes.
 */
async function approve() {
  if (submitting.value || !props.canExecute) return
  submitting.value = true
  try {
    await execution.approveStep(props.instanceId, props.approvalId)
  } finally {
    submitting.value = false
  }
}

/** Send the plan back: the planner re-plans from the feedback + the anchored comments. */
async function requestChanges() {
  if (submitting.value || !canRequestChanges.value || !props.canExecute) return
  submitting.value = true
  try {
    const ok = await execution.requestStepChanges(props.instanceId, props.approvalId, {
      feedback: feedback.value.trim() || undefined,
      comments: props.comments,
    })
    if (ok) {
      feedback.value = ''
      emit('sent')
    }
  } finally {
    submitting.value = false
  }
}

const disabledTitle = computed(() => (props.canExecute ? undefined : t('access.noRunExecute')))
</script>

<template>
  <div>
    <UTextarea
      v-model="feedback"
      data-testid="initiative-plan-feedback"
      :rows="2"
      autoresize
      size="sm"
      class="w-full"
      :placeholder="t('initiative.planReview.feedbackPlaceholder')"
    />
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <UButton
        color="primary"
        size="xs"
        icon="i-lucide-check"
        data-testid="initiative-plan-approve"
        :loading="submitting"
        :disabled="!canExecute"
        :title="disabledTitle"
        @click="approve"
      >
        {{ t('initiative.planReview.approve') }}
      </UButton>
      <UButton
        color="warning"
        variant="soft"
        size="xs"
        icon="i-lucide-rotate-ccw"
        data-testid="initiative-plan-send-back"
        :loading="submitting"
        :disabled="!canRequestChanges || !canExecute"
        :title="
          canExecute && !canRequestChanges
            ? t('initiative.planReview.needsFeedback')
            : disabledTitle
        "
        @click="requestChanges"
      >
        {{ t('initiative.planReview.sendBack') }}
      </UButton>
    </div>
  </div>
</template>
