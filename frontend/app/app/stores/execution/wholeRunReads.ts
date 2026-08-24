import { ref } from 'vue'
import type { ExecutionInstance } from '~/types/domain'

/** What the whole-run reader needs from the store it belongs to, as bound callbacks. */
export interface WholeRunReadDeps {
  /** The cached run, if the store holds one under this id. Must be a REACTIVE read. */
  cached: (id: string) => ExecutionInstance | undefined
  /** The board the reads are scoped to, or null before one is loaded. */
  workspaceId: () => string | null
  /** The by-id point-read (`GET /workspaces/:ws/executions/:executionId`). */
  fetch: (workspaceId: string, executionId: string) => Promise<ExecutionInstance>
  /** Where a fetched run lands: the same monotonic reconcile a live event goes through. */
  apply: (instance: ExecutionInstance) => void
}

/**
 * The WHOLE-RUN read behind the step-detail overlays, extracted from the execution store as a
 * cohesive collaborator over bound callbacks (the shape `createExecutionReconcile` and
 * `createExecutionCommands` use).
 *
 * The board snapshot serves a LEAN PROJECTION of every run (`projectExecutionForBoard`): each
 * step's captured prose is WITHHELD, not absent, and the instance is stamped `projected`. A
 * surface that renders that prose asks here for the run behind it, and this owns the three facts
 * such a surface cannot work out for itself: whether it has to ask, whether an answer is still
 * coming, and whether the last one failed.
 */
export function createWholeRunReads(deps: WholeRunReadDeps) {
  /** Run ids whose whole-run fetch is in flight, so a reader can say "loading" rather than "empty". */
  const pending = ref<Set<string>>(new Set())
  /**
   * Last whole-run fetch error per run id. A withheld field and a failed fetch are different facts
   * and a reader that cannot tell them apart renders the outage as a step that said nothing, so the
   * failure is recorded rather than swallowed.
   *
   * A recorded failure is only ever READ through {@link fullError}, which withholds it once the run
   * is held whole: the prose can arrive by a route this fetch knows nothing about (a live
   * `execution` event delivers every run complete), and a banner saying the run could not be loaded
   * standing over prose that loaded is worse than no banner at all.
   */
  const errors = ref<Record<string, string | null>>({})
  /** In-flight fetches, so two overlays opening the same run make ONE request. */
  const inFlight = new Map<string, Promise<void>>()
  /**
   * Which BOARD the in-flight reads belong to. A fetch outlives the board that started it (a
   * switch mid-request is one click), and its result would otherwise be applied to the switched-to
   * board's cache as a run that board does not have. Bumped by {@link resetFullReads}; a request
   * whose generation is stale drops its answer.
   */
  let generation = 0

  function isFullPending(id: string | null | undefined): boolean {
    return !!id && pending.value.has(id)
  }

  function fullError(id: string | null | undefined): string | null {
    if (!id || !needsFull(id)) return null
    return errors.value[id] ?? null
  }

  /** Whether the cache is missing this run's withheld prose, so a reader of it has to ask. */
  function needsFull(id: string): boolean {
    const held = deps.cached(id)
    return !held || held.projected === true
  }

  /**
   * What a prose reader WATCHES to know it must ask: null while the cache holds the run whole, and
   * otherwise a key that changes whenever there is a fresh reason to ask.
   *
   * The reason to key on the revision rather than on the id is that a run does not stop being a
   * projection once an overlay is open. Any full refresh lands a lean projection over the run, and
   * at a NEWER revision the reconcile cannot carry the cached prose forward (it may no longer be
   * that run's prose), so an open overlay's prose is withheld again under it and only a re-fetch
   * restores it. Keyed on the id alone, the watch that fires on open never fires again and the
   * reader blanks with nothing left to refill it.
   */
  function fullFetchKey(id: string | null | undefined): string | null {
    if (!id || !needsFull(id)) return null
    return `${id}:${deps.cached(id)?.rev ?? 0}`
  }

  /**
   * Make sure the cached run carries what the projection withholds. A no-op for a run the cache
   * already holds whole (one delivered by a live `execution` event, or already fetched), so
   * opening a window on an active run costs nothing.
   *
   * Single-flight per run id: a board click can open the window and its shell in the same tick,
   * and two overlays reading one run must not fire two point-reads of the heaviest row in it.
   */
  async function ensureFull(id: string | null | undefined): Promise<void> {
    if (!id || !needsFull(id)) return
    const running = inFlight.get(id)
    if (running) return running
    const workspaceId = deps.workspaceId()
    if (!workspaceId) return
    const asked = generation
    pending.value = new Set(pending.value).add(id)
    // Clear any recorded failure up front: this attempt is what the reader is waiting on now, and
    // leaving the previous one in place would render a retry as a failure that already resolved.
    if (errors.value[id]) errors.value = { ...errors.value, [id]: null }
    const request = deps
      .fetch(workspaceId, id)
      .then((full) => {
        if (asked !== generation) return
        deps.apply(full)
      })
      .catch((error: unknown) => {
        if (asked !== generation) return
        errors.value = {
          ...errors.value,
          [id]: error instanceof Error ? error.message : 'Failed to load the run',
        }
      })
      .finally(() => {
        inFlight.delete(id)
        if (asked !== generation) return
        const next = new Set(pending.value)
        next.delete(id)
        pending.value = next
      })
    inFlight.set(id, request)
    return request
  }

  /**
   * Drop the read bookkeeping, and disown whatever is still in flight. Called on a board SWITCH,
   * beside the other per-board caches: the cached runs themselves are part of the snapshot and
   * `hydrate` replaces them, but the pending/failed marks and the requests behind them are keyed
   * by a run id the switched-to board does not have.
   */
  function resetFullReads() {
    generation += 1
    inFlight.clear()
    pending.value = new Set()
    errors.value = {}
  }

  return { ensureFull, fullFetchKey, fullError, isFullPending, resetFullReads }
}
