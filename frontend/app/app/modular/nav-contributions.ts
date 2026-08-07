import { defineModule } from '@modular-vue/core'
import { filterExternalTools } from './external-tools'
import type { AppSlots } from './slots'

// Re-exported for the slice-1 importers that reach `AppSlots` through this
// module (`useNavContributions`, `registry`, the nav specs); its canonical home
// is now `./slots`, where all slot keys are aggregated (slice 2 added
// `resultViews` / `agentKinds`).
export type { AppSlots } from './slots'

/**
 * The single nav/command catalog for the layer (slice 1 of the modular-vue
 * adoption — backend/docs/adr/0049-modular-vue-adoption.md).
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

/**
 * Sidebar section a contribution lands in (its i18n header is `nav.<group>`).
 *
 * `models` and `integrations` are deliberately SEPARATE sections even though a model
 * provider is technically also an external system we connect to. They answer different
 * questions: `models` is the MODEL LAYER — which engine the harnesses run on (no provider
 * ⇒ nothing runs at all), which model each agent kind uses, and how well a given
 * prompt+agent+model actually performs (`sandbox`, `kaizen`); `integrations` is the
 * optional EXTERNAL SYSTEMS that feed a run context or receive its output (source control,
 * trackers, documents, chat, observability) — each of which a deployment can live without.
 * Folding the providers in among them buried the one connection every deployment must make
 * in a list of ones most never touch; parking the two model-quality surfaces there was the
 * same mistake from the other end — neither Sandbox nor Kaizen connects to anything, they
 * evaluate what the `models` section configures.
 *
 * `externalTools` is the one section with NO first-party items: it holds the deployment's own
 * applications (the `externalTools` slot, projected here by `useNavContributions`), and is
 * dropped entirely where none are registered. It is separate from `integrations` for the same
 * reason `models` is — an integration is a system cat-factory READS FROM or WRITES TO on your
 * behalf, while these are places a person GOES.
 *
 * `help` is the tail section: surfaces that teach the product rather than configure it. It is
 * separate from `configuration` because nothing in it changes what a run does — and it is a
 * SIDEBAR section rather than a palette-only entry because the people it serves are the ones
 * least likely to know the palette exists.
 */
export type NavSidebarGroup =
  | 'create'
  | 'repositories'
  | 'models'
  | 'integrations'
  | 'infrastructure'
  | 'workspaceContext'
  | 'externalTools'
  | 'configuration'
  | 'help'

/** Command-palette group (its i18n label is `layout.commandBar.groups.<group>`). */
export type NavCommandGroup =
  | 'create'
  | 'repositories'
  | 'integrations'
  | 'externalTools'
  | 'workspace'
  | 'account'

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
  /**
   * The interface tier is `advanced` (see `stores/uiMode.ts`). Read by
   * {@link navSlotFilter} for every {@link NavContribution.advanced} item, and
   * available to a `gate` predicate that needs to combine it with something else.
   */
  advancedMode: boolean
  /**
   * The open board has at least one service frame. Availability, not permission: a
   * surface that operates ON a service (today the task-creation tutorial tour) has
   * nothing to point at until one exists, and offering it anyway means a walkthrough
   * that hunts for absent controls. Reactive like the rest, so it flips the moment a
   * service lands on the board.
   */
  boardHasService: boolean
  /**
   * The open board has at least one task block. The service frame that {@link boardHasService}
   * reports is where a task GOES; this is whether one is actually there to run, which is what
   * a tour about the run controls needs — they live in the inspector of a task, and a board of
   * empty frames offers nothing to open.
   */
  boardHasTask: boolean
  /**
   * Some run on a TASK block is cached for this board, in any state. Availability for the
   * steps that explain a run's ANATOMY (the step list, its live progress), which have nothing
   * to anchor to until a run has been started at least once.
   *
   * Task-scoped, like the three below: every surface these gates open is reached through a
   * task card and its inspector, and a frame-level run (a blueprint pass, an initiative plan)
   * renders none of them.
   */
  boardHasRun: boolean
  /**
   * Some task card is offering a human an unanswered DECISION to resolve.
   *
   * "Offering" rather than "exists": these two report what the board actually RENDERS, which
   * is what a tour anchoring on the card's action can point at — see `hasActionablePark` for
   * the two ways a park can exist with no control to show for it.
   */
  boardHasOpenDecision: boolean
  /** Some task card is offering a human an unanswered APPROVAL gate. See above. */
  boardHasPendingApproval: boolean
  /**
   * Some run on a task block has finished successfully. Availability for the review/merge
   * tour: its subject is the OUTPUT of a run, so there has to be one that produced output. A
   * FAILED run deliberately does not count — the failure banner is its own surface, and a
   * tour about reading a result and merging it would spend its steps pointing at controls a
   * failed run never renders.
   */
  boardHasFinishedRun: boolean
  /**
   * Some run on a task block has FAILED, so the card is rendering the failure banner.
   *
   * The other half of {@link boardHasFinishedRun}, and the reason it is a separate gate rather
   * than a looser "a run settled": the two states render disjoint surfaces (a result view and
   * a merge control; a failure banner and a retry), so one tour cannot cover both. It is also
   * the state a new user is MOST likely to be in and the one the catalog had nothing for: with
   * only the success gate, a board where every run failed reports the delivery loop as
   * permanently half-finished and explains none of it.
   */
  boardHasFailedRun: boolean
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
  'modelProviders',
  'sandbox',
  'kaizen',
  'infrastructure',
  'fragmentLibrary',
  'foundationalServices',
  'mergeThresholds',
  'workspaceSettings',
  'modelConfiguration',
  'serviceFragmentDefaults',
  'localModels',
  'accountSettings',
  'operatorDashboard',
  'reports',
  'shortcuts',
  'tutorial',
  'toggleUiMode',
] as const

