import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { groupCommands, groupSidebar, sortToolbar } from '~/modular/nav-contributions'
import { EXTERNAL_TOOL_UNAVAILABLE_KEYS, projectExternalTools } from '~/modular/external-tools'
import { toMetadataBag } from '~/modular/workspace-metadata'
import type { ExternalToolContext, ExternalToolContribution } from '~/modular/external-tools'
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
  // Resolved through the Nuxt app's global i18n instance rather than `useI18n()` (which needs
  // an active component instance) — the same handle, and the same reason, as
  // `usePipelineErrorToast`: nothing about this composable should depend on WHERE it is called.
  const { t } = useNuxtApp().$i18n as ReturnType<typeof useI18n>
  const toast = useToast()
  const auth = useAuthStore()
  const workspace = useWorkspaceStore()
  const workspaceSettings = useWorkspaceSettingsStore()

  // First-party action ids → host handlers. Typed as an exhaustive
  // `Record<NavActionId, …>`, so a catalog `action` with no handler (or a handler
  // with no catalog entry) is a compile error, not a silently dead button.
  // Consumer items bypass this map entirely via their own `run` closure.
  const actions: Record<NavActionId, () => void> = {
    buildPipeline: () => ui.openBuilder(),
    addFromRepo: () => ui.openAddService(),
    bootstrapRepo: () => ui.openBootstrap(),
    integrationsHub: () => ui.openIntegrations(),
    modelProviders: () => ui.openModelProviders(),
    sandbox: () => ui.openSandbox(),
    kaizen: () => ui.openKaizen(),
    infrastructure: () => ui.openInfrastructure(),
    fragmentLibrary: () => ui.openFragmentLibrary(),
    mergeThresholds: () => ui.openWorkspaceSettings('merge'),
    workspaceSettings: () => ui.openWorkspaceSettings(),
    modelConfiguration: () => ui.openModelConfig(),
    serviceFragmentDefaults: () => ui.openWorkspaceSettings('fragments'),
    localModels: () => ui.openLocalModels(),
    accountSettings: () => ui.openAccountSettings(),
    operatorDashboard: () => ui.openOperatorDashboard(),
    reports: () => ui.openReports(),
    shortcuts: () => ui.openShortcutsHelp(),
    tutorial: () => useTutorialStore().openPrompt(),
    // No-op under an env pin (`setMode` refuses), so the palette entry matches the sidebar
    // switcher's read-only state rather than pretending to flip a tier the resolver fixes.
    toggleUiMode: () => useUiModeStore().toggleMode(),
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

  /**
   * The stored metadata bag, re-hung on a null prototype. A resolver is a DEPLOYMENT'S own code
   * writing `ctx.metadata.gameId`, so the object it reads has to answer `undefined` for an
   * unfilled field whatever that field is called — `constructor` and `toString` both pass the
   * key pattern, and on a plain object both read as an inherited function. A `computed` rather
   * than a copy per read, so the reference stays stable between settings changes.
   */
  const externalToolMetadata = computed(() => toMetadataBag(workspaceSettings.settings.metadata))

  /**
   * The invocation context an external tool's resolver reads. GETTERS, not a captured snapshot,
   * so a resolver called at click time sees the workspace/metadata as they are NOW — a teammate
   * can fill in the field the tool needs while this sidebar is open, and the click must then
   * work rather than repeat a message about a fix that already happened. (They also keep the
   * projection below reactive: reading a store inside the computed tracks it.)
   */
  const externalToolContext: ExternalToolContext = {
    get userId() {
      return auth.user?.id ?? null
    },
    get userEmail() {
      return auth.user?.email ?? null
    },
    get workspaceId() {
      return workspace.workspaceId ?? ''
    },
    get workspaceName() {
      return workspace.activeWorkspace?.name ?? ''
    },
    get metadata() {
      return externalToolMetadata.value
    },
  }

  /**
   * Registered external tools, projected onto nav contributions. The `externalTools` slot is
   * already RBAC/tier-filtered by `navSlotFilter`, exactly like `nav`.
   *
   * A tool that can't currently resolve stays in the list and explains itself on click: the
   * person looking at the sidebar is usually the one who can fix it (fill in the field), and
   * hiding it would make an unconfigured workspace look like a deployment that never
   * registered the tool.
   */
  const externalToolItems = computed<NavContribution[]>(() =>
    projectExternalTools(
      (slots.value.externalTools ?? []) as ExternalToolContribution[],
      externalToolContext,
      {
        // A separate browsing context, with `noopener` so the opened page cannot reach back
        // into this one through `window.opener`.
        open: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
        onUnavailable: (resolution, tool) => {
          // A resolver that threw is the one refusal the toast can't fully explain: the person
          // reading it can't act on a stack trace, and the deployment author who can isn't
          // here. So the message says which tool is broken and the cause goes to the console —
          // unconditionally, not behind `import.meta.dev`, because this is an exception being
          // absorbed and the deployment debugging it is a built one.
          if (resolution.reason === 'resolver-failed') {
            console.error(
              `[cat-factory] external tool "${tool.id}" URL resolver threw`,
              resolution.cause,
            )
          }
          toast.add({
            title: t('externalTools.unavailable.title', { tool: tool.title }),
            description: t(EXTERNAL_TOOL_UNAVAILABLE_KEYS[resolution.reason], {
              fields: resolution.missing.join(', '),
            }),
            icon: 'i-lucide-triangle-alert',
            color: 'warning',
          })
        },
      },
    ).map((item) => item.contribution),
  )

  const all = computed<NavContribution[]>(() => [
    ...(slots.value.nav ?? []),
    ...externalToolItems.value,
  ])

  /** Grouped + ordered sidebar sections, empty sections dropped. */
  const sidebarGroups = computed<SidebarGroup[]>(() => groupSidebar(all.value))

  /** Grouped + ordered command-palette entries, empty groups dropped. */
  const commandGroups = computed<CommandGroup[]>(() => groupCommands(all.value))

  /** Toolbar contributions (the consumer extension point on `BoardToolbar`). */
  const toolbarItems = computed<NavContribution[]>(() => sortToolbar(all.value))

  return { sidebarGroups, commandGroups, toolbarItems, invoke }
}
