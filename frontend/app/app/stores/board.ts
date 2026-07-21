import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Block } from '~/types/domain'
import { useBlockQueries } from '~/composables/useBlockQueries'
import type { PendingRemoval } from '~/stores/board/context'
import { createBoardMutations } from '~/stores/board/mutations'
import { createBoardRemoval } from '~/stores/board/removal'

/**
 * The board: architecture blocks and the dependency edges between them. Blocks
 * are owned by the backend — this store is a hydrated cache. Read getters are
 * pure client logic (see {@link useBlockQueries}); every mutation calls the API
 * and applies the authoritative block the server returns. The write operations
 * live in cohesive factories ({@link createBoardMutations} / {@link createBoardRemoval},
 * under `stores/board/`) that close over the shared state assembled here — a size-only
 * split, not a new seam.
 */
export const useBoardStore = defineStore('board', () => {
  const api = useApi()
  const toast = useToast()
  // Stores run outside a component `setup`, so resolve translations through the Nuxt app's
  // global i18n instance (the same handle `plugins/locale.client.ts` uses) rather than
  // `useI18n()`, which requires an active component instance.
  const nuxtApp = useNuxtApp()
  const tr = (key: string, params?: Record<string, unknown>): string =>
    (nuxtApp.$i18n as { t: (k: string, p?: Record<string, unknown>) => string }).t(
      key,
      params ?? {},
    )
  const blocks = ref<Block[]>([])
  // Client-side monotonic guard against a stale full-snapshot `hydrate` CLOBBERING newer live
  // state. A run's status transitions (…→ in_progress → pr_ready/done) reach the board as
  // targeted `execution`-event `upsert`s; a `refresh()` whose snapshot was FETCHED earlier (its
  // block still `in_progress`) can resolve AFTER such an upsert and, since `hydrate` REPLACES the
  // list, overwrite the just-applied terminal status back to the stale value — with no further
  // event to restore it (the documented real-time coherence hazard; reliably hit under CI
  // latency). Blocks carry no server revision, so we stamp each live `upsert` with a monotonic
  // sequence and let `hydrate` preserve any block upserted AFTER the refresh's captured baseline.
  let liveUpsertSeq = 0
  const liveUpsertAt = new Map<string, number>()
  // Archived service frames (`archived === true`): hidden from the board but preserved and
  // restorable with no expiry. Hydrated from the snapshot's `archivedServices`; the frames
  // themselves are NOT in `blocks` (the snapshot filters an archived frame + its subtree out).
  const archived = ref<Block[]>([])

  // Pure derivations (hierarchy, status/progress, sizing) live in the composable.
  const queries = useBlockQueries(blocks)
  const { getBlock } = queries

  /**
   * Blocks hidden by an optimistic delete whose backend call hasn't fired yet, keyed by
   * the deleted root's id. Their subtree stays filtered out of every incoming server
   * snapshot (`hydrate`) and single-block live event (`upsert`) for the undo window, so a
   * coarse refresh or a stray event can't resurrect a block the user just deleted.
   */
  const pendingRemovals = new Map<string, PendingRemoval>()
  // Flat set of every id in a pending removal (root + descendants), for O(1) checks in the
  // hot upsert path. Kept in lockstep with `pendingRemovals`.
  const pendingDoomed = new Set<string>()

  /**
   * Drop any pending-removal subtree from a reconciled block list and prune survivors'
   * edges to it — the same detach the backend will perform once the deferred delete fires.
   * Applied to every hydrate so the undo window survives a full refresh.
   */
  function applyPendingRemovals(list: Block[]): Block[] {
    if (pendingDoomed.size === 0) return list
    const survivors = list.filter((b) => !pendingDoomed.has(b.id))
    for (const b of survivors) {
      if (b.dependsOn.some((d) => pendingDoomed.has(d))) {
        b.dependsOn = b.dependsOn.filter((d) => !pendingDoomed.has(d))
      }
      if (b.epicId != null && pendingDoomed.has(b.epicId)) b.epicId = null
      if (b.initiativeId != null && pendingDoomed.has(b.initiativeId)) b.initiativeId = null
    }
    return survivors
  }

  /**
   * Reconcile the cached blocks against a server snapshot, reusing the existing
   * object for any block whose content is unchanged. The server stays authoritative
   * (it replaces optimistic edits and drops deleted blocks), but an unchanged block
   * keeps its identity, so a coarse full-refresh doesn't hand every frame/task a new
   * object reference and force the whole board to re-render — only genuinely changed
   * blocks invalidate. Blocks are emitted in a stable order by the backend mapper, so
   * a per-block JSON compare is a reliable, cheap (refresh is debounced) equality check.
   */
  // Per-object serialization cache, keyed by block identity so it self-invalidates: a
  // block we keep (same reference) stays cached, while a fresh/`upsert`ed object isn't in
  // the map and is re-serialized. Lets a hydrate stringify each kept block once (the
  // incoming snapshot) rather than twice (existing + incoming).
  const serialized = new WeakMap<Block, string>()
  function jsonFor(b: Block): string {
    let s = serialized.get(b)
    if (s === undefined) {
      s = JSON.stringify(b)
      serialized.set(b, s)
    }
    return s
  }
  /**
   * Baseline for {@link hydrate}: capture this BEFORE a refresh's snapshot fetch and pass it
   * back in, so a block that received a live `upsert` while the fetch was in flight is preserved
   * (its live state is newer than the snapshot). Callers that don't pass a baseline get a plain
   * full replace (initial load / board switch — no live-upsert race to guard).
   */
  function hydrateBaseline(): number {
    return liveUpsertSeq
  }
  function hydrate(next: Block[], since = liveUpsertSeq) {
    const prev = new Map(blocks.value.map((b) => [b.id, b]))
    const reconciled = next.map((n) => {
      const existing = prev.get(n.id)
      // A block live-`upsert`ed AFTER this refresh's fetch started is newer than the snapshot —
      // keep the live version instead of clobbering it back to the stale snapshot value.
      if (existing && (liveUpsertAt.get(n.id) ?? 0) > since) return existing
      return existing && jsonFor(existing) === jsonFor(n) ? existing : n
    })
    // Keep blocks the user just deleted hidden while their delete is still pending.
    blocks.value = applyPendingRemovals(reconciled)
  }

  /** Replace the archived-services list from the snapshot (absent ⇒ none). */
  function hydrateArchived(next: Block[] = []) {
    archived.value = [...next]
  }

  /** Insert or replace a block returned by the backend. */
  function upsert(block: Block) {
    // A live event for a block awaiting its deferred delete must not resurrect it.
    if (pendingDoomed.has(block.id)) return
    // Stamp the live-upsert order so a later, staler refresh `hydrate` can't clobber this.
    liveUpsertAt.set(block.id, ++liveUpsertSeq)
    const i = blocks.value.findIndex((b) => b.id === block.id)
    if (i >= 0) blocks.value[i] = block
    else blocks.value.push(block)
  }

  // The write operations, split into cohesive factories sharing the state above (a size-only
  // extraction — behaviour is identical to the former in-closure functions). `undoRemove` stays
  // internal to the removal factory (only its delete toast wires it), so it is NOT re-exported.
  const context = { blocks, getBlock, upsert, pendingRemovals, pendingDoomed, api, toast, tr }
  const mutations = createBoardMutations(context)
  const { detach, reattach, removeBlock } = createBoardRemoval(context)

  return {
    blocks,
    archived,
    hydrate,
    hydrateBaseline,
    hydrateArchived,
    upsert,
    ...queries,
    ...mutations,
    detach,
    reattach,
    removeBlock,
  }
})
