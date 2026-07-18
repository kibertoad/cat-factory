import { defineModule } from '@modular-vue/core'
import type { AppSlots } from './slots'

// Re-exported for the slice-1 importers that reach `AppSlots` through this
// module (`useNavContributions`, `registry`, the nav specs); its canonical home
// is now `./slots`, where all slot keys are aggregated (slice 2 added
// `resultViews` / `agentKinds`).
export type { AppSlots } from './slots'

/**
 * The single nav/command catalog for the layer (slice 1 of the modular-vue
 * adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * Every destination is declared ONCE here as data and rendered three ways —
 * `SideBar`, `CommandBar`, `BoardToolbar` — instead of each shell hand-rolling
 * its own item list + RBAC gating (the pre-slice-1 triple-maintenance). RBAC /
 * availability gating is a reactive `slotFilter` ({@link navSlotFilter}) over a
 * reactive `gates` service (see `nav-gates.ts`), read through `useReactiveSlots`
 * so an item shows/hides the instant a permission or connection flips — no
 * `recalculateSlots()` call. A consumer deployment contributes its own items to
 * the same `nav` slot via `registerAppModule`, so they light up in all three
 * shells with zero shell edits.
 */

/** Which shell(s) render a contribution. */
export type NavSurface = 'sidebar' | 'command' | 'toolbar'

/** Sidebar section a contribution lands in (its i18n header is `nav.<group>`). */
export type NavSidebarGroup =
  | 'create'
  | 'repositories'
  | 'integrations'
  | 'infrastructure'
  | 'workspaceContext'
  | 'configuration'

/** Command-palette group (its i18n label is `layout.commandBar.groups.<group>`). */
export type NavCommandGroup = 'create' | 'repositories' | 'integrations' | 'workspace' | 'account'

/**
 * The reactive gate inputs a contribution's `gate` predicate reads. Backed by a
 * plain service object whose getters read the host's reactive RBAC/availability
 * state (see `createNavGates`), so reading them inside the `useReactiveSlots`
 * computed tracks them.
 */
export interface NavGates {
  /** `board.write` — create pipelines, add repos. */
  canWriteBoard: boolean
  /** `integrations.manage` — bootstrap, connection/infra management, sandbox. */
  canManageIntegrations: boolean
  /** `settings.manage` — workspace/model config, fragment library. */
  canManageSettings: boolean
  /** The GitHub (source-control) integration is enabled on the backend. */
  githubAvailable: boolean
  /** The prompt-fragment library integration is enabled. */
  libraryAvailable: boolean
  /** An execution/test-env backend is reported (runner pool / environment / local). */
  infrastructureAvailable: boolean
  /** Accounts (auth) are enabled on the deployment. */
  accountsEnabled: boolean
  /** The caller is an admin of the active account. */
  isAccountAdmin: boolean
}

/** Command-palette placement + copy for a contribution that appears in the palette. */
export interface NavCommandSpec {
  group: NavCommandGroup
  order: number
  /** Palette label key; falls back to the contribution's `labelKey`. */
  labelKey?: string
  /** Extra fuzzy-match keywords (i18n key). */
  keywordsKey?: string
}

/**
 * The first-party action ids, each resolved to a host `ui`-store handler in
 * `useNavContributions`. Typing {@link NavContribution.action} against this union
 * (and the handler map as an exhaustive `Record<NavActionId, …>`) makes a drift
 * between the catalog and the handler map a compile error instead of a silently
 * dead button. Consumer modules don't use these — they carry their own `run`.
 */
export const NAV_ACTIONS = [
  'buildPipeline',
  'addFromRepo',
  'bootstrapRepo',
  'integrationsHub',
  'sandbox',
  'kaizen',
  'infrastructure',
  'environmentSetup',
  'fragmentLibrary',
  'mergeThresholds',
  'workspaceSettings',
  'modelConfiguration',
  'serviceFragmentDefaults',
  'localModels',
  'accountSettings',
  'operatorDashboard',
  'shortcuts',
] as const

export type NavActionId = (typeof NAV_ACTIONS)[number]

