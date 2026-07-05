import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BudgetCaps,
  InfraSetup,
  SpendStatus,
  Workspace,
  WorkspaceSnapshot,
} from '~/types/domain'
import { useAccountsStore } from '~/stores/accounts'
import { useBoardStore } from '~/stores/board'
import { usePipelinesStore } from '~/stores/pipelines'
import { useExecutionStore } from '~/stores/execution'
import { useAgentRunsStore } from '~/stores/agentRuns'
import { useNotificationsStore } from '~/stores/notifications'
import { useMergePresetsStore } from '~/stores/mergePresets'
import { useSharedStacksStore } from '~/stores/sharedStacks'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import { useAgentConfigStore } from '~/stores/agentConfig'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useServiceFragmentDefaultsStore } from '~/stores/serviceFragmentDefaults'
import { useRecurringPipelinesStore } from '~/stores/recurringPipelines'
import { useInitiativesStore } from '~/stores/initiative'
import { useServicesStore } from '~/stores/services'
import { useAgentsStore } from '~/stores/agents'
import { useTrackerStore } from '~/stores/tracker'
import { useRequirementsStore } from '~/stores/requirements'
import { useClarityStore } from '~/stores/clarity'
import { useBrainstormStore } from '~/stores/brainstorm'
import { useConsensusStore } from '~/stores/consensus'
import { useGitHubStore } from '~/stores/github'
import { useFragmentsStore } from '~/stores/fragments'
import { useProviderConnectionsStore } from '~/stores/providerConnections'

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
    /** Latest WORKSPACE-tier spend-safeguard status from the server (null until first load). */
    const spend = ref<SpendStatus | null>(null)
    /** ACCOUNT-tier spend status (null when the tier is inactive or unavailable). */
    const accountSpend = ref<SpendStatus | null>(null)
    /** USER-tier spend status for the signed-in caller (null when inactive). */
    const userSpend = ref<SpendStatus | null>(null)
    /** Operator hard ceilings on the account/user budget tiers (null until first load). */
    const budgetCaps = ref<BudgetCaps | null>(null)
    /**
     * Per-area infrastructure-setup status (ephemeral environments / agent executor / binary
     * storage) from the snapshot, driving the infra-setup banner. Null on an older backend that
     * doesn't compute it (⇒ no banner).
     */
    const infraSetup = ref<InfraSetup | null>(null)

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
      // A change of active board (or the first load) — drop the per-block caches that are
      // NOT part of the snapshot (reviews, brainstorm/consensus sessions, the GitHub
      // projection) so a switched-to board never shows the previous one's stale state.
      // These are lazily reloaded/re-probed per board, so clearing on a same-board refresh
      // would needlessly wipe an open review window — hence only on an actual id change.
      if (workspaceId.value !== snapshot.workspace.id) {
        useRequirementsStore().reset()
        useClarityStore().reset()
        useBrainstormStore().reset()
        useConsensusStore().reset()
        useGitHubStore().reset()
        useInitiativesStore().reset()
        useDocInterviewStore().reset()
        // The fragment picker catalog is per-board (the merged tenant catalog), so drop
        // it too — the next inspector open re-fetches it for the switched-to board rather
        // than showing the previous board's (or a raw-id placeholder for) fragments.
        useFragmentsStore().invalidate()
      }
      workspaceId.value = snapshot.workspace.id
      spend.value = snapshot.spend ?? null
      accountSpend.value = snapshot.accountSpend ?? null
      userSpend.value = snapshot.userSpend ?? null
      budgetCaps.value = snapshot.budgetCaps ?? null
      useUserSettingsStore().hydrate(snapshot.userSettings ?? null)
      infraSetup.value = snapshot.infraSetup ?? null
      // Keep the board list in step (e.g. a freshly created board, or a rename).
      const i = workspaces.value.findIndex((w) => w.id === snapshot.workspace.id)
      if (i >= 0) workspaces.value[i] = snapshot.workspace
      else workspaces.value.unshift(snapshot.workspace)
      useBoardStore().hydrate(snapshot.blocks)
      usePipelinesStore().hydrate(snapshot.pipelines, snapshot.pipelineCatalogVersions)
      useExecutionStore().hydrate(snapshot.executions, snapshot.workspace.id)
      useAgentRunsStore().hydrate(snapshot.bootstrapJobs ?? [], snapshot.workspace.id)
      useAgentRunsStore().hydrateEnvConfigRepair(snapshot.envConfigRepairJobs ?? [])
      useNotificationsStore().hydrate(snapshot.notifications ?? [])
      useMergePresetsStore().hydrate(
        snapshot.mergePresets ?? [],
        snapshot.mergePresetCatalogVersions,
      )
      useSharedStacksStore().hydrate(snapshot.sharedStacks ?? [])
      useWorkspaceSettingsStore().hydrate(snapshot.settings)
      useAgentConfigStore().hydrate(snapshot.agentConfigCatalog ?? [])
      useModelPresetsStore().hydrate(snapshot.modelPresets ?? [])
      useServiceFragmentDefaultsStore().hydrate(snapshot.serviceFragmentDefaults?.fragmentIds)
      useRecurringPipelinesStore().hydrate(snapshot.recurringPipelines ?? [])
      useInitiativesStore().hydrate(snapshot.initiatives)
      useTrackerStore().hydrate(snapshot.trackerSettings)
      useServicesStore().hydrate(snapshot.mounts ?? [], snapshot.serviceCatalog ?? [])
      // Merge the deployment's registered custom agent kinds into the palette catalog so a
      // proprietary kind renders as a first-class block + result view (idempotent on reload).
      useAgentsStore().registerCustomKinds(snapshot.customAgentKinds ?? [])
      // Seed the connect form's backend-kind selectors (built-in + any custom backend a
      // deployment registered), so a programmatically-registered env/runner backend is a
      // first-class connect option instead of a hardcoded manifest/kubernetes list.
      useProviderConnectionsStore().registerBackendKinds({
        environment: snapshot.environmentBackendKinds,
        'runner-pool': snapshot.runnerBackendKinds,
      })
    }

    /** Resolve accounts + boards, then open the right board for the active account. */
    async function init() {
      ready.value = false
      error.value = null
      try {
        // Accounts (an auth concept — empty in dev, which leaves boards unscoped) and the
        // workspace list are independent, so fetch them concurrently. resolveActiveBoard
        // needs both, so it still runs after.
        const [, workspaceList] = await Promise.all([
          useAccountsStore()
            .load()
            .catch(() => {}),
          api.listWorkspaces(),
        ])
        workspaces.value = workspaceList
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
    async function create(name?: string, description?: string) {
      const accounts = useAccountsStore()
      const snapshot = await api.createWorkspace({
        seed: false,
        name,
        description,
        accountId: accounts.activeAccountId ?? undefined,
      })
      hydrate(snapshot)
      return snapshot.workspace
    }

    /** Rename a board and/or update its description. */
    async function update(id: string, patch: { name?: string; description?: string | null }) {
      const updated = await api.updateWorkspace(id, patch)
      const i = workspaces.value.findIndex((w) => w.id === id)
      if (i >= 0) workspaces.value[i] = updated
      return updated
    }

    /** Rename a board (kept for the existing rename callers). */
    async function rename(id: string, name: string) {
      return update(id, { name })
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
      accountSpend,
      userSpend,
      budgetCaps,
      infraSetup,
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
