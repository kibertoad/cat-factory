import { triggerRef, type ShallowRef } from 'vue'
import type { ExecutionInstance } from '~/types/domain'

/**
 * The snapshot/event RECONCILE for the execution store: how a full board snapshot and a live
 * `execution` event fold into the cached runs without either clobbering the other, plus the two
 * shared predicates (`revOf`, `isTerminal`) the rest of the store asks the same questions with.
 *
 * Created once in the store setup over its `instances` ref, so the rules stay behaviourally
 * identical to the former in-closure functions: a size-only extraction mirroring
 * `createPendingGateSelectors` and `createExecutionCommands`, not a new seam.
 *
 * It is also where the writes a SHALLOW `instances` cannot see announce themselves. `echoAfter`
 * (still in the store, because it is about an ACTION's echo rather than about reconciling a read)
 * is the only other one.
 */
export function createExecutionReconcile(instances: ShallowRef<ExecutionInstance[]>) {
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
   * Carry forward what the board snapshot's LEAN PROJECTION withholds
   * (`projectExecutionForBoard`): each step's `output` prose, its `rework` and `testerQuality`
   * blobs, and the run-level `outputHistory`. Withheld is not absent, so a projection landing on
   * top of a full cached run must not blank an overlay someone is reading mid-scroll.
   *
   * ONLY AT AN EQUAL `rev`, which is what makes the carry-forward sound rather than a guess. At the
   * same revision the run is byte-identical server-side, so the cached prose IS the withheld prose.
   * One revision later it may not be (a step can have been re-run, reset or bounced), and pasting
   * the old prose under the new run is the same clobber in reverse. So a NEWER projection replaces,
   * stays marked `projected`, and the open overlay re-fetches the whole run (`ensureFull`).
   *
   * A merge that succeeds drops the `projected` mark when the cached run was itself complete: the
   * result carries everything the cache did, and leaving the mark set would make every overlay
   * re-fetch a run it already holds in full.
   */
  function withCarriedForwardWithheld(
    incoming: ExecutionInstance,
    cached: ExecutionInstance | undefined,
  ): ExecutionInstance {
    if (!incoming.projected || !cached || revOf(incoming) !== revOf(cached)) return incoming
    const steps = incoming.steps.map((step, i) => {
      const prior = cached.steps[i]
      // Positionally stable within a run (same guard as `withPreservedMetrics`).
      if (!prior || prior.agentKind !== step.agentKind) return step
      return {
        ...step,
        ...definedOnly({
          output: prior.output,
          rework: prior.rework,
          testerQuality: prior.testerQuality,
        }),
      }
    })
    return {
      ...incoming,
      steps,
      ...definedOnly({ outputHistory: cached.outputHistory }),
      ...(cached.projected ? {} : { projected: false }),
    }
  }

  /** The subset of `fields` that is actually present, so a spread never writes `undefined` over a value. */
  function definedOnly<T extends Record<string, unknown>>(fields: T): Partial<T> {
    return Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<T>
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
      return withCarriedForwardWithheld(withPreservedMetrics(incoming, current), current)
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
      if (revOf(instance) < revOf(instances.value[i]!)) return
      instances.value[i] = withCarriedForwardWithheld(
        withPreservedMetrics(instance, instances.value[i]!),
        instances.value[i]!,
      )
    } else instances.value.push(instance)
    // `instances` is shallow: an index assignment and a push are both invisible to it.
    triggerRef(instances)
  }

  return { revOf, isTerminal, hydrate, upsert }
}
