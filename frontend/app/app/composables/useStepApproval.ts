import { ref, computed, nextTick, watch } from 'vue'
import type { PipelineStep } from '~/types/execution'
import { sliceSource } from '~/utils/agentOutput'

/** A draft per-block review comment, anchored to a source range of the output. */
interface DraftComment {
  srcStart: number
  srcEnd: number
  quotedSource: string
  body: string
}

/**
 * The GitHub-style approval/review state machine for a pending gate step. When the
 * step's gate is pending the prose reader doubles as a review surface: the human can
 * comment on individual source-mapped blocks, leave overall feedback, edit the
 * conclusions in place, then Approve / Request changes / Reject. This composable owns
 * all of that draft state + the in-document highlight syncing; the parent supplies the
 * live step, the scroll container (for highlight lookups), the run/approval ids, and a
 * `close` callback the actions invoke once they resolve.
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

  const reviewComments = ref<DraftComment[]>([])
  const feedback = ref('')
  const submitting = ref(false)
  const draftTarget = ref<{ srcStart: number; srcEnd: number; quotedSource: string } | null>(null)
  const draftBody = ref('')

  // "Approve with corrections" mode: a deliberate state distinct from the read-only
  // review — the human edits the conclusions directly and those edits flow forward as
  // the approved proposal. It CANNOT be mixed with the request-changes/comments path.
  const editing = ref(false)
  const draftProposal = ref('')

  // Reject stops the whole run, so it's a two-step inline confirm (no native dialog).
  const rejectArmed = ref(false)

  const blockKey = (c: { srcStart: number; srcEnd: number }) => `${c.srcStart}:${c.srcEnd}`

  /** Toggle the highlight classes on commented / selected blocks within the reader. */
  function syncHighlights() {
    const root = opts.scrollEl()
    if (!root) return
    const commented = new Set(reviewComments.value.map(blockKey))
    const selected = draftTarget.value ? blockKey(draftTarget.value) : null
    for (const el of Array.from(root.querySelectorAll('[data-src-start]'))) {
      const key = `${el.getAttribute('data-src-start')}:${el.getAttribute('data-src-end')}`
      el.classList.toggle('cf-commented', commented.has(key))
      el.classList.toggle('cf-selected', key === selected)
    }
  }

  /** Click a rendered block to start commenting on it (links keep working). */
  function onProseClick(e: MouseEvent) {
    if (!opts.approvalPending() || opts.companionExceeded() || editing.value) return
    const target = e.target as HTMLElement
    if (target.closest('a')) return
    const blockEl = target.closest('[data-src-start]') as HTMLElement | null
    if (!blockEl) return
    const srcStart = Number(blockEl.getAttribute('data-src-start'))
    const srcEnd = Number(blockEl.getAttribute('data-src-end'))
    if (Number.isNaN(srcStart) || Number.isNaN(srcEnd)) return
    draftTarget.value = {
      srcStart,
      srcEnd,
      quotedSource: sliceSource(opts.step()?.output ?? '', srcStart, srcEnd),
    }
    draftBody.value = ''
    void nextTick(syncHighlights)
  }

  function addDraftComment() {
    if (!draftTarget.value || !draftBody.value.trim()) return
    reviewComments.value.push({ ...draftTarget.value, body: draftBody.value.trim() })
    draftTarget.value = null
    draftBody.value = ''
    void nextTick(syncHighlights)
  }
  function cancelDraft() {
    draftTarget.value = null
    draftBody.value = ''
    void nextTick(syncHighlights)
  }
  function removeComment(idx: number) {
    reviewComments.value.splice(idx, 1)
    void nextTick(syncHighlights)
  }

  const canRequestChanges = computed(
    () => !!feedback.value.trim() || reviewComments.value.length > 0,
  )

  // Plain approve: accept the agent's proposal verbatim and advance.
  async function approve() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value) return
    submitting.value = true
    try {
      await execution.approveStep(opts.instanceId()!, id)
      opts.close()
    } finally {
      submitting.value = false
    }
  }

  function startEditing() {
    draftProposal.value = opts.step()?.output ?? ''
    editing.value = true
    // Editing and the review/reject path are mutually exclusive — clear the other.
    rejectArmed.value = false
    draftTarget.value = null
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
      await execution.approveStep(opts.instanceId()!, id, draftProposal.value)
      opts.close()
    } finally {
      submitting.value = false
    }
  }
  async function requestChanges() {
    const id = opts.approvalId()
    if (!opts.instanceId() || !id || submitting.value || !canRequestChanges.value) return
    submitting.value = true
    try {
      await execution.requestStepChanges(opts.instanceId()!, id, {
        feedback: feedback.value.trim() || undefined,
        comments: reviewComments.value.length
          ? reviewComments.value.map((c) => ({
              quotedSource: c.quotedSource,
              srcStart: c.srcStart,
              srcEnd: c.srcEnd,
              body: c.body,
            }))
          : undefined,
      })
      opts.close()
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
      await execution.rejectStep(opts.instanceId()!, id, feedback.value.trim() || undefined)
      opts.close()
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
    reviewComments.value = []
    feedback.value = ''
    draftTarget.value = null
    draftBody.value = ''
    rejectArmed.value = false
    editing.value = false
    draftProposal.value = ''
  }

  // Keep the in-document highlights in sync as the output renders or comments change.
  watch(
    [opts.approvalPending, () => opts.step()?.output, reviewComments, draftTarget],
    () => void nextTick(syncHighlights),
    { deep: true },
  )

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
