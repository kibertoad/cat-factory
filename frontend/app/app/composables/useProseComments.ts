import { computed, nextTick, ref, watch } from 'vue'
import { sliceSource } from '~/utils/agentOutput'

/** A draft per-block review comment, anchored to a source line range of the reviewed markdown. */
export interface ProseComment {
  srcStart: number
  srcEnd: number
  quotedSource: string
  body: string
}

/**
 * GitHub-style per-block commenting over a rendered markdown document — the anchoring half of a
 * prose review, with no opinion about WHAT is being reviewed or how the review is submitted.
 *
 * Extracted from `useStepApproval` (which now builds on it) so a second surface can offer the
 * same affordance: the initiative tracker's plan-approval rail reviews the planner's drafted plan,
 * which the engine renders as markdown onto the gate's proposal. Both therefore anchor comments
 * identically — a comment quotes the exact source lines of the block it targets, so a "request
 * changes" re-run can hand the agent back its OWN text rather than a re-rendered approximation.
 *
 * The anchors are the `data-src-start`/`data-src-end` attributes `parseOutputOutline` stamps on
 * every top-level block, so this works over any document that reader renders.
 *
 * @param output the raw markdown being reviewed (comments quote out of it by line range)
 * @param root the element containing the rendered blocks, for the highlight sync
 * @param enabled whether clicking a block should start a comment (review mode is on)
 */
export function useProseComments(opts: {
  output: () => string
  root: () => HTMLElement | null
  enabled: () => boolean
}) {
  const comments = ref<ProseComment[]>([])
  const draftTarget = ref<{ srcStart: number; srcEnd: number; quotedSource: string } | null>(null)
  const draftBody = ref('')

  const blockKey = (c: { srcStart: number; srcEnd: number }) => `${c.srcStart}:${c.srcEnd}`

  /** Toggle the highlight classes on commented / selected blocks within the rendered document. */
  function syncHighlights() {
    const root = opts.root()
    if (!root) return
    const commented = new Set(comments.value.map(blockKey))
    const selected = draftTarget.value ? blockKey(draftTarget.value) : null
    for (const el of Array.from(root.querySelectorAll('[data-src-start]'))) {
      const key = `${el.getAttribute('data-src-start')}:${el.getAttribute('data-src-end')}`
      el.classList.toggle('cf-commented', commented.has(key))
      el.classList.toggle('cf-selected', key === selected)
    }
  }

  /** Click a rendered block to start commenting on it (links keep working). */
  function onProseClick(e: MouseEvent) {
    if (!opts.enabled()) return
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
      quotedSource: sliceSource(opts.output(), srcStart, srcEnd),
    }
    draftBody.value = ''
    void nextTick(syncHighlights)
  }

  function addDraftComment() {
    if (!draftTarget.value || !draftBody.value.trim()) return
    comments.value.push({ ...draftTarget.value, body: draftBody.value.trim() })
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
    comments.value.splice(idx, 1)
    void nextTick(syncHighlights)
  }

  /** Drop every draft — a different document (or a different subject) is being reviewed. */
  function reset() {
    comments.value = []
    draftTarget.value = null
    draftBody.value = ''
    void nextTick(syncHighlights)
  }

  /** The wire shape `requestStepChanges` takes, or undefined when nothing was anchored. */
  const wireComments = computed(() =>
    comments.value.length
      ? comments.value.map((c) => ({
          quotedSource: c.quotedSource,
          srcStart: c.srcStart,
          srcEnd: c.srcEnd,
          body: c.body,
        }))
      : undefined,
  )

  // Keep the in-document highlights in sync as the document renders or the drafts change.
  watch([opts.enabled, opts.output, comments, draftTarget], () => void nextTick(syncHighlights), {
    deep: true,
  })

  return {
    comments,
    wireComments,
    draftTarget,
    draftBody,
    syncHighlights,
    onProseClick,
    addDraftComment,
    cancelDraft,
    removeComment,
    reset,
  }
}
