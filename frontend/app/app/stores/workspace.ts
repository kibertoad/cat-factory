import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BudgetCaps,
  SpendStatus,
  WorkspaceAccess,
  WorkspaceListItem,
  WorkspaceSnapshot,
} from '~/types/domain'
import { useAccountsStore } from '~/stores/accounts'
import { useBoardStore } from '~/stores/board'
import { useNotificationsStore } from '~/stores/notifications'
import type { LiveWriteBaselines } from '~/stores/workspace/hydrate'
import { applySnapshotToStores, resetPerBoardCaches } from '~/stores/workspace/hydrate'
import { createWorkspaceCommands } from '~/stores/workspace/commands'
import { createInfraSetupState } from '~/stores/workspace/infraSetup'
import { markBoot } from '~/utils/bootMarks'
import { retryWhileBackendUnreachable } from '~/utils/backendReady'

/**
 * Owns the active workspace and bootstraps the app against the backend. On load
 * it resolves the user's accounts, lists the boards in the active account, opens
 * the persisted one (or the first, or a fresh seeded board), and hydrates the
 * board / pipelines / execution stores from its snapshot.
 *
 * Boards are scoped to an account: switching account re-scopes the board list,
 * and new boards are stamped with the active account so a team can keep org
 * boards separate from personal ones. Only the active workspace id is persisted —
 * all board data lives on the server.
 */