/** One destination, declared once and rendered per surface. */
export interface NavContribution {
  id: string
  /** Default (sidebar) label i18n key. */
  labelKey: string
  icon: string
  surfaces: readonly NavSurface[]
  /** Reactive predicate over {@link NavGates}; absent = always visible. */
  gate?: (g: NavGates) => boolean
  /**
   * First-party action id, resolved to a `run()` against the host `ui` store by
   * `useNavContributions`. A consumer module that has its own stores instead
   * supplies {@link run} directly.
   */
  action?: NavActionId
  /** Direct handler (consumer modules); takes precedence over {@link action}. */
  run?: () => void
  /** Stable selector for e2e / existing specs. */
  testId?: string
  /** Sidebar placement (present when `surfaces` includes `'sidebar'`). */
  sidebar?: { group: NavSidebarGroup; order: number }
  /** Command-palette placement (present when `surfaces` includes `'command'`). */
  command?: NavCommandSpec
  /** Toolbar placement (present when `surfaces` includes `'toolbar'`). */
  toolbar?: { order: number }
}

const S = (...s: NavSurface[]) => s as readonly NavSurface[]

/**
 * The first-party catalog. Mapped 1:1 from the pre-slice-1 `SideBar` + `CommandBar`
 * gating. Two deliberate consistency unifications noted in the tracker:
 *  - `account-settings` gates on `accountsEnabled` in BOTH shells (the palette
 *    previously showed it unconditionally; the account modal only makes sense
 *    with accounts enabled).
 *  - one icon per destination across shells.
 */