export type NavActionId = (typeof NAV_ACTIONS)[number]

/** One destination, declared once and rendered per surface. */
export interface NavContribution {
  id: string
  /** Default (sidebar) label i18n key. */
  labelKey: string
  /**
   * Literal label, winning over {@link labelKey} when present. For a contribution whose copy is
   * DATA rather than catalog text — an external tool's registered title, the same class as a
   * custom agent kind's `presentation.label`. A first-party destination always uses `labelKey`.
   */
  label?: string
  /** Literal one-line description, rendered as the item's tooltip. Data, like {@link label}. */
  description?: string
  icon: string
  surfaces: readonly NavSurface[]
  /** Reactive predicate over {@link NavGates}; absent = always visible. */
  gate?: (g: NavGates) => boolean
  /**
   * A power-user destination: shown only in ADVANCED interface mode (basic mode is the
   * everyday surface — see `stores/uiMode.ts`). Declarative rather than folded into
   * {@link gate}, so an item keeps its RBAC/availability predicate unchanged and the two
   * axes stay independently assertable. Absent = visible in both tiers.
   */
  advanced?: boolean
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
 *
 * `advanced: true` marks the power-user half, hidden in basic interface mode. Basic is the
 * EVERYDAY DELIVERY SURFACE — plan work on a board, run it, review and merge it — so an item
 * is advanced when it is not part of that loop. That happens two ways, and the difference
 * matters when reading the list (it is the column `nav-contributions.spec.ts` makes you fill
 * in):
 *
 * REACHED ANOTHER WAY — hiding a shortcut removes nothing, because a basic destination opens
 * the same surface:
 *  - `merge-thresholds` / `service-fragment-defaults` — palette shortcuts into Workspace
 *    settings tabs (Merge, Service best practices), which basic mode reaches via
 *    `workspace-settings`.
 *  - `local-models` — a per-user endpoint knob the Model providers hub already offers.
 *
 * OUT OF THE TIER — the sole route, hidden deliberately, so the capability itself is absent
 * from basic mode. This is a product decision, not an oversight: each of these answers a
 * question an everyday delivery user does not ask, and carrying it costs the basic nav more
 * than the capability is worth there. Switching to advanced is the way to it.
 *  - `sandbox` / `kaizen` — experimentation and self-grading surfaces, beside the delivery
 *    path rather than on it.
 *  - `bootstrap-repo` — standing a NEW repository up from a reference architecture: a
 *    once-per-service setup act, not part of running work on an existing board.
 *  - `operator-dashboard` / `reports` — the deployment-wide health and spend rollups. They
 *    read across every workspace for whoever operates the deployment, which is a different
 *    job from delivering a task on one board.
 *
 * Everything else stays in basic because the delivery loop needs it: authoring a flow
 * (`build-pipeline`), adding a repo (`add-from-repo`), the standards/skills library
 * (`fragments`), the ephemeral-env + runner plumbing (`infrastructure`, which is also the only route
 * to the guided per-service Compose environment setup), and the workspace/model configuration
 * a run actually reads (`workspace-settings`, `model-config`).
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
    advanced: true,
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
    // The engines. Kept out of `integrations-hub` on purpose (see NavSidebarGroup): a
    // deployment with no provider connected cannot run anything, so this is the one
    // connection that must not sit in a list of optional ones.
    id: 'model-providers',
    labelKey: 'nav.modelProviders',
    icon: 'i-lucide-plug-zap',
    surfaces: S('sidebar'),
    gate: (g) => g.canManageIntegrations,
    action: 'modelProviders',
    testId: 'nav-model-providers',
    sidebar: { group: 'models', order: 10 },
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
    // Registering the shared capabilities the ORGANISATION already runs, so a design consumes
    // them instead of proposing a rebuild. Advanced: the everyday delivery loop (plan a task,
    // run it, review and merge it) never touches this — it is org-wide platform configuration,
    // set up once by whoever knows the estate, and a board can deliver its whole backlog with an
    // empty catalog. Beside the fragment library in `workspaceContext`, because both answer
    // "what standing context does an agent get?".
    id: 'foundational-services',
    labelKey: 'nav.foundationalServices',
    icon: 'i-lucide-boxes',
    surfaces: S('sidebar', 'command'),
    advanced: true,
    gate: (g) => g.canManageSettings,
    action: 'foundationalServices',
    testId: 'nav-foundational-services',
    sidebar: { group: 'workspaceContext', order: 20 },
    command: {
      // Appended after the pre-existing workspace commands rather than interleaved beside the
      // fragment library, so the palette order people already know is unchanged.
      group: 'workspace',
      order: 110,
      labelKey: 'layout.commandBar.cmd.foundationalServices',
      keywordsKey: 'layout.commandBar.keywords.foundationalServices',
    },
  },
  {
    id: 'merge-thresholds',
    labelKey: 'layout.commandBar.cmd.mergeThresholds',
    icon: 'i-lucide-git-merge',
    surfaces: S('command'),
    advanced: true,
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
    // Beside `model-providers`, not in `configuration`: "which key do we hold" and "which
    // model does each agent kind use" are two halves of one question, and splitting them
    // across sections is what sent people to Integrations looking for a model.
    sidebar: { group: 'models', order: 20 },
    command: {
      group: 'workspace',
      order: 40,
      labelKey: 'layout.commandBar.cmd.modelConfiguration',
      keywordsKey: 'layout.commandBar.keywords.modelConfiguration',
    },
  },
  {
    // Trying prompt versions and models against graded fixtures — a model-layer surface,
    // not an integration: it connects to no external system, it exercises the providers
    // and per-agent models the two entries above configure.
    id: 'sandbox',
    labelKey: 'nav.sandbox',
    icon: 'i-lucide-flask-conical',
    surfaces: S('sidebar', 'command'),
    advanced: true,
    gate: (g) => g.canManageIntegrations,
    action: 'sandbox',
    testId: 'nav-sandbox',
    sidebar: { group: 'models', order: 30 },
    command: {
      group: 'workspace',
      order: 70,
      labelKey: 'layout.commandBar.cmd.sandbox',
      keywordsKey: 'layout.commandBar.keywords.sandbox',
    },
  },
  {
    // The same axis after the fact: grading history and verified prompt+agent+model combos.
    // Sandbox asks "which combination should we use", Kaizen answers "how is the one we
    // shipped doing" — both read the model layer, so they sit with it.
    id: 'kaizen',
    labelKey: 'nav.kaizen',
    icon: 'i-lucide-sparkles',
    surfaces: S('sidebar'),
    advanced: true,
    action: 'kaizen',
    testId: 'nav-kaizen',
    sidebar: { group: 'models', order: 40 },
  },
  {
    id: 'service-fragment-defaults',
    labelKey: 'layout.commandBar.cmd.serviceFragmentDefaults',
    icon: 'i-lucide-book-open-check',
    surfaces: S('command'),
    advanced: true,
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
    advanced: true,
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
    advanced: true,
    gate: (g) => g.accountsEnabled && g.isAccountAdmin,
    action: 'operatorDashboard',
    testId: 'nav-operator-dashboard',
    sidebar: { group: 'configuration', order: 40 },
  },
  {
    id: 'reports',
    labelKey: 'nav.reports',
    icon: 'i-lucide-chart-column',
    surfaces: S('sidebar'),
    advanced: true,
    gate: (g) => g.accountsEnabled && g.isAccountAdmin,
    action: 'reports',
    testId: 'nav-reports',
    sidebar: { group: 'configuration', order: 45 },
  },
  {
    // Deliberately NOT `advanced`: the tutorials exist for exactly the users basic mode
    // serves. It is on the SIDEBAR as well as in the palette because the launch prompt is
    // shown once and answered once — after that, a palette entry was the only route back to
    // the walkthroughs, which asks the user least likely to have found the palette to find
    // it. Ungated: every tour answers for itself (an unavailable one is listed with what
    // would unlock it), so the catalogue is worth reaching even when little of it can run.
    id: 'tutorial',
    labelKey: 'nav.tutorials',
    icon: 'i-lucide-graduation-cap',
    surfaces: S('sidebar', 'command'),
    action: 'tutorial',
    testId: 'nav-tutorial',
    sidebar: { group: 'help', order: 10 },
    command: {
      // After the pre-slice-1 tail (the workspace group pins that order): genuinely new
      // entries append rather than interleave.
      group: 'workspace',
      order: 100,
      // No `labelKey` override: the palette shows "Tutorials" too, so an override would be a
      // second key holding the same word in ten locales — two places to keep in step and one
      // of them free to drift. `layout.commandBar.cmd.tutorial` was deleted with it.
      keywordsKey: 'layout.commandBar.keywords.tutorial',
    },
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
  {
    // Deliberately NOT `advanced`: this is the way BACK. Basic mode is the shipped default, so
    // for most users the sidebar switcher is their first sight of the tier — and in the basic
    // rail it collapses to a single toggle, which is a thin thread to hang the entire advanced
    // half of the product on. The palette is reachable in both tiers, searchable by name, and
    // is already "the primary way to reach every action", so the tier belongs in it.
    id: 'ui-mode',
    labelKey: 'layout.commandBar.cmd.toggleUiMode',
    icon: 'i-lucide-toggle-right',
    surfaces: S('command'),
    action: 'toggleUiMode',
    command: {
      group: 'workspace',
      order: 90,
      keywordsKey: 'layout.commandBar.keywords.toggleUiMode',
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
 * Does a shell render this contribution under `gates`?
 *
 * The two axes a destination is gated on, in ONE place. They are independent and BOTH must
 * pass: an `advanced` item is dropped in basic mode, and every item still answers to its own
 * `gate`. Order doesn't matter (it's a conjunction) but the tier is checked first, since it's
 * the cheaper read.
 *
 * Named rather than inlined in {@link navSlotFilter} because a second reader has to agree with
 * it exactly: a tutorial tour whose step CLICKS a nav entry declares the requirement that
 * renders it, and `tutorial-tours.spec.ts` pairs the two through this function. Spelling the
 * conjunction out there instead would be a copy that keeps passing while this one changes —
 * and the drift it would miss (an entry gaining a gate clause, or being marked `advanced` and
 * so leaving the DEFAULT interface tier) is precisely a tour offered to a user who then finds
 * no such control.
 */
export function navItemVisible(item: NavContribution, gates: NavGates): boolean {
  return (item.advanced ? gates.advancedMode : true) && (item.gate ? item.gate(gates) : true)
}

/**
 * Reactive RBAC/availability/interface-tier filter over the merged `nav` slot. Reads
 * `deps.gates.*` (the reactive gate service) per item, so evaluated inside
 * `useReactiveSlots` it re-runs when a permission, connection, or the interface
 * mode flips. Passed to `installModularApp` as the global `slotFilter`.
 *
 * Typed against `AppSlots` (not the generic `SlotFilter`) so it matches the
 * filter shape the runtime infers for this registry. `deps` is widened to an
 * optional `gates` to avoid importing `AppDeps` (which would be circular).
 */
export function navSlotFilter(slots: AppSlots, deps: { gates?: NavGates }): AppSlots {
  const gates = deps.gates
  const nav = slots.nav ?? []
  const externalTools = slots.externalTools ?? []
  return {
    ...slots,
    // No gates service wired (tests / bare install) ⇒ show everything, matching
    // the dev-open "absent access allows all" backend parity.
    nav: gates ? nav.filter((i) => navItemVisible(i, gates)) : nav,
    // `tutorialTours` is deliberately NOT filtered here, unlike every other gated slot. A
    // `SlotFilter` can only DROP, and the tutorial catalogue's whole job is to explain what
    // was dropped — which tour this board can't run yet, and what would unlock it. That is a
    // richer value than a thinned list, so tour resolution lives in `resolveTourCatalogue`
    // (pure, gates-nullable) and runs once in `useTutorialTours`, whose `tours` is the same
    // gated set the launch prompt and the overlay always saw.
    // External tools gate on the same two axes as `nav` — they become nav items downstream
    // (`useNavContributions` projects them), so gating them anywhere else would let a tool the
    // caller can't use reach the palette while its sidebar twin was correctly hidden.
    externalTools: filterExternalTools(externalTools, gates),
  }
}

/** Sidebar sections, in render order; each header is `nav.<group>`. */
export const SIDEBAR_GROUP_ORDER: readonly NavSidebarGroup[] = [
  'create',
  'repositories',
  'models',
  'integrations',
  'infrastructure',
  'workspaceContext',
  // The deployment's own applications, below what cat-factory itself offers and above the
  // configuration tail: they are destinations someone reaches mid-work, not settings.
  'externalTools',
  'configuration',
  'help',
]

/** Command-palette groups, in render order; each label is `layout.commandBar.groups.<group>`. */
export const COMMAND_GROUP_ORDER: readonly NavCommandGroup[] = [
  'create',
  'repositories',
  'integrations',
  'externalTools',
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
