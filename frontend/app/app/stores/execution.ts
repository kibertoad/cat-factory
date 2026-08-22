import { defineStore } from 'pinia'
import { ref, computed, shallowRef, triggerRef } from 'vue'
import type { ExecutionInstance } from '~/types/domain'
import { createExecutionCommands } from '~/stores/execution/commands'
import { createPendingGateSelectors } from '~/stores/execution/pendingGates'
import { createExecutionReconcile } from '~/stores/execution/reconcile'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Running pipeline instances. The simulation engine lives on the backend: this
 * store mirrors the server's executions and drives them via the API. Commands
 * call the worker and then refresh the workspace snapshot, since advancing an
 * execution also rolls status/progress up onto its block server-side.
 *
 * Three cohesive factories under `stores/execution/` close over the state assembled here, all
 * size-only splits mirroring `stores/board/` rather than new seams: the snapshot/event reconcile
 * ({@link createExecutionReconcile}), the human-gate projections
 * ({@link createPendingGateSelectors}) and the run-control commands
 * ({@link createExecutionCommands}).
 */
export const useExecutionStore = defineStore('execution', () => {
  const api = useApi()
  // Centralised actionable toasts for run-control failures: a 409 with no configured
  // provider opens the AI setup; the other tagged conflicts get worded titles. Living
  // in the store means every caller (board card, drag-drop, menus, restart controls)
  // gets identical handling, including the fire-and-forget ones that never caught.
  const runErrors = usePipelineErrorToast()
  /**
   * Every cached run.
   *
   * SHALLOW on purpose. A deep `ref` proxies the whole run graph (run to steps to subtasks to
   * items), and the swimlane assembly, the cards and the pipeline strips read step fields
   * constantly, so every one of those reads paid proxy overhead on a structure that is only ever
   * written through this store. Three write sites keep it coherent, and there are no others:
   * {@link hydrate} and `cancel` replace the array (which a shallow ref tracks on its own);
   * {@link upsert} index-assigns or pushes; {@link echoAfter} lets an action store patch ONE step
   * in place. The last two announce the change with `triggerRef`.
   *
   * A reactivity regression here is SILENT (a card simply stops updating), so a new write path
   * must either replace the array or trigger, and the store specs are what pin that.
   */
  const instances = shallowRef<ExecutionInstance[]>([])

  // Snapshot/event reconcile: `hydrate`, `upsert` and the two shared predicates
  // (`stores/execution/reconcile.ts`).
  const { revOf, isTerminal, hydrate, upsert } = createExecutionReconcile(instances)

  const byId = computed(() => {
    const map = new Map<string, ExecutionInstance>()
    for (const e of instances.value) map.set(e.id, e)
    return map
  })

  /**
   * Run an action that returns a run's authoritative sub-state and apply that state to the cached
   * run as an OPTIMISTIC ECHO — but only when the event stream has not delivered a newer revision
   * while the request was in flight.
   *
   * WHY THIS EXISTS. {@link upsert} and {@link hydrate} are monotonic by `rev`, so a stale stream
   * event can never regress a run. An action store's echo bypassed both: it reached into the cached
   * instance and assigned `step.forkDecision` / `step.prReview` / `step.judge` / `step.followUps`
   * directly, with nothing comparing revisions. That is a live-push CLOBBER in its optimistic-echo
   * form, and it loses state that no later event restores.
   *
   * The fork-decision chat is the case that caught it. `chat` records the human turn and wakes the
   * durable driver, which computes the reply and re-parks — two separate emits. With no model wired
   * the reply is canned, so the driver routinely emits the two-message thread BEFORE the browser has
   * even processed the HTTP response carrying the one-message `answering` state. Echoing that
   * response then dropped the reply back off the thread, permanently: the run is parked, so nothing
   * emits again. It read as a hung "thinking…" bubble to a user and as a flaky spec in CI.
   *
   * The guard is the run's own `rev`, captured BEFORE the request and re-read after. Any advance
   * means the stream has already delivered this write (or something later), so the echo has nothing
   * left to add and is skipped. Unchanged means the echo is still the freshest thing available,
   * which is exactly what it is for. Taking the request as a thunk keeps the capture-then-compare
   * ordering here rather than at four call sites that each have to remember it.
   */
  async function echoAfter<T>(
    executionId: string,
    send: () => Promise<T>,
    apply: (state: T, instance: ExecutionInstance) => void,
  ): Promise<T> {
    const before = byId.value.get(executionId)
    const revBefore = before ? revOf(before) : -1
    const state = await send()
    const instance = byId.value.get(executionId)
    if (!instance || revOf(instance) !== revBefore) return state
    apply(state, instance)
    // The echo patches a STEP in place, which a shallow `instances` cannot see. This is the one
    // seam every action store's `assign` goes through, which is what makes one trigger enough.
    triggerRef(instances)
    return state
  }

  function getInstance(id: string | null | undefined) {
    return id ? byId.value.get(id) : undefined
  }

  /** Run ids whose whole-run fetch is in flight, so a reader can say "loading" rather than "empty". */
  const fullPending = ref<Set<string>>(new Set())
  /**
   * Last whole-run fetch error per run id. A withheld field and a failed fetch are different facts
   * and a reader that cannot tell them apart renders the outage as a step that said nothing, so the
   * failure is recorded rather than swallowed.
   */
  const fullErrors = ref<Record<string, string | null>>({})
  /** In-flight fetches, so two overlays opening the same run make ONE request. */
  const fullInFlight = new Map<string, Promise<void>>()

  function isFullPending(id: string | null | undefined): boolean {
    return !!id && fullPending.value.has(id)
  }

  function fullError(id: string | null | undefined): string | null {
    return id ? (fullErrors.value[id] ?? null) : null
  }

  /**
   * Make sure the cached run carries what the board snapshot's LEAN PROJECTION withholds: the
   * step prose every step-detail overlay renders. A no-op for a run the cache already holds whole
   * (one delivered by a live `execution` event, or already fetched), so opening a window on an
   * active run costs nothing.
   *
   * Single-flight per run id: a board click can open the window and its shell in the same tick,
   * and two overlays reading one run must not fire two point-reads of the heaviest row in it.
   */
  async function ensureFull(id: string | null | undefined): Promise<void> {
    if (!id) return
    const cached = byId.value.get(id)
    if (cached && !cached.projected) return
    const inFlight = fullInFlight.get(id)
    if (inFlight) return inFlight
    const ws = useWorkspaceStore()
    const workspaceId = ws.workspaceId
    if (!workspaceId) return
    fullPending.value = new Set(fullPending.value).add(id)
    const request = api
      .getExecution(workspaceId, id)
      .then((full) => {
        fullErrors.value = { ...fullErrors.value, [id]: null }
        upsert(full)
      })
      .catch((error: unknown) => {
        fullErrors.value = {
          ...fullErrors.value,
          [id]: error instanceof Error ? error.message : 'Failed to load the run',
        }
      })
      .finally(() => {
        fullInFlight.delete(id)
        const next = new Set(fullPending.value)
        next.delete(id)
        fullPending.value = next
      })
    fullInFlight.set(id, request)
    return request
  }

  /**
   * Each block's run, indexed once per change to `instances` instead of scanned per lookup.
   *
   * A block only holds several runs transiently: a stale reconnect snapshot re-listing a retry's
   * now-deleted terminal predecessor alongside the live successor. Prefer the live one so this
   * projection agrees with `agentRuns.byBlock` (whose last-write-wins already resolves to it):
   * the failed predecessor is dead and about to fall out on the next read.
   *
   * The single pass states that rule as "replace whatever is held whenever it is TERMINAL", which
   * is the array form (`runs.find(live) ?? runs.at(-1)`) exactly: the first live run wins and is
   * never displaced, and with no live run the LAST terminal one wins. Keep the two in step, since
   * this is the only place the rule is written now.
   *
   * WHY AN INDEX. {@link getByBlock} was a full `instances` scan per call on three per-event hot
   * paths: a computed on every mounted task card (`TaskPipelineMini`), `classify` inside the
   * swimlane assembly of every mounted frame (`useFrameLanes`), and the board's expansion
   * measurement pass (`useTaskExpansion`, per hover probe and per task when deep-zoomed). Each
   * execution event invalidated all of them, so the board paid O(cards x runs) per event where one
   * shared Map pays O(runs).
   */
  const byBlockLive = computed(() => {
    const map = new Map<string, ExecutionInstance>()
    for (const e of instances.value) {
      const held = map.get(e.blockId)
      if (!held || isTerminal(held.status)) map.set(e.blockId, e)
    }
    return map
  })

  function getByBlock(blockId: string) {
    return byBlockLive.value.get(blockId)
  }

  // What across every cached run is awaiting a human (open decisions + approval gates, their
  // per-block indexes and the two badge counts), extracted into a cohesive factory over the same
  // `instances` ref — a size-only split mirroring `createExecutionCommands` below.
  const pendingGates = createPendingGateSelectors(instances)

  // The run-control commands (start / decide / approve / merge / restart / cancel / stop),
  // extracted into a cohesive factory sharing the state above (a size-only split mirroring
  // `stores/board/` and `stores/pipelines/` — behaviour is identical to the former in-closure
  // functions).
  const commands = createExecutionCommands({ api, runErrors, instances })

  return {
    instances,
    hydrate,
    upsert,
    echoAfter,
    byId,
    getInstance,
    ensureFull,
    isFullPending,
    fullError,
    getByBlock,
    ...pendingGates,
    ...commands,
  }
})