export const NAV_CONTRIBUTIONS: readonly NavContribution[] = [
  {
    id: 'build-pipeline',
    labelKey: 'nav.buildPipeline',
    icon: 'i-lucide-workflow',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.canWriteBoard,
    action: 'buildPipeline',
    testId: 'nav-build-pipeline',
    sidebar: { group: 'create', order: 10 },
    command: {
      group: 'create',
      order: 10,
      labelKey: 'layout.commandBar.cmd.newPipeline',
      keywordsKey: 'layout.commandBar.keywords.newPipeline',
    },
  },
  {
    id: 'add-from-repo',
    labelKey: 'nav.addFromRepo',
    icon: 'i-lucide-folder-git-2',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.githubAvailable && g.canWriteBoard,
    action: 'addFromRepo',
    testId: 'nav-add-from-repo',
    sidebar: { group: 'repositories', order: 10 },
    command: {
      group: 'repositories',
      order: 10,
      labelKey: 'layout.commandBar.cmd.addFromRepo',
      keywordsKey: 'layout.commandBar.keywords.addFromRepo',
    },
  },
  {
    id: 'bootstrap-repo',
    labelKey: 'nav.bootstrapRepo',
    icon: 'i-lucide-git-branch-plus',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.canManageIntegrations,
    action: 'bootstrapRepo',
    testId: 'nav-bootstrap-repo',
    sidebar: { group: 'repositories', order: 20 },
    command: {
      group: 'repositories',
      order: 20,
      labelKey: 'layout.commandBar.cmd.bootstrapRepo',
      keywordsKey: 'layout.commandBar.keywords.bootstrapRepo',
    },
  },
  {
    id: 'integrations-hub',
    labelKey: 'nav.integrations',
    icon: 'i-lucide-blocks',
    surfaces: S('sidebar'),
    gate: (g) => g.canManageIntegrations,
    action: 'integrationsHub',
    testId: 'nav-integrations',
    sidebar: { group: 'integrations', order: 10 },
  },
  {
    id: 'sandbox',
    labelKey: 'nav.sandbox',
    icon: 'i-lucide-flask-conical',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.canManageIntegrations,
    action: 'sandbox',
    testId: 'nav-sandbox',
    sidebar: { group: 'integrations', order: 20 },
    command: {
      group: 'workspace',
      order: 70,
      labelKey: 'layout.commandBar.cmd.sandbox',
      keywordsKey: 'layout.commandBar.keywords.sandbox',
    },
  },
  {
    id: 'kaizen',
    labelKey: 'nav.kaizen',
    icon: 'i-lucide-sparkles',
    surfaces: S('sidebar'),
    action: 'kaizen',
    testId: 'nav-kaizen',
    sidebar: { group: 'integrations', order: 30 },
  },
  {
    id: 'infrastructure',
    labelKey: 'nav.infrastructure',
    icon: 'i-lucide-server-cog',
    surfaces: S('sidebar'),
    gate: (g) => g.infrastructureAvailable,
    action: 'infrastructure',
    testId: 'nav-infrastructure',
    sidebar: { group: 'infrastructure', order: 10 },
  },
  {
    id: 'environment-setup',
    labelKey: 'nav.environmentSetup',
    icon: 'i-lucide-flask-conical',
    surfaces: S('sidebar'),
    gate: (g) => g.infrastructureAvailable,
    action: 'environmentSetup',
    testId: 'nav-environment-setup',
    sidebar: { group: 'infrastructure', order: 20 },
  },
  {
    id: 'fragments',
    labelKey: 'nav.contextFragments',
    icon: 'i-lucide-book-marked',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.libraryAvailable && g.canManageSettings,
    action: 'fragmentLibrary',
    testId: 'nav-fragments',
    sidebar: { group: 'workspaceContext', order: 10 },
    command: {
      group: 'workspace',
      order: 10,
      labelKey: 'layout.commandBar.cmd.fragments',
      keywordsKey: 'layout.commandBar.keywords.fragments',
    },
  },
  {
    id: 'merge-thresholds',
    labelKey: 'layout.commandBar.cmd.mergeThresholds',
    icon: 'i-lucide-git-merge',
    surfaces: S('command'),
    gate: (g) => g.canManageSettings,
    action: 'mergeThresholds',
    command: {
      group: 'workspace',
      order: 20,
      keywordsKey: 'layout.commandBar.keywords.mergeThresholds',
    },
  },
  {
    id: 'workspace-settings',
    labelKey: 'nav.workspaceSettings',
    icon: 'i-lucide-sliders-horizontal',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.canManageSettings,
    action: 'workspaceSettings',
    testId: 'nav-workspace-settings',
    sidebar: { group: 'configuration', order: 10 },
    command: {
      group: 'workspace',
      order: 30,
      labelKey: 'layout.commandBar.cmd.workspaceSettings',
      keywordsKey: 'layout.commandBar.keywords.workspaceSettings',
    },
  },
  {
    id: 'model-config',
    labelKey: 'nav.modelConfiguration',
    icon: 'i-lucide-cpu',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.canManageSettings,
    action: 'modelConfiguration',
    testId: 'nav-model-config',
    sidebar: { group: 'configuration', order: 20 },
    command: {
      group: 'workspace',
      order: 40,
      labelKey: 'layout.commandBar.cmd.modelConfiguration',
      keywordsKey: 'layout.commandBar.keywords.modelConfiguration',
    },
  },
  {
    id: 'service-fragment-defaults',
    labelKey: 'layout.commandBar.cmd.serviceFragmentDefaults',
    icon: 'i-lucide-book-open-check',
    surfaces: S('command'),
    gate: (g) => g.canManageSettings,
    action: 'serviceFragmentDefaults',
    command: {
      group: 'workspace',
      order: 50,
      keywordsKey: 'layout.commandBar.keywords.serviceFragmentDefaults',
    },
  },
  {
    id: 'local-models',
    labelKey: 'layout.commandBar.cmd.localModels',
    icon: 'i-lucide-server',
    surfaces: S('command'),
    action: 'localModels',
    command: {
      group: 'workspace',
      order: 60,
      keywordsKey: 'layout.commandBar.keywords.localModels',
    },
  },
  {
    id: 'account-settings',
    labelKey: 'nav.accountSettings',
    icon: 'i-lucide-users',
    surfaces: S('sidebar', 'command'),
    gate: (g) => g.accountsEnabled,
    action: 'accountSettings',
    testId: 'nav-account-settings',
    sidebar: { group: 'configuration', order: 30 },
    command: {
      group: 'account',
      order: 10,
      labelKey: 'layout.commandBar.cmd.accountSettings',
      keywordsKey: 'layout.commandBar.keywords.accountSettings',
    },
  },
  {
    id: 'operator-dashboard',
    labelKey: 'nav.operatorDashboard',
    icon: 'i-lucide-gauge',
    surfaces: S('sidebar'),
    gate: (g) => g.accountsEnabled && g.isAccountAdmin,
    action: 'operatorDashboard',
    testId: 'nav-operator-dashboard',
    sidebar: { group: 'configuration', order: 40 },
  },
  {
    id: 'keyboard-shortcuts',
    labelKey: 'layout.commandBar.cmd.shortcuts',
    icon: 'i-lucide-keyboard',
    surfaces: S('command'),
    action: 'shortcuts',
    command: {
      group: 'workspace',
      order: 80,
      keywordsKey: 'layout.commandBar.keywords.shortcuts',
    },
  },
]

