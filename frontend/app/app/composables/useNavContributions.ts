import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { groupCommands, groupSidebar, sortToolbar } from '~/modular/nav-contributions'
import type {
  AppSlots,
  CommandGroup,
  NavActionId,
  NavContribution,
  SidebarGroup,
} from '~/modular/nav-contributions'

/**
 * The single source the three nav shells render from (slice 1 of the modular-vue
 * adoption). Reads the reactively-gated `nav` slot via `useReactiveSlots` — the
 * `slotFilter` has already dropped items the caller lacks permission for, and
 * the computed re-runs when a gate flips — then shapes the surviving items per
 * surface (via the pure helpers in `nav-contributions.ts`) and resolves each
 * item's action.
 *
 * First-party items carry an `action` id resolved here against the `ui` store; a
 * consumer-contributed item may instead carry its own `run` closure, which wins.
 */
export function useNavContributions() {
  const slots = useReactiveSlots<AppSlots>()
  const ui = useUiStore()

  // First-party action ids → host handlers. Typed as an exhaustive
  // `Record<NavActionId, …>`, so a catalog `action` with no handler (or a handler
  // with no catalog entry) is a compile error, not a silently dead button.
  // Consumer items bypass this map entirely via their own `run` closure.
  const actions: Record<NavActionId, () => void> = {
    buildPipeline: () => ui.openBuilder(),
    addFromRepo: () => ui.openAddService(),
    bootstrapRepo: () => ui.openBootstrap(),
    integrationsHub: () => ui.openIntegrations(),
    sandbox: () => ui.openSandbox(),
    kaizen: () => ui.openKaizen(),
    infrastructure: () => ui.openInfrastructure(),
    environmentSetup: () => ui.openEnvironmentSetup(),
    fragmentLibrary: () => ui.openFragmentLibrary(),
    mergeThresholds: () => ui.openWorkspaceSettings('merge'),
    workspaceSettings: () => ui.openWorkspaceSettings(),
    modelConfiguration: () => ui.openModelConfig(),
    serviceFragmentDefaults: () => ui.openWorkspaceSettings('fragments'),
    localModels: () => ui.openLocalModels(),
    accountSettings: () => ui.openAccountSettings(),
    operatorDashboard: () => ui.openOperatorDashboard(),
    shortcuts: () => ui.openShortcutsHelp(),
  }

  /** Run a contribution's action (consumer `run` closure wins over the id map). */
  function invoke(item: NavContribution): void {
    if (item.run) {
      item.run()
      return
    }
    // First-party `action` is a `NavActionId`, so the exhaustive map always has a
    // handler; the optional call only guards a consumer item that mis-uses
    // `action` (its contract is `run`) — it no-ops rather than throwing.
    if (item.action) actions[item.action]?.()
  }

  const all = computed<NavContribution[]>(() => slots.value.nav ?? [])

  /** Grouped + ordered sidebar sections, empty sections dropped. */
  const sidebarGroups = computed<SidebarGroup[]>(() => groupSidebar(all.value))

  /** Grouped + ordered command-palette entries, empty groups dropped. */
  const commandGroups = computed<CommandGroup[]>(() => groupCommands(all.value))

  /** Toolbar contributions (the consumer extension point on `BoardToolbar`). */
  const toolbarItems = computed<NavContribution[]>(() => sortToolbar(all.value))

  return { sidebarGroups, commandGroups, toolbarItems, invoke }
}