export const useWorkspaceStore = defineStore(
  'workspace',
  () => {
    const api = useApi()

    /** Active workspace id (persisted so a reload reopens the same board). */
    const workspaceId = ref<string | null>(null)
    /**
     * Every board visible to the user, across the accounts they belong to. Each row is
     * annotated by `GET /workspaces` with the caller's effective workspace-RBAC role
     * (`viewerRole`) so a restricted board can be badged in the switcher.
     */
    const workspaces = ref<WorkspaceListItem[]>([])
    /** True once the initial snapshot has been loaded and stores hydrated. */
    const ready = ref(false)
    /** Set when bootstrap fails so the UI can show a retry. */
    const error = ref<string | null>(null)
    /** Latest WORKSPACE-tier spend-safeguard status from the server (null until first load). */
    const spend = ref<SpendStatus | null>(null)
    /** ACCOUNT-tier spend status (null when the tier is inactive or unavailable). */
    const accountSpend = ref<SpendStatus | null>(null)
    /** USER-tier spend status for the signed-in caller (null when inactive). */
    const userSpend = ref<SpendStatus | null>(null)
    /** Operator hard ceilings on the account/user budget tiers (null until first load). */
    const budgetCaps = ref<BudgetCaps | null>(null)
    // The infra-setup slice (the banner's projection + the live reachability patch), extracted
    // because it is the one slice with RULES rather than a plain assign-from-snapshot.
    const {
      infraSetup,
      infraSetupDetails,
      hydrate: hydrateInfraSetup,
      patchInfraSetup,
    } = createInfraSetupState()
    /**
     * The signed-in caller's resolved workspace-RBAC access to the ACTIVE board — their
     * effective role + the permission set it grants, from the auth gate's resolution
     * (attached to the snapshot with zero extra reads). Null on an older backend OR in
     * dev-open (auth disabled) — `useWorkspaceAccess()` then allows everything (backend
     * parity). Consumers MUST go through `useWorkspaceAccess()`, never read this directly.
     */
    const access = ref<WorkspaceAccess | null>(null)

    /** The boards belonging to the active account (all boards when auth is off). */
    const accountWorkspaces = computed(() => {
      const accounts = useAccountsStore()
      if (!accounts.enabled || !accounts.activeAccountId) return workspaces.value
      return workspaces.value.filter((w) => w.accountId === accounts.activeAccountId)
    })

    /** The active board's row (for the switcher label). */
    const activeWorkspace = computed(
      () => workspaces.value.find((w) => w.id === workspaceId.value) ?? null,
    )

    /**
     * Push a snapshot into the data stores. `baselines` (captured BEFORE this snapshot's fetch)
     * lets the replace-style stores preserve anything written live while the fetch was in flight,
     * so a slower refresh can't clobber newer live state (see {@link LiveWriteBaselines}). Omitted
     * by fresh loads (init/switch/create), where there is no in-flight race to guard.
     */
    function hydrate(snapshot: WorkspaceSnapshot, baselines?: LiveWriteBaselines) {
      // A change of active board (or the first load) drops the per-block caches that are NOT
      // part of the snapshot; a same-board refresh keeps them (see `resetPerBoardCaches`).
      if (workspaceId.value !== snapshot.workspace.id) resetPerBoardCaches()
      workspaceId.value = snapshot.workspace.id
      spend.value = snapshot.spend ?? null
      accountSpend.value = snapshot.accountSpend ?? null
      userSpend.value = snapshot.userSpend ?? null
      budgetCaps.value = snapshot.budgetCaps ?? null
      hydrateInfraSetup(snapshot.infraSetup)
      access.value = snapshot.access ?? null
      // Keep the board list in step (e.g. a freshly created board, or a rename). The
      // snapshot's `workspace` carries no `viewerRole` (that's a `GET /workspaces` list
      // annotation), so preserve any existing badge rather than clobbering it to absent.
      const existingRow = workspaces.value.find((w) => w.id === snapshot.workspace.id)
      if (existingRow) {
        Object.assign(existingRow, snapshot.workspace)
      } else {
        workspaces.value.unshift(snapshot.workspace)
      }
      // Fan the rest of the snapshot out into the per-feature data stores.
      applySnapshotToStores(snapshot, baselines)
    }

    /** Resolve accounts + boards, then open the right board for the active account. */
    async function init() {
      ready.value = false
      error.value = null
      try {
        // Cold-open waterfall flattening (app-startup initiative, item 8): the persisted board is
        // usually known from localStorage BEFORE any request fires, and its snapshot is the app's
        // heaviest payload (the ~18-read aggregate). Fetch it SPECULATIVELY in parallel with the
        // workspace list + accounts instead of waiting for the list to resolve first — one fewer
        // sequential round trip on the critical path. Validated for membership in
        // resolveActiveBoard; a stale/removed persisted id just discards the speculative result and
        // falls back to today's path. `.catch` keeps a gone-board 404 from rejecting the whole init.
        const persistedId = workspaceId.value
        const speculativeSnapshot = persistedId
          ? api.getWorkspace(persistedId).catch(() => null)
          : null
        // Accounts (an auth concept — empty in dev, which leaves boards unscoped) and the
        // workspace list are independent, so fetch them concurrently. resolveActiveBoard
        // needs both, so it still runs after.
        const [, workspaceList] = await Promise.all([
          useAccountsStore()
            .load()
            .catch(() => {}),
          // Retry a not-listening-yet backend (cold-start race) before surfacing the
          // unreachable screen. This gates the rest of init, so once it resolves the
          // backend is up and the speculative/follow-up snapshot fetches succeed too.
          retryWhileBackendUnreachable(() => api.listWorkspaces()),
        ])
        markBoot('workspaces-listed')
        workspaces.value = workspaceList
        await resolveActiveBoard(await speculativeSnapshot)
        markBoot('snapshot-hydrated')
        ready.value = true
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Failed to reach the backend.'
      }
    }

    /**
     * Open the persisted board (aligning the active account to it), else pick/create one.
     *
     * `prefetched` is the speculatively-fetched snapshot for the persisted board (see {@link init}):
     * when it's for the SAME still-valid board we reuse it instead of re-fetching, so the cold open
     * pays exactly one snapshot fetch — overlapped with the workspace list rather than after it.
     */
    async function resolveActiveBoard(prefetched?: WorkspaceSnapshot | null) {
      const accounts = useAccountsStore()
      if (workspaceId.value) {
        const existing = workspaces.value.find((w) => w.id === workspaceId.value)
        if (existing) {
          if (accounts.enabled && existing.accountId) accounts.activeAccountId = existing.accountId
          hydrate(
            prefetched && prefetched.workspace.id === existing.id
              ? prefetched
              : await api.getWorkspace(existing.id),
          )
          return
        }
        // Persisted board is gone (deleted, or now another tenant's) — fall through (and discard the
        // now-irrelevant speculative snapshot).
        workspaceId.value = null
      }
      const first = accountWorkspaces.value[0]
      if (first) {
        hydrate(await api.getWorkspace(first.id))
      } else {
        hydrate(
          await api.createWorkspace({
            seed: false,
            accountId: accounts.activeAccountId ?? undefined,
          }),
        )
      }
    }

    // Board CRUD (open / create / rename / delete) + the account switch, extracted into a
    // cohesive factory over the state above — a size-only split mirroring `hydrate.ts` and
    // `infraSetup.ts`.
    const { switchTo, selectAccount, create, update, rename, remove } = createWorkspaceCommands({
      api,
      workspaceId,
      workspaces,
      hydrate,
      resolveActiveBoard,
    })

    // Monotonic guard for {@link refresh}: `board`-type stream events (and the on-connect resync)
    // each fire a full-snapshot refresh, and {@link hydrate} REPLACES the block list. Without
    // ordering, two in-flight fetches can resolve out of order, so a slower/staler snapshot's
    // hydrate clobbers a newer one — dropping a just-spawned block whose ONLY live delivery was
    // the coarse `board` event (there is no per-block push), so its card never reappears (no
    // further event to restore it). Stamping each call lets only the latest-issued refresh commit.
    let refreshSeq = 0

    /** Re-fetch the snapshot and re-hydrate (after mutations and on stream (re)connect). */
    async function refresh() {
      const targetId = workspaceId.value
      if (!targetId) return
      const seq = ++refreshSeq
      // Capture the live-write baselines BEFORE the fetch: anything a live event writes while
      // this (potentially slow) snapshot is in flight is newer than the snapshot, so `hydrate`
      // must NOT clobber it back. The `refreshSeq` guard below only orders refreshes against each
      // OTHER — this guards a refresh against an interleaved live write (a run's terminal status
      // landing mid-fetch, or the inbox card it raises), the coherence hazard under CI latency.
      const baselines: LiveWriteBaselines = {
        board: useBoardStore().hydrateBaseline(),
        notifications: useNotificationsStore().hydrateBaseline(),
      }
      const snapshot = await api.getWorkspace(targetId)
      // A newer refresh was issued (or the active board switched) while this fetch was in flight —
      // discard this older/staler result so it can't clobber the newer hydrate.
      if (seq !== refreshSeq || workspaceId.value !== targetId) return
      hydrate(snapshot, baselines)
    }

    /** The active workspace id, or throw if the app isn't bootstrapped yet. */
    function requireId(): string {
      if (!workspaceId.value) throw new Error('No active workspace')
      return workspaceId.value
    }

    /** Resume runs paused by the spend safeguard, then refresh the snapshot. */
    async function resumeSpend() {
      await api.resumeSpend(requireId())
      await refresh()
    }

    return {
      workspaceId,
      workspaces,
      accountWorkspaces,
      activeWorkspace,
      ready,
      error,
      spend,
      accountSpend,
      userSpend,
      budgetCaps,
      infraSetup,
      infraSetupDetails,
      patchInfraSetup,
      access,
      init,
      switchTo,
      selectAccount,
      create,
      update,
      rename,
      remove,
      refresh,
      requireId,
      resumeSpend,
    }
  },
  { persist: { pick: ['workspaceId'] } },
)
