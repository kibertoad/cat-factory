import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import type {
  AppSlots,
  NavCommandGroup,
  NavContribution,
  NavSidebarGroup,
} from '~/modular/nav-contributions'

/**
 * The single source the three nav shells render from (slice 1 of the modular-vue
 * adoption). Reads the reactively-gated `nav` slot via `useReactiveSlots` — the
 * `slotFilter` has already dropped items the caller lacks permission for, and
 * the computed re-runs when a gate flips — then shapes the surviving items per
 * surface and resolves each item's action.
 *
 * First-party items carry an `action` id resolved here against the `ui` store; a
 * consumer-contributed item may instead carry its own `run` closure, which wins.
 */

/** Sidebar sections, in render order; each header is `nav.<group>`. */
const SIDEBAR_GROUP_ORDER: readonly NavSidebarGroup[] = [
  'create',
  'repositories',
  'integrations',
  'infrastructure',
  'workspaceContext',
  'configuration',
]

/** Command-palette groups, in render order; each label is `layout.commandBar.groups.<group>`. */
const COMMAND_GROUP_ORDER: readonly NavCommandGroup[] = [
  'create',
  'repositories',
  'integrations',
  'workspace',
  'account',
]

export interface SidebarGroup {
  group: NavSidebarGroup
  /** i18n key for the section header. */
  labelKey: string
  items: NavContribution[]
}

export interface CommandItem {
  item: NavContribution
  /** Resolved palette label i18n key. */
  labelKey: string
  /** Resolved palette keywords i18n key, if any. */
  keywordsKey?: string
}

export interface CommandGroup {
  group: NavCommandGroup
  /** i18n key for the group label. */
  labelKey: string
  items: CommandItem[]
}

export function useNavContributions() {
  const slots = useReactiveSlots<AppSlots>()
  const ui = useUiStore()

  // First-party action ids → host handlers. Consumer items bypass this via `run`.
  const actions: Record<string, () => void> = {
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
    if (item.action) actions[item.action]?.()
  }

  const all = computed<NavContribution[]>(() => slots.value.nav ?? [])

  /** Grouped + ordered sidebar sections, empty sections dropped. */
  const sidebarGroups = computed<SidebarGroup[]>(() =>
    SIDEBAR_GROUP_ORDER.map((group) => ({
      group,
      labelKey: `nav.${group}`,
      items: all.value
        .filter((i) => i.surfaces.includes('sidebar') && i.sidebar?.group === group)
        .sort((a, b) => (a.sidebar?.order ?? 0) - (b.sidebar?.order ?? 0)),
    })).filter((g) => g.items.length > 0),
  )

  /** Grouped + ordered command-palette entries, empty groups dropped. */
  const commandGroups = computed<CommandGroup[]>(() =>
    COMMAND_GROUP_ORDER.map((group) => ({
      group,
      labelKey: `layout.commandBar.groups.${group}`,
      items: all.value
        .filter((i) => i.surfaces.includes('command') && i.command?.group === group)
        .sort((a, b) => (a.command?.order ?? 0) - (b.command?.order ?? 0))
        .map<CommandItem>((item) => ({
          item,
          labelKey: item.command?.labelKey ?? item.labelKey,
          keywordsKey: item.command?.keywordsKey,
        })),
    })).filter((g) => g.items.length > 0),
  )

  /** Toolbar contributions (the consumer extension point on `BoardToolbar`). */
  const toolbarItems = computed<NavContribution[]>(() =>
    all.value
      .filter((i) => i.surfaces.includes('toolbar'))
      .sort((a, b) => (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0)),
  )

  return { sidebarGroups, commandGroups, toolbarItems, invoke }
}
