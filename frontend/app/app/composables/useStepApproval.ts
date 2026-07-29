import { ref, computed, nextTick } from 'vue'
import type { PipelineStep } from '~/types/execution'
import { useProseComments } from '~/composables/useProseComments'

/**
 * The GitHub-style approval/review state machine for a pending gate step. When the
 * step's gate is pending the prose reader doubles as a review surface: the human can
 * comment on individual source-mapped blocks, leave overall feedback, edit the
 * conclusions in place, then Approve / Request changes / Reject. This composable owns
 * the approval-API half plus the edit/reject sub-states; the per-block comment drafts and
 * their in-document highlighting live in {@link useProseComments}, which the initiative
 * tracker's plan-approval rail shares. The parent supplies the live step, the scroll
 * container (for highlight lookups), the run/approval ids, and a `close` callback the
 * actions invoke once they resolve.
 */
export function useStepApproval(opts: {
  step: () => PipelineStep | null
  scrollEl: () => HTMLElement | null
  instanceId: () => string | undefined
  approvalId: () => string | null
  approvalPending: () => boolean
  companionExceeded: () => boolean
  close: () => void
}) {
  const execution = useExecutionStore()

  const feedback = ref('')
  const submitting = ref(false)

  // "Approve with corrections" mode: a deliberate state distinct from the read-only
  // review — the human edits the conclusions directly and those edits flow forward as
  // the approved proposal. It CANNOT be mixed with the request-changes/comments path.
  const editing = ref(false)
  const draftProposal = ref('')

  // Reject stops the whole run, so it's a two-step inline confirm (no native dialog).
  const rejectArmed = ref(false)

  // The per-block comment drafts + their in-document highlights. Commenting is off while the
  // human is in edit mode: the two paths are mutually exclusive, and the editor replaces the
  // rendered document with a textarea, so there are no blocks to anchor to.
  const prose = useProseComments({
    output: () => opts.step()?.output ?? '',
    root: () => opts.scrollEl(),
    enabled: () => opts.approvalPending() && !opts.companionExceeded() && !editing.value,
  })
  const {
    comments: reviewComments,
    wireComments,
    draftTarget,
    draftBody,
    syncHighlights,
    onProseClick,
    addDraftComment,
    cancelDraft,
    removeComment,
  } = prose

  const canRequestChanges = computed(
    () => !!feedback.value.trim() || reviewComments.value.length > 0,
  )

  // Plain approve: accept the agent's proposal verbatim and advance. Every action below
  // closes the overlay ONLY when the command actually ran — a server refusal (surfaced as
  // a toast by the store) or a cancelled credential prompt keeps the review open.
  async function approve() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value) return
    submitting.value = true
    try {
      if (await execution.approveStep(opts.instanceId()!, id)) opts.close()
    } finally {
      submitting.value = false
    }
  }

  function startEditing() {
    draftProposal.value = opts.step()?.output ?? ''
    editing.value = true
    // Editing and the review/reject path are mutually exclusive — clear the other.
    rejectArmed.value = false
    prose.cancelDraft()
    void nextTick(syncHighlights)
  }
  function cancelEditing() {
    editing.value = false
    draftProposal.value = ''
  }
  async function approveWithEdits() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value) return
    submitting.value = true
    try {
      if (await execution.approveStep(opts.instanceId()!, id, draftProposal.value)) opts.close()
    } finally {
      submitting.value = false
    }
  }
  async function requestChanges() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value || !canRequestChanges.value) return
    submitting.value = true
    try {
      const ok = await execution.requestStepChanges(opts.instanceId()!, id, {
        feedback: feedback.value.trim() || undefined,
        comments: wireComments.value,
      })
      if (ok) opts.close()
    } finally {
      submitting.value = false
    }
  }
  function armReject() {
    rejectArmed.value = true
  }
  function disarmReject() {
    rejectArmed.value = false
  }
  async function reject() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value) return
    submitting.value = true
    try {
      if (await execution.rejectStep(opts.instanceId()!, id, feedback.value.trim() || undefined)) {
        opts.close()
      }
    } finally {
      submitting.value = false
      rejectArmed.value = false
    }
  }

  /**
   * Reset the approve-with-edits / reject sub-states so reopening the same step is
   * clean (the step-change watch only fires when the step key actually changes).
   */
  function resetForClose() {
    editing.value = false
    draftProposal.value = ''
    rejectArmed.value = false
  }

  /** Full reset of every draft when a different gate/step opens. */
  function resetForStep() {
    prose.reset()
    feedback.value = ''
    rejectArmed.value = false
    editing.value = false
    draftProposal.value = ''
  }

  return {
    reviewComments,
    feedback,
    submitting,
    draftTarget,
    draftBody,
    editing,
    draftProposal,
    rejectArmed,
    canRequestChanges,
    syncHighlights,
    onProseClick,
    addDraftComment,
    cancelDraft,
    removeComment,
    approve,
    startEditing,
    cancelEditing,
    approveWithEdits,
    requestChanges,
    armReject,
    disarmReject,
    reject,
    resetForClose,
    resetForStep,
  }
}
