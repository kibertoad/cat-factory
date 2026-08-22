import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { KaizenGrading, KaizenVerifiedCombo } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'
import { useSingleFlight } from '~/composables/useSingleFlight'

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
  /**
   * Whether the Kaizen SCREEN has ASKED for its history (set when the load starts, so a grading
   * pushed while that fetch is in flight still lands). `upsert` folds a stream-pushed grading into
   * {@link history} only once it has: the screen is a full-panel overlay most sessions never open,
   * and folding into a list nothing has read makes it a per-session accumulator of every grading
   * the workspace produced. The screen loads on open, so an OPEN screen still updates live, which
   * is the same gate `observability.appendCall` applies for the same reason.
   *
   * `byExecution` is deliberately NOT gated the same way: it is keyed per run, the run windows
   * read it without loading first, and a board switch now drops it (see `reset`).
   */
  const historyLoaded = ref(false)
  /** The verified-combo library for the Kaizen screen. */
  const verified = ref<KaizenVerifiedCombo[]>([])
  const loadingOverview = ref(false)
  const loadingExecution = ref<Set<string>>(new Set())
  /** 503 ⇒ the Kaizen feature isn't configured on this deployment. */
  const available = ref<boolean | null>(null)

  /**
   * One in-flight per-run read. The run window and the run's grading badge both load on open, so
   * a single click asked for the same gradings twice. Coalescing them also retires the
   * per-execution half of the ticket below: two loads of one run can no longer overlap.
   */
  const loads = useSingleFlight<string, void>()

  // Monotonic load-ordering guard for the OVERVIEW, which is not coalesced (it takes no key and
  // the screen can legitimately re-ask). It REPLACES state that also arrives live over the stream
  // (`upsert`), so a slower/staler fetch resolving AFTER a newer one would clobber the fresher
  // history (the CLAUDE.md live-push out-of-order hazard, the same one
  // `stores/provisioningLogs.ts` guards). Each load takes a ticket; only the newest-issued one
  // commits. NOT reactive: pure bookkeeping the UI never reads.
  let loadTicket = 0
  let latestOverviewLoad = 0

  /**
   * Fold a freshly-loaded grading list into the live cache WITHOUT dropping live-only rows:
   * a grading pushed via `upsert` while the load was in flight may not be in the server's
   * response yet, and a blind replace would silently drop it. Loaded rows are authoritative
   * for the ids they carry (keeping whichever `updatedAt` is greater on a shared id), and any
   * live-only rows the response hasn't caught up to are preserved. Gradings are append/update-
   * only (never deleted), so preserving an unmatched live row can't resurrect stale state.
   * Returns the reconciled loaded rows and the surviving live-only rows separately so each
   * caller can splice them in its own order (execution cache appends; screen history, which is
   * newest-first, prepends).
   */
  function reconcileWithLive(loaded: KaizenGrading[], existing: KaizenGrading[]) {
    const loadedIds = new Set(loaded.map((g) => g.id))
    const reconciled = loaded.map((l) => {
      const live = existing.find((e) => e.id === l.id)
      return live && live.updatedAt > l.updatedAt ? live : l
    })
    const liveOnly = existing.filter((e) => !loadedIds.has(e.id))
    return { reconciled, liveOnly }
  }

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
    // Mark the screen ENGAGED before awaiting, not after: `upsert` folds into `history` only
    // once it is, and a grading pushed while this fetch is in flight is exactly what the
    // reconcile below exists to keep.
    historyLoaded.value = true
    const seq = ++loadTicket
    latestOverviewLoad = seq
    try {
      const overview = await api.getKaizenOverview(ws.requireId())
      available.value = true
      // A newer overview load superseded this one while it was in flight — discard the staler
      // result so it can't clobber the fresher history (and any grading live-pushed since).
      if (latestOverviewLoad !== seq) return
      verified.value = overview.verified
      // History is newest-first; live-pushed gradings are the newest, so prepend the survivors.
      const { reconciled, liveOnly } = reconcileWithLive(overview.gradings, history.value)
      history.value = [...liveOnly, ...reconciled]
    } catch (e) {
      if ((e as { statusCode?: number; status?: number })?.statusCode === 503)
        available.value = false
      else throw e
    } finally {
      loadingOverview.value = false
    }
  }

  function loadForExecution(executionId: string): Promise<void> {
    return loads.run(executionId, () => fetchForExecution(executionId))
  }

  async function fetchForExecution(executionId: string) {
    const ws = useWorkspaceStore()
    loadingExecution.value = new Set(loadingExecution.value).add(executionId)
    try {
      const { gradings } = await api.getKaizenForExecution(ws.requireId(), executionId)
      available.value = true
      // Two loads of one run can no longer overlap (`loads` coalesces them), so the per-execution
      // ticket this used to carry had nothing left to order and is gone. What remains is the live
      // race: a grading pushed via `upsert` while this fetch was out, which the merge keeps rather
      // than blind-replacing over.
      const { reconciled, liveOnly } = reconcileWithLive(
        gradings,
        byExecution.value[executionId] ?? [],
      )
      byExecution.value = { ...byExecution.value, [executionId]: [...reconciled, ...liveOnly] }
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
    // Keep the screen history live too (newest first), but ONLY once the screen has loaded it.
    // Prepending unconditionally made `history` grow one entry per grading for the session's
    // lifetime on every board, for a screen most sessions never open.
    if (!historyLoaded.value) return
    const inHistory = history.value.some((g) => g.id === grading.id)
    if (inHistory) history.value = history.value.map((g) => (g.id === grading.id ? grading : g))
    else history.value = [grading, ...history.value]
  }

  /**
   * Drop everything scoped to a board. Called on a board SWITCH: gradings are keyed by run and a
   * run belongs to one board, so without this `byExecution` grows a key per run of every board the
   * session visits and the screen shows the previous board's history until it reloads.
   * `available` survives: whether the deployment wires Kaizen at all is not a per-board fact.
   */
  function reset() {
    byExecution.value = {}
    history.value = []
    historyLoaded.value = false
    verified.value = []
  }

  const isLoadingExecution = (executionId: string) => loadingExecution.value.has(executionId)
  const verifiedCount = computed(() => verified.value.filter((c) => c.verified).length)

  return {
    byExecution,
    history,
    reset,
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
