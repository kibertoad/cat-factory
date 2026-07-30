import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Decision, ExecutionInstance, PipelineStep, StepApproval } from '~/types/domain'
import { createExecutionCommands } from '~/stores/execution/commands'

/**
 * Running pipeline instances. The simulation engine lives on the backend: this
 * store mirrors the server's executions and drives them via the API. Commands
 * call the worker and then refresh the workspace snapshot, since advancing an
 * execution also rolls status/progress up onto its block server-side.
 *
 * The run-control commands live in a cohesive factory ({@link createExecutionCommands}, under
 * `stores/execution/`) that closes over the state assembled here — a size-only split mirroring
 * `stores/board/`, not a new seam.
 */
export const useExecutionStore = defineStore('execution', () => {
  const api = useApi()
  // Centralised actionable toasts for run-control failures: a 409 with no configured
  // provider opens the AI setup; the other tagged conflicts get worded titles. Living
  // in the store means every caller (board card, drag-drop, menus, restart controls)
  // gets identical handling, including the fire-and-forget ones that never caught.
  const runErrors = usePipelineErrorToast()
  const instances = ref<ExecutionInstance[]>([])
  // The workspace whose snapshot last hydrated the cache. Scopes the DROP-preservation
  // below: a board SWITCH replaces the cache outright instead of leaking the previous
  // board's runs (an ExecutionInstance carries no workspaceId of its own).
  let hydratedWorkspaceId: string | null = null

  /** A run's monotonic server revision (bumped on every persisted write; absent = 0). */
  function revOf(e: ExecutionInstance): number {
    return e.rev ?? 0
  }

  /** A finished run — nothing further will execute or emit. Matches `runLive`/`runFailed`. */
  function isTerminal(status: ExecutionInstance['status']): boolean {
    return status === 'done' || status === 'failed'
  }

  /**
   * Carry forward each step's LLM-metrics rollup (`step.metrics`) when an incoming
   * instance omits it. Metrics is DERIVED, LIVE-ONLY state: the backend attaches it only
   * on step-boundary/terminal emits (not on the frequent progress-only running folds — a
   * perf optimisation that skips the per-run metrics GROUP BY on every poll tick) and
   * never persists it, so it rides neither the snapshot nor a running-fold event. A plain
   * REPLACE would blank the per-step metrics bar on every progress tick; per the live-push
   * coherence rules a REPLACE must not drop live-only state, so preserve the last-known
   * rollup per step. Steps are positionally stable within a run (same id ⇒ same shape), so
   * match by index; the agentKind guard is belt-and-suspenders against a reshaped list.
   */
  function withPreservedMetrics(
    incoming: ExecutionInstance,
    cached: ExecutionInstance | undefined,
  ): ExecutionInstance {
    if (!cached) return incoming
    let changed = false
    const steps = incoming.steps.map((step, i) => {
      if (step.metrics != null) return step
      const prior = cached.steps[i]
      if (prior?.metrics == null || prior.agentKind !== step.agentKind) return step
      changed = true
      return { ...step, metrics: prior.metrics }
    })
    return changed ? { ...incoming, steps } : incoming
  }

  /**
   * Reconcile the cached executions with a server snapshot for `workspaceId`. A snapshot
   * is authoritative EXCEPT where a live `execution` event already advanced (or ADDED) a
   * run past what this (possibly stale) read observed — the same two clobber hazards the
   * `agentRuns` store guards, keyed here on the run's monotonic `rev`:
   *   - REGRESS: a run present in BOTH — keep the newer-by-`rev` version, so a lagging
   *     refresh (the stream's on-(re)connect resync, the debounced `board`-event refetch)
   *     can't revert a just-terminal run to `running`. A terminal run emits nothing
   *     further, so a regression here would strand the UI until an unrelated refresh.
   *   - DROP: a run a live event just ADDED that the (older) snapshot never saw — keep it
   *     rather than silently dropping it, but ONLY when it is not the terminal predecessor a
   *     retry replaced (see below).
   *
   * The DROP caveat matters because a retry/restart REPLACES a block's run with a fresh one
   * under a NEW id (the old run is deleted server-side), so the two attempts can't be
   * reconciled by id or `rev`. Since there is exactly one run per block, a cached-only run
   * whose block the snapshot already covers is that superseded predecessor — drop it.
   * Preserving it would leave the dead `failed` run shadowing the running one in the by-block
   * projection (`agentRuns.byBlock`, last-write-wins), keeping the failure banner up and its
   * empty trail hiding the retry's carried-forward failure history.
   *
   * The drop is gated on the cached run being TERMINAL (`done`/`failed`): only a finished
   * predecessor is ever superseded. A cached run still `running`/`blocked`/`paused` is a
   * genuinely live-added run, so it must survive even when a stale reconnect snapshot (fetched
   * before a retry, resolving late under load — see `useWorkspaceStream`) still lists its
   * block's now-deleted predecessor. Dropping a live run there would strand the UI showing the
   * dead attempt — the inverse of the bug this guard fixes — and `rev` can't catch it (the
   * ids differ).
   */
  function hydrate(next: ExecutionInstance[], workspaceId: string) {
    const sameWorkspace = hydratedWorkspaceId === workspaceId
    hydratedWorkspaceId = workspaceId
    if (!sameWorkspace) {
      instances.value = next
      return
    }
    const incomingIds = new Set(next.map((e) => e.id))
    const incomingBlocks = new Set(next.map((e) => e.blockId))
    const held = new Map(instances.value.map((e) => [e.id, e]))
    const reconciled = next.map((incoming) => {
      const current = held.get(incoming.id)
      if (current && revOf(current) > revOf(incoming)) return current
      return withPreservedMetrics(incoming, current)
    })
    // Preserve a cached-only run UNLESS it is the terminal predecessor a retry replaced: a
    // finished (`done`/`failed`) run whose block the snapshot now covers under a fresh id.
    // Gating on the CACHED run being terminal keeps a live `running`/`blocked`/`paused` run
    // that a stale snapshot happens to omit.
    const preserved = [...held.values()].filter(
      (e) => !incomingIds.has(e.id) && !(isTerminal(e.status) && incomingBlocks.has(e.blockId)),
    )
    instances.value = [...reconciled, ...preserved]
  }

  /**
   * Insert or replace a single execution instance pushed by the event stream.
   * Monotonic by `rev`: an out-of-order/stale event can't regress a run a newer
   * write already advanced (same guard as {@link hydrate}).
   */
  function upsert(instance: ExecutionInstance) {
    const i = instances.value.findIndex((e) => e.id === instance.id)
    if (i >= 0) {
      if (revOf(instance) >= revOf(instances.value[i]!))
        instances.value[i] = withPreservedMetrics(instance, instances.value[i]!)
    } else instances.value.push(instance)
  }

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
    return state
  }

  const byId = computed(() => {
    const map = new Map<string, ExecutionInstance>()
    for (const e of instances.value) map.set(e.id, e)
    return map
  })

  function getInstance(id: string | null | undefined) {
    return id ? byId.value.get(id) : undefined
  }

  function getByBlock(blockId: string) {
    const runs = instances.value.filter((e) => e.blockId === blockId)
    if (runs.length <= 1) return runs[0]
    // A block only holds several runs transiently: a stale reconnect snapshot re-listing a
    // retry's now-deleted terminal predecessor alongside the live successor. Prefer the live
    // one so this projection agrees with `agentRuns.byBlock` (whose last-write-wins already
    // resolves to it) — the failed predecessor is dead and about to fall out on the next read.
    return runs.find((e) => !isTerminal(e.status)) ?? runs.at(-1)
  }

  /** How many decisions anywhere are awaiting a human. */
  const pendingDecisionCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.decision && !s.decision.chosen).length,
      0,
    ),
  )

  /** All currently-unresolved decisions across all runs (for the toolbar/queue). */
  const openDecisions = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      decision: Decision
      agentKind: PipelineStep['agentKind']
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.decision && !s.decision.chosen) {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            decision: s.decision,
            agentKind: s.agentKind,
          })
        }
      }
    }
    return out
  })

  /** All currently-pending approval gates across all runs (board badges/queue). */
  const openApprovals = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      approval: StepApproval
      agentKind: PipelineStep['agentKind']
      /**
       * Whether the gate's proposal is a RENDERING of an artifact the step already committed
       * (`step.outputIsRendered`). Projected here because a surface that reviews the proposal
       * WITHOUT the step in hand — the initiative tracker's plan-approval rail — otherwise has
       * no way to tell a rendered document from the agent's raw transcript summary, and would
       * present a one-line summary as though it were the artifact.
       */
      outputIsRendered: boolean
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.approval?.status === 'pending') {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            approval: s.approval,
            agentKind: s.agentKind,
            outputIsRendered: s.outputIsRendered === true,
          })
        }
      }
    }
    return out
  })

  /**
   * Open decisions/approvals grouped by the block they belong to, so a board card
   * resolves its own + its tasks' pending gates with O(1) lookups instead of
   * re-filtering the global lists once per frame on every execution event.
   */
  function groupByBlock<T extends { blockId: string }>(items: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>()
    for (const item of items) {
      const list = map.get(item.blockId)
      if (list) list.push(item)
      else map.set(item.blockId, [item])
    }
    return map
  }
  const decisionsByBlock = computed(() => groupByBlock(openDecisions.value))
  const approvalsByBlock = computed(() => groupByBlock(openApprovals.value))

  /** How many approval gates anywhere are awaiting a human. */
  const pendingApprovalCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.approval?.status === 'pending').length,
      0,
    ),
  )

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
    getByBlock,
    pendingDecisionCount,
    openDecisions,
    openApprovals,
    decisionsByBlock,
    approvalsByBlock,
    pendingApprovalCount,
    ...commands,
  }
})
