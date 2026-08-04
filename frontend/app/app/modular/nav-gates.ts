import { computed } from 'vue'
import { hasActionablePark } from '~/modular/nav-gates.logic'
import type { NavGates } from '~/modular/nav-contributions'

/**
 * Build the reactive `gates` service the nav `slotFilter` reads (slice 1 of the
 * modular-vue adoption). Called once from the modular install plugin, where
 * Pinia + composables are available.
 *
 * Returns a plain object whose getters read the host's reactive RBAC /
 * availability state. Passed to the registry as a `service` (by reference, not
 * snapshotted), so when `navSlotFilter` reads `gates.canWriteBoard` inside the
 * `useReactiveSlots` computed the underlying reactive source is tracked — a
 * permission or connection flip re-gates every shell with no `recalculateSlots()`.
 *
 * This mirrors the exact gating the pre-slice-1 `SideBar` computeds encoded (see
 * `useWorkspaceAccess` for the dev-open "absent access ⇒ allow all" parity), plus
 * the interface tier (`advancedMode`), which rides the same service so a mode flip
 * re-gates all three shells through the same reactive path as a permission flip.
 */
export function createNavGates(): NavGates {
  const access = useWorkspaceAccess()
  const github = useGitHubStore()
  const library = useFragmentLibraryStore()
  const accounts = useAccountsStore()
  const auth = useAuthStore()
  const providerConnections = useProviderConnectionsStore()
  const uiMode = useUiModeStore()
  const board = useBoardStore()
  const execution = useExecutionStore()
  const reviews = useReviewStage()

  // A top-level frame IS a service (see `app/types/domain.ts`); modules are sub-frames.
  const hasService = computed(() => board.blocks.some((b) => b.level === 'frame' && !b.parentId))
  const hasTask = computed(() => board.blocks.some((b) => b.level === 'task'))

  // Every run gate below is scoped to runs on TASK blocks, because every surface they gate is
  // reached through a task card and its inspector (the card's Resolve action, the inspector's
  // step list and result views). A frame-level run — a blueprint pass, an initiative plan —
  // renders none of those, so counting it would offer a tour onto controls that do not exist.
  const taskBlockIds = computed(
    () => new Set(board.blocks.filter((b) => b.level === 'task').map((b) => b.id)),
  )
  const isTaskBlock = (blockId: string) => taskBlockIds.value.has(blockId)

  const hasRun = computed(() => execution.instances.some((e) => isTaskBlock(e.blockId)))
  // A run that finished successfully. `done` only: see `NavGates.boardHasFinishedRun` for
  // why a `failed` run is not a subject for the review/merge tour.
  const hasFinishedRun = computed(() =>
    execution.instances.some((e) => e.status === 'done' && isTaskBlock(e.blockId)),
  )
  // Mirrors what the CARD renders, exactly as the park gates do: `TaskCard` shows the shared
  // failure banner on `agentRun.status === 'failed'`, which is the anchor the diagnose tour
  // points at. Kept apart from `hasFinishedRun` because the two states render disjoint
  // controls — see `NavGates.boardHasFailedRun`.
  const hasFailedRun = computed(() =>
    execution.instances.some((e) => e.status === 'failed' && isTaskBlock(e.blockId)),
  )
  // Not the store's raw pending counts: those answer "is anything parked", while the tour
  // these gate anchors on the card affordance a park RENDERS. See `hasActionablePark`.
  const hasOpenDecision = computed(() =>
    hasActionablePark(execution.openDecisions, isTaskBlock, reviews.isBackground),
  )
  const hasPendingApproval = computed(() =>
    hasActionablePark(execution.openApprovals, isTaskBlock, reviews.isBackground),
  )

  const infrastructureAvailable = computed(
    () =>
      auth.infrastructure != null ||
      auth.localMode?.enabled === true ||
      providerConnections.isAvailable('runner-pool') ||
      providerConnections.isAvailable('environment'),
  )
  const isAccountAdmin = computed(() => accounts.activeAccount?.roles?.includes('admin') ?? false)

  return {
    get canWriteBoard() {
      return access.canWriteBoard.value
    },
    get canManageIntegrations() {
      return access.canManageIntegrations.value
    },
    get canManageSettings() {
      return access.canManageSettings.value
    },
    get githubAvailable() {
      return github.available === true
    },
    get libraryAvailable() {
      return library.available === true
    },
    get infrastructureAvailable() {
      // `integrations.manage` is required to provision/manage infrastructure, so
      // gate the whole section on it too (a member/viewer would only 403 inside).
      return access.canManageIntegrations.value && infrastructureAvailable.value
    },
    get accountsEnabled() {
      return accounts.enabled
    },
    get isAccountAdmin() {
      return isAccountAdmin.value
    },
    get advancedMode() {
      return uiMode.isAdvanced
    },
    get boardHasService() {
      return hasService.value
    },
    get boardHasTask() {
      return hasTask.value
    },
    get boardHasRun() {
      return hasRun.value
    },
    // The two park kinds read the execution store's existing open-decision / open-approval
    // projections rather than re-scanning `instances` here, so a tour can never disagree with
    // the queue that sent the user looking for it — then narrowed to the parks a task card
    // actually offers an action for (`hasActionablePark`).
    get boardHasOpenDecision() {
      return hasOpenDecision.value
    },
    get boardHasPendingApproval() {
      return hasPendingApproval.value
    },
    get boardHasFinishedRun() {
      return hasFinishedRun.value
    },
    get boardHasFailedRun() {
      return hasFailedRun.value
    },
  }
}
