import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { KaizenGrading, KaizenVerifiedCombo } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Kaizen state: per-run gradings (for the run-window status surface) and the
 * workspace-wide history + verified-combo library (for the Kaizen screen). Gradings
 * arrive both via lazy loads and live over the workspace stream (`upsert`). Never
 * surfaced on the board — only inside run details + the dedicated screen.
 */
export const useKaizenStore = defineStore('kaizen', () => {
  const api = useApi()

  /** Gradings keyed by run (execution) id, for the run window. */
  const byExecution = ref<Record<string, KaizenGrading[]>>({})
  /** Recent grading history for the Kaizen screen. */
  const history = ref<KaizenGrading[]>([])
  /** The verified-combo library for the Kaizen screen. */
  const verified = ref<KaizenVerifiedCombo[]>([])
  const loadingOverview = ref(false)
  const loadingExecution = ref<Set<string>>(new Set())
  /** 503 ⇒ the Kaizen feature isn't configured on this deployment. */
  const available = ref<boolean | null>(null)

  function gradingsFor(executionId: string): KaizenGrading[] {
    return byExecution.value[executionId] ?? []
  }

  /** The grading for a specific step of a run, if any. */
  function gradingForStep(executionId: string, stepIndex: number): KaizenGrading | null {
    return gradingsFor(executionId).find((g) => g.stepIndex === stepIndex) ?? null
  }

  async function loadOverview() {
    const ws = useWorkspaceStore()
    loadingOverview.value = true
    try {
      const overview = await api.getKaizenOverview(ws.requireId())
      history.value = overview.gradings
      verified.value = overview.verified
      available.value = true
    } catch (e) {
      if ((e as { statusCode?: number; status?: number })?.statusCode === 503)
        available.value = false
      else throw e
    } finally {
      loadingOverview.value = false
    }
  }

  async function loadForExecution(executionId: string) {
    const ws = useWorkspaceStore()
    loadingExecution.value = new Set(loadingExecution.value).add(executionId)
    try {
      const { gradings } = await api.getKaizenForExecution(ws.requireId(), executionId)
      byExecution.value = { ...byExecution.value, [executionId]: gradings }
      available.value = true
    } catch (e) {
      if ((e as { statusCode?: number; status?: number })?.statusCode === 503)
        available.value = false
      else throw e
    } finally {
      const next = new Set(loadingExecution.value)
      next.delete(executionId)
      loadingExecution.value = next
    }
  }

  /** Fold a grading pushed over the stream into both the run cache and the screen history. */
  function upsert(grading: KaizenGrading) {
    const current = byExecution.value[grading.executionId] ?? []
    const replaced = current.some((g) => g.id === grading.id)
    const nextRun = replaced
      ? current.map((g) => (g.id === grading.id ? grading : g))
      : [...current, grading]
    byExecution.value = { ...byExecution.value, [grading.executionId]: nextRun }
    // Keep the screen history live too (newest first), if it's been loaded.
    const inHistory = history.value.some((g) => g.id === grading.id)
    if (inHistory) history.value = history.value.map((g) => (g.id === grading.id ? grading : g))
    else history.value = [grading, ...history.value]
  }

  const isLoadingExecution = (executionId: string) => loadingExecution.value.has(executionId)
  const verifiedCount = computed(() => verified.value.filter((c) => c.verified).length)

  return {
    byExecution,
    history,
    verified,
    available,
    loadingOverview,
    verifiedCount,
    gradingsFor,
    gradingForStep,
    loadOverview,
    loadForExecution,
    upsert,
    isLoadingExecution,
  }
})
