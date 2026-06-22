import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SpendStatus, Workspace, WorkspaceSnapshot } from '~/types/domain'
import { useAccountsStore } from '~/stores/accounts'
import { useBoardStore } from '~/stores/board'
import { usePipelinesStore } from '~/stores/pipelines'
import { useExecutionStore } from '~/stores/execution'
import { useAgentRunsStore } from '~/stores/agentRuns'
import { useNotificationsStore } from '~/stores/notifications'
import { useMergePresetsStore } from '~/stores/mergePresets'
import { useAgentConfigStore } from '~/stores/agentConfig'
import { useModelDefaultsStore } from '~/stores/modelDefaults'
import { useServiceFragmentDefaultsStore } from '~/stores/serviceFragmentDefaults'
import { useRecurringPipelinesStore } from '~/stores/recurringPipelines'
import { useServicesStore } from '~/stores/services'
import { useTrackerStore } from '~/stores/tracker'

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
    /** Every board visible to the user, across the accounts they belong to. */
    const workspaces = ref<Workspace[]>([])
    /** True once the initial snapshot has been loaded and stores hydrated. */
    const ready = ref(false)
    /** Set when bootstrap fails so the UI can show a retry. */
    const error = ref<string | null>(null)
    /** Latest spend-safeguard status from the server (null until first load). */
    const spend = ref<SpendStatus | null>(null)

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

    /** Push a snapshot into the data stores. */
    function hydrate(snapshot: WorkspaceSnapshot) {
      workspaceId.value = snapshot.workspace.id
      spend.value = snapshot.spend ?? null
      // Keep the board list in step (e.g. a freshly created board, or a rename).
      const i = workspaces.value.findIndex((w) => w.id === snapshot.workspace.id)
      if (i >= 0) workspaces.value[i] = snapshot.workspace
      else workspaces.value.unshift(snapshot.workspace)
      useBoardStore().hydrate(snapshot.blocks)
      usePipelinesStore().hydrate(snapshot.pipelines)
      useExecutionStore().hydrate(snapshot.executions)
      useAgentRunsStore().hydrate(snapshot.bootstrapJobs ?? [])
      useNotificationsStore().hydrate(snapshot.notifications ?? [])
      useMergePresetsStore().hydrate(snapshot.mergePresets ?? [])
      useAgentConfigStore().hydrate(snapshot.agentConfigCatalog ?? [])
      useModelDefaultsStore().hydrate(snapshot.modelDefaults?.defaults)
      useServiceFragmentDefaultsStore().hydrate(snapshot.serviceFragmentDefaults?.fragmentIds)
      useRecurringPipelinesStore().hydrate(snapshot.recurringPipelines ?? [])
      useTrackerStore().hydrate(snapshot.trackerSettings)
      useServicesStore().hydrate(snapshot.mounts ?? [], snapshot.serviceCatalog ?? [])
    }

    /** Resolve accounts + boards, then open the right board for the active account. */
    async function init() {
      ready.value = false
      error.value = null
      try {
        // Accounts are an auth concept — empty in dev, which leaves boards unscoped.
        await useAccountsStore()
          .load()
          .catch(() => {})
        workspaces.value = await api.listWorkspaces()
        await resolveActiveBoard()
        ready.value = true
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Failed to reach the backend.'
      }
    }

    /** Open the persisted board (aligning the active account to it), else pick/create one. */
    async function resolveActiveBoard() {
      const accounts = useAccountsStore()
      if (workspaceId.value) {
        const existing = workspaces.value.find((w) => w.id === workspaceId.value)
        if (existing) {
          if (accounts.enabled && existing.accountId) accounts.activeAccountId = existing.accountId
          hydrate(await api.getWorkspace(existing.id))
          return
        }
        // Persisted board is gone (deleted, or now another tenant's) — fall through.
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

    /** Switch to another board (within reach of the active account). */
    async function switchTo(id: string) {
      if (id === workspaceId.value) return
      hydrate(await api.getWorkspace(id))
    }

    /** Switch the active account, then open one of its boards (creating one if needed). */
    async function selectAccount(id: string) {
      const accounts = useAccountsStore()
      if (id === accounts.activeAccountId) return
      accounts.switchTo(id)
      workspaceId.value = null
      await resolveActiveBoard()
    }

    /** Create a new board in the active account and open it. */
    async function create(name?: string) {
      const accounts = useAccountsStore()
      const snapshot = await api.createWorkspace({
        seed: false,
        name,
        accountId: accounts.activeAccountId ?? undefined,
      })
      hydrate(snapshot)
      return snapshot.workspace
    }

    /** Rename a board. */
    async function rename(id: string, name: string) {
      const updated = await api.renameWorkspace(id, name)
      const i = workspaces.value.findIndex((w) => w.id === id)
      if (i >= 0) workspaces.value[i] = updated
      return updated
    }

    /** Delete a board; if it was active, fall back to another in the account. */
    async function remove(id: string) {
      await api.deleteWorkspace(id)
      workspaces.value = workspaces.value.filter((w) => w.id !== id)
      if (workspaceId.value === id) {
        workspaceId.value = null
        await resolveActiveBoard()
      }
    }

    /** Re-fetch the snapshot and re-hydrate (after mutations and on stream (re)connect). */
    async function refresh() {
      if (!workspaceId.value) return
      hydrate(await api.getWorkspace(workspaceId.value))
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
      init,
      switchTo,
      selectAccount,
      create,
      rename,
      remove,
      refresh,
      requireId,
      resumeSpend,
    }
  },
  { persist: { pick: ['workspaceId'] } },
)
