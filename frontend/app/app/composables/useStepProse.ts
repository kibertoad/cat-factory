import { ref, reactive, computed, nextTick } from 'vue'
import { parseOutputOutline } from '~/utils/agentOutput'

/**
 * The prose reader for an agent step's markdown output: its heading outline, the
 * per-section collapse state, and the scroll-spy that keeps the ToC in sync.
 * Owns the scroll container + per-section element refs the template binds.
 * `reset()` re-seeds (all sections expanded, scrolled to top) whenever a different
 * step opens.
 *
 * `leadAnchorId` names a section the CONSUMER renders ahead of the prose and registers in
 * `sectionEls` — the step reader's details card. It is an option rather than a constant
 * because the scroll-spy walks the anchors in document order and stops at the first one it
 * cannot measure: a consumer that renders no such element (the initiative tracker's
 * plan-approval rail, which has the document alone) would otherwise have its spy stop dead on
 * an anchor that never exists, pinning `activeId` to a section nobody can see and leaving the
 * ToC with nothing highlighted. Pass `null` when the prose is the whole document.
 */
export function useStepProse(getOutput: () => string, opts: { leadAnchorId?: string | null } = {}) {
  const leadAnchorId = opts.leadAnchorId === undefined ? 'step-details' : opts.leadAnchorId
  const outline = computed(() => parseOutputOutline(getOutput()))
  const tocSections = computed(() => outline.value.sections.filter((s) => s.depth > 0))
  const hasOutput = computed(() => !!getOutput().trim())

  const collapsed = reactive<Record<string, boolean>>({})
  const activeId = ref<string>(leadAnchorId ?? '')
  const scrollEl = ref<HTMLElement | null>(null)
  const sectionEls = reactive<Record<string, HTMLElement | null>>({})

  // Anchors the ToC navigates + the scroll-spy tracks: the lead section (when the consumer
  // renders one) first, then every heading section of the prose.
  const anchors = computed(() => [
    ...(leadAnchorId ? [leadAnchorId] : []),
    ...tocSections.value.map((s) => s.id),
  ])

  function toggle(id: string) {
    collapsed[id] = !collapsed[id]
  }
  function setAll(value: boolean) {
    for (const s of outline.value.sections) collapsed[s.id] = value
  }
  const allCollapsed = computed(
    () => outline.value.sections.length > 0 && outline.value.sections.every((s) => collapsed[s.id]),
  )

  async function goTo(id: string) {
    if (collapsed[id]) collapsed[id] = false
    activeId.value = id
    await nextTick()
    sectionEls[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function onScroll() {
    const container = scrollEl.value
    if (!container) return
    const line = container.getBoundingClientRect().top + 80
    let current = anchors.value[0] ?? ''
    for (const id of anchors.value) {
      const el = sectionEls[id]
      if (el && el.getBoundingClientRect().top <= line) current = id
      else break
    }
    activeId.value = current
  }

  // Re-seed (all sections expanded, scrolled to top) for a freshly-opened step.
  function reset() {
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    activeId.value = leadAnchorId ?? ''
    void nextTick(() => scrollEl.value?.scrollTo({ top: 0 }))
  }

  return {
    outline,
    tocSections,
    hasOutput,
    collapsed,
    activeId,
    scrollEl,
    sectionEls,
    anchors,
    toggle,
    setAll,
    allCollapsed,
    goTo,
    onScroll,
    reset,
  }
}