/**
 * The first-party navigation module: contributes the whole catalog to the `nav`
 * slot. Registered by `createAppRegistry`.
 */
export const navigationModule = defineModule({
  id: 'cat-factory:navigation',
  version: '1.0.0',
  slots: { nav: [...NAV_CONTRIBUTIONS] },
})

/**
 * Reactive RBAC/availability filter over the merged `nav` slot. Reads
 * `deps.gates.*` (the reactive gate service) per item, so evaluated inside
 * `useReactiveSlots` it re-runs when a permission or connection flips. Passed to
 * `installModularApp` as the global `slotFilter`.
 *
 * Typed against `AppSlots` (not the generic `SlotFilter`) so it matches the
 * filter shape the runtime infers for this registry. `deps` is widened to an
 * optional `gates` to avoid importing `AppDeps` (which would be circular).
 */
export function navSlotFilter(slots: AppSlots, deps: { gates?: NavGates }): AppSlots {
  const gates = deps.gates
  const nav = slots.nav ?? []
  return {
    ...slots,
    // No gates service wired (tests / bare install) ⇒ show everything, matching
    // the dev-open "absent access allows all" backend parity.
    nav: gates ? nav.filter((i) => (i.gate ? i.gate(gates) : true)) : nav,
  }
}

/** Sidebar sections, in render order; each header is `nav.<group>`. */
export const SIDEBAR_GROUP_ORDER: readonly NavSidebarGroup[] = [
  'create',
  'repositories',
  'integrations',
  'infrastructure',
  'workspaceContext',
  'configuration',
]

/** Command-palette groups, in render order; each label is `layout.commandBar.groups.<group>`. */
export const COMMAND_GROUP_ORDER: readonly NavCommandGroup[] = [
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

/**
 * Pure grouping/ordering helpers over an already-gated item list. Kept here (not
 * in the composable) so they're unit-testable without a Vue/Nuxt runtime — the
 * composable just feeds them the reactive `nav` slot. Each returns groups in
 * canonical order with empty groups dropped and items sorted by their per-surface
 * `order`.
 */
export function groupSidebar(items: readonly NavContribution[]): SidebarGroup[] {
  return SIDEBAR_GROUP_ORDER.map((group) => ({
    group,
    labelKey: `nav.${group}`,
    items: items
      .filter((i) => i.surfaces.includes('sidebar') && i.sidebar?.group === group)
      .sort((a, b) => (a.sidebar?.order ?? 0) - (b.sidebar?.order ?? 0)),
  })).filter((g) => g.items.length > 0)
}

export function groupCommands(items: readonly NavContribution[]): CommandGroup[] {
  return COMMAND_GROUP_ORDER.map((group) => ({
    group,
    labelKey: `layout.commandBar.groups.${group}`,
    items: items
      .filter((i) => i.surfaces.includes('command') && i.command?.group === group)
      .sort((a, b) => (a.command?.order ?? 0) - (b.command?.order ?? 0))
      .map<CommandItem>((item) => ({
        item,
        labelKey: item.command?.labelKey ?? item.labelKey,
        keywordsKey: item.command?.keywordsKey,
      })),
  })).filter((g) => g.items.length > 0)
}

export function sortToolbar(items: readonly NavContribution[]): NavContribution[] {
  return items
    .filter((i) => i.surfaces.includes('toolbar'))
    .sort((a, b) => (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0))
}
