import { ref } from 'vue'
import type { DocumentSourceKind, InfraSetupArea, TaskSourceKind } from '~/types/domain'
import type { PendingContext } from '~/composables/useContextLinking'

/** Values used to seed the add-task form when it is opened from another surface. */
export interface AddTaskPrefill {
  title?: string
  description?: string
  /** Context items staged on the new task (e.g. the source issue), linked once created. */
  context?: PendingContext[]
}

/**
 * Non-secret `local-k3s` connection values captured from the `cat-factory k3s` CLI deep-link
 * (`?infraSetup=local-k3s&…`). Mirrors the params `buildK3sSetupUrl` emits (the CLI-side
 * `k3s-handler.ts`); the ServiceAccount token is intentionally absent — the user pastes it.
 */
export interface K3sSetupPrefill {
  label: string
  apiServerUrl: string
  namespaceTemplate: string
  hostTemplate: string
  // Absent when the link omitted the param, so the form keeps its engine default rather than
  // forcing verification back on (which would break a self-signed local cluster).
  insecureSkipTlsVerify?: boolean
}

/** Clears both hub came-from markers; injected into the slices whose `open*` handlers reset them. */
type ResetHubReturn = () => void

/**
 * Startup health advisories (pipeline / merge-preset / model-preset). Each lists built-ins with a
 * newer catalog version (reseed) + new built-ins the workspace can add; the `*Seen` flag gates
 * auto-open to once per session so it does not re-pop on every snapshot re-hydration.
 */
function createHealthAdvisoryModals() {
  const pipelineHealthOpen = ref(false)
  const pipelineHealthSeen = ref(false)
  const riskPolicyHealthOpen = ref(false)
  const riskPolicyHealthSeen = ref(false)
  const modelPresetHealthOpen = ref(false)
  const modelPresetHealthSeen = ref(false)

  /** Auto-open the pipeline-health advisory once per session (no-op after it's been shown). */
  function maybeOpenPipelineHealth() {
    if (pipelineHealthSeen.value) return
    pipelineHealthSeen.value = true
    pipelineHealthOpen.value = true
  }
  function openPipelineHealth() {
    pipelineHealthSeen.value = true
    pipelineHealthOpen.value = true
  }
  function closePipelineHealth() {
    pipelineHealthOpen.value = false
  }

  /** Auto-open the merge-preset health advisory once per session (no-op after it's been shown). */
  function maybeOpenRiskPolicyHealth() {
    if (riskPolicyHealthSeen.value) return
    riskPolicyHealthSeen.value = true
    riskPolicyHealthOpen.value = true
  }
  function openRiskPolicyHealth() {
    riskPolicyHealthSeen.value = true
    riskPolicyHealthOpen.value = true
  }
  function closeRiskPolicyHealth() {
    riskPolicyHealthOpen.value = false
  }

  /** Auto-open the model-preset health advisory once per session (no-op after it's been shown). */
  function maybeOpenModelPresetHealth() {
    if (modelPresetHealthSeen.value) return
    modelPresetHealthSeen.value = true
    modelPresetHealthOpen.value = true
  }
  function openModelPresetHealth() {
    modelPresetHealthSeen.value = true
    modelPresetHealthOpen.value = true
  }
  function closeModelPresetHealth() {
    modelPresetHealthOpen.value = false
  }

  return {
    pipelineHealthOpen,
    pipelineHealthSeen,
    riskPolicyHealthOpen,
    riskPolicyHealthSeen,
    modelPresetHealthOpen,
    modelPresetHealthSeen,
    maybeOpenPipelineHealth,
    openPipelineHealth,
    closePipelineHealth,
    maybeOpenRiskPolicyHealth,
    openRiskPolicyHealth,
    closeRiskPolicyHealth,
    maybeOpenModelPresetHealth,
    openModelPresetHealth,
    closeModelPresetHealth,
  }
}

/**
 * Small standalone surfaces with no hub relationship: the pipeline builder and the
 * decision-wait window.
 */
function createMiscModals() {
  const builderOpen = ref(false)
  const decisionContext = ref<{ instanceId: string; decisionId: string } | null>(null)

  function openBuilder() {
    builderOpen.value = true
  }
  function openDecision(instanceId: string, decisionId: string) {
    decisionContext.value = { instanceId, decisionId }
  }
  function closeDecision() {
    decisionContext.value = null
  }

  return { builderOpen, decisionContext, openBuilder, openDecision, closeDecision }
}

/**
 * Document- and task-source integration modals (keyed by source), plus the add-task /
 * add-recurring / create-initiative surfaces. The `open*` connect/import handlers reset the hub
 * came-from markers (they can be reached from the Integrations hub).
 */
function createDocumentTaskModals(resetHubReturn: ResetHubReturn) {
  // Document-source integration modals, keyed by source. `documentImport` and
  // `spawnPreview` carry an optional target frame, so structure spawned from a
  // frame's inspector lands inside that frame rather than creating new top-level
  // frames. `documentConnect` carries the source whose connect form to show;
  // `documentImport`'s source may be null to let the modal pick a connected one.
  const documentConnect = ref<{ source: DocumentSourceKind } | null>(null)
  const documentImport = ref<{
    source: DocumentSourceKind | null
    targetFrameId: string | null
  } | null>(null)
  // The workspace+DocKind template / exemplar management modal (WS1). A single boolean —
  // it manages every kind's links in one place.
  const documentTemplates = ref(false)
  const spawnPreview = ref<{
    source: DocumentSourceKind
    externalId: string
    targetFrameId: string | null
  } | null>(null)

  // Task-source integration modals, keyed by source. `taskConnect` carries the
  // source whose connect form to show; `taskImport`'s source may be null to let
  // the modal pick a connected one (there is no spawn target — issues are linked
  // to a block for context, not expanded into structure).
  const taskConnect = ref<{ source: TaskSourceKind } | null>(null)
  // `containerId` (a service frame) scopes the modal: it preselects that frame as
  // the create-in target AND scopes the issue search to the frame's linked repo.
  // Null → the unscoped "import an issue" surface (workspace-wide search).
  const taskImport = ref<{ source: TaskSourceKind | null; containerId: string | null } | null>(null)

  // Add-task modal: the container (service frame or module) a new task is being
  // added to, or null when closed. The user types the title + description; nothing
  // is launched until they explicitly start the created task.
  const addTaskContainerId = ref<string | null>(null)
  // Optional values to seed the add-task form with when it is opened from another
  // surface (e.g. "create task from issue" prefills the title + stages the issue as
  // linked context). The user still confirms pipeline / preset before adding.
  const addTaskPrefill = ref<AddTaskPrefill | null>(null)

  // Add-recurring-pipeline modal: the service frame a new recurring pipeline is
  // being added to, or null when closed (mirrors the add-task flow — a button on
  // the frame opens it, scoped to that frame).
  const addRecurringFrameId = ref<string | null>(null)

  // Create-initiative modal: the service frame a new initiative is being created
  // under, or null when closed (mirrors the add-task flow).
  const createInitiativeFrameId = ref<string | null>(null)

  function openDocumentConnect(source: DocumentSourceKind) {
    resetHubReturn()
    documentConnect.value = { source }
  }
  function closeDocumentConnect() {
    documentConnect.value = null
  }
  function openDocumentImport(
    targetFrameId: string | null = null,
    source: DocumentSourceKind | null = null,
  ) {
    resetHubReturn()
    documentImport.value = { source, targetFrameId }
  }
  function closeDocumentImport() {
    documentImport.value = null
  }
  function openDocumentTemplates() {
    resetHubReturn()
    documentTemplates.value = true
  }
  function closeDocumentTemplates() {
    documentTemplates.value = false
  }
  function openSpawnPreview(
    source: DocumentSourceKind,
    externalId: string,
    targetFrameId: string | null = null,
  ) {
    spawnPreview.value = { source, externalId, targetFrameId }
  }
  function closeSpawnPreview() {
    spawnPreview.value = null
  }
  function openTaskConnect(source: TaskSourceKind) {
    resetHubReturn()
    taskConnect.value = { source }
  }
  function closeTaskConnect() {
    taskConnect.value = null
  }
  function openTaskImport(source: TaskSourceKind | null = null, containerId: string | null = null) {
    resetHubReturn()
    taskImport.value = { source, containerId }
  }
  function closeTaskImport() {
    taskImport.value = null
  }
  function openAddTask(containerId: string, prefill: AddTaskPrefill | null = null) {
    addTaskPrefill.value = prefill
    addTaskContainerId.value = containerId
  }
  function closeAddTask() {
    addTaskContainerId.value = null
    addTaskPrefill.value = null
  }
  function openAddRecurring(frameId: string) {
    addRecurringFrameId.value = frameId
  }
  function closeAddRecurring() {
    addRecurringFrameId.value = null
  }
  function openCreateInitiative(frameId: string) {
    createInitiativeFrameId.value = frameId
  }
  function closeCreateInitiative() {
    createInitiativeFrameId.value = null
  }

  return {
    documentConnect,
    documentImport,
    documentTemplates,
    spawnPreview,
    taskConnect,
    taskImport,
    addTaskContainerId,
    addTaskPrefill,
    addRecurringFrameId,
    createInitiativeFrameId,
    openDocumentConnect,
    closeDocumentConnect,
    openDocumentImport,
    closeDocumentImport,
    openDocumentTemplates,
    closeDocumentTemplates,
    openSpawnPreview,
    closeSpawnPreview,
    openTaskConnect,
    closeTaskConnect,
    openTaskImport,
    closeTaskImport,
    openAddTask,
    closeAddTask,
    openAddRecurring,
    closeAddRecurring,
    openCreateInitiative,
    closeCreateInitiative,
  }
}

/**
 * Global overlays with no hub-return relationship: repo bootstrap, add-service, the fragment
 * library, the command bar (⌘K), the shortcuts cheatsheet, the mobile nav drawer, and the
 * Sandbox. None reset the hub came-from markers (they aren't reached from the Integrations hub).
 */
function createOverlayModals() {
  // Repo-bootstrap modal (manage reference architectures + launch a bootstrap).
  const bootstrapOpen = ref(false)
  // "Add a service from an existing GitHub repo" modal (no bootstrap run).
  const addServiceOpen = ref(false)
  // Prompt-fragment library panel (manage the board's best-practice catalog +
  // linked guideline repos; ADR 0006).
  const fragmentLibraryOpen = ref(false)
  // Command bar (⌘K) — searchable launcher for every navbar action.
  const commandBarOpen = ref(false)
  // Keyboard-shortcuts cheatsheet (?) — a modal listing every global shortcut.
  const shortcutsHelpOpen = ref(false)
  // Mobile navigation drawer: on compact (< lg) viewports the SideBar is an
  // off-canvas drawer toggled by a hamburger; on lg+ it is a static aside and this
  // flag is ignored. Closed on any nav action so the board is revealed immediately.
  const mobileNavOpen = ref(false)
  // The Sandbox (parallel prompt/model testing) surface — an opt-in, on-demand window.
  const sandboxOpen = ref(false)

  function openBootstrap() {
    bootstrapOpen.value = true
  }
  function closeBootstrap() {
    bootstrapOpen.value = false
  }
  function openAddService() {
    addServiceOpen.value = true
  }
  function closeAddService() {
    addServiceOpen.value = false
  }
  function openFragmentLibrary() {
    fragmentLibraryOpen.value = true
  }
  function closeFragmentLibrary() {
    fragmentLibraryOpen.value = false
  }
  function openCommandBar() {
    commandBarOpen.value = true
  }
  function closeCommandBar() {
    commandBarOpen.value = false
  }
  function toggleCommandBar() {
    commandBarOpen.value = !commandBarOpen.value
  }
  function openShortcutsHelp() {
    shortcutsHelpOpen.value = true
  }
  function closeShortcutsHelp() {
    shortcutsHelpOpen.value = false
  }
  function toggleShortcutsHelp() {
    shortcutsHelpOpen.value = !shortcutsHelpOpen.value
  }
  function openMobileNav() {
    mobileNavOpen.value = true
  }
  function closeMobileNav() {
    mobileNavOpen.value = false
  }
  function toggleMobileNav() {
    mobileNavOpen.value = !mobileNavOpen.value
  }
  function openSandbox() {
    sandboxOpen.value = true
  }
  function closeSandbox() {
    sandboxOpen.value = false
  }

  return {
    bootstrapOpen,
    addServiceOpen,
    fragmentLibraryOpen,
    commandBarOpen,
    shortcutsHelpOpen,
    mobileNavOpen,
    sandboxOpen,
    openBootstrap,
    closeBootstrap,
    openAddService,
    closeAddService,
    openFragmentLibrary,
    closeFragmentLibrary,
    openCommandBar,
    closeCommandBar,
    toggleCommandBar,
    openShortcutsHelp,
    closeShortcutsHelp,
    toggleShortcutsHelp,
    openMobileNav,
    closeMobileNav,
    toggleMobileNav,
    openSandbox,
    closeSandbox,
  }
}

/**
 * The workspace-scoped integration panels: GitHub, Slack, observability, the operator dashboard,
 * package registries, API tokens, model config, vendor credentials, local models, user secrets and
 * OpenRouter. Every `open*` that a hub can route to resets the hub came-from markers.
 */
function createIntegrationPanelModals(resetHubReturn: ResetHubReturn) {
  // GitHub integration panel (connection management + repo/PR/issue browsing).
  const githubOpen = ref(false)
  // Slack integration panel (connect the account's Slack + per-workspace routing).
  const slackOpen = ref(false)
  // Observability integration: the post-release-health connection panel (Datadog
  // today, pluggable). NB: distinct from `observabilityInstanceId`, which is the
  // LLM per-call observability panel (see the result-views slice).
  const observabilityConnectionOpen = ref(false)
  // Platform-operator observability: the deployment-level dashboard (aggregate run health of
  // the account — outcomes, failure taxonomy, live depth, durations). Admin-gated. Distinct
  // from `observabilityConnectionOpen` (the Datadog connection) AND `observabilityInstanceId`
  // (the per-run LLM call panel).
  const operatorDashboardOpen = ref(false)
  // Private package registries: the workspace's npm/GitHub-Packages entries agent
  // containers install with. Opened from the Integrations hub.
  const packageRegistriesOpen = ref(false)
  // API access tokens: the workspace's inbound public-API keys external systems present to
  // the `/api/v1` surface. Opened from the Integrations hub.
  const apiTokensOpen = ref(false)
  const modelConfigOpen = ref(false)
  // LLM-vendor subscription credentials (the token pool powering the Claude Code
  // / Codex harnesses). `vendorCredentialsTab` lets a caller deep-link to one tab —
  // the user-scoped "My subscriptions" entry opens straight onto the `personal` tab.
  const vendorCredentialsOpen = ref(false)
  const vendorCredentialsTab = ref('pool')
  // Per-user settings panel: the signed-in user's own-machine local model runners.
  const localModelsOpen = ref(false)
  const userSecretsOpen = ref(false)
  // Per-workspace settings panel: the OpenRouter dynamic catalog (browse/enable gateway models).
  const openRouterOpen = ref(false)

  function openGitHub() {
    resetHubReturn()
    githubOpen.value = true
  }
  function closeGitHub() {
    githubOpen.value = false
  }
  function openSlack() {
    resetHubReturn()
    slackOpen.value = true
  }
  function closeSlack() {
    slackOpen.value = false
  }
  function openObservabilityConnection() {
    resetHubReturn()
    observabilityConnectionOpen.value = true
  }
  function closeObservabilityConnection() {
    observabilityConnectionOpen.value = false
  }
  function openOperatorDashboard() {
    resetHubReturn()
    operatorDashboardOpen.value = true
  }
  function closeOperatorDashboard() {
    operatorDashboardOpen.value = false
  }
  function openPackageRegistries() {
    resetHubReturn()
    packageRegistriesOpen.value = true
  }
  function closePackageRegistries() {
    packageRegistriesOpen.value = false
  }
  function openApiTokens() {
    resetHubReturn()
    apiTokensOpen.value = true
  }
  function closeApiTokens() {
    apiTokensOpen.value = false
  }
  function openModelConfig() {
    modelConfigOpen.value = true
  }
  function closeModelConfig() {
    modelConfigOpen.value = false
  }
  function openVendorCredentials(tab = 'pool') {
    resetHubReturn()
    vendorCredentialsTab.value = tab
    vendorCredentialsOpen.value = true
  }
  function setVendorCredentialsTab(tab: string) {
    vendorCredentialsTab.value = tab
  }
  function closeVendorCredentials() {
    vendorCredentialsOpen.value = false
  }
  function openLocalModels() {
    resetHubReturn()
    localModelsOpen.value = true
  }
  function closeLocalModels() {
    localModelsOpen.value = false
  }
  function openUserSecrets() {
    resetHubReturn()
    userSecretsOpen.value = true
  }
  function closeUserSecrets() {
    userSecretsOpen.value = false
  }
  function openOpenRouter() {
    resetHubReturn()
    openRouterOpen.value = true
  }
  function closeOpenRouter() {
    openRouterOpen.value = false
  }

  return {
    githubOpen,
    slackOpen,
    observabilityConnectionOpen,
    operatorDashboardOpen,
    packageRegistriesOpen,
    apiTokensOpen,
    modelConfigOpen,
    vendorCredentialsOpen,
    vendorCredentialsTab,
    localModelsOpen,
    userSecretsOpen,
    openRouterOpen,
    openGitHub,
    closeGitHub,
    openSlack,
    closeSlack,
    openObservabilityConnection,
    closeObservabilityConnection,
    openOperatorDashboard,
    closeOperatorDashboard,
    openPackageRegistries,
    closePackageRegistries,
    openApiTokens,
    closeApiTokens,
    openModelConfig,
    closeModelConfig,
    openVendorCredentials,
    setVendorCredentialsTab,
    closeVendorCredentials,
    openLocalModels,
    closeLocalModels,
    openUserSecrets,
    closeUserSecrets,
    openOpenRouter,
    closeOpenRouter,
  }
}

/**
 * Workspace- and account-settings modals (single tabbed windows). `*Tab` lets a caller deep-link
 * straight to a tab; `accountSettingsScrollTarget` is a one-shot deep-link anchor into a section
 * within the (long) account-settings body.
 */
function createSettingsModals(resetHubReturn: ResetHubReturn) {
  // Workspace-settings modal: a single tabbed window gathering the workspace-wide
  // config (workspace / merge thresholds / issue writeback / service best practices).
  // `workspaceSettingsTab` lets other surfaces deep-link straight to a tab.
  const workspaceSettingsOpen = ref(false)
  const workspaceSettingsTab = ref('workspace')
  // Account-settings modal: a single tabbed window for the per-account configuration —
  // the team panel (members + roles + invitations + email sender + account API keys,
  // `AccountTeamSettings`) and the account-tier prompt-fragment library. Account-scoped
  // (distinct from workspace settings). `accountSettingsTab` lets other surfaces deep-link
  // straight to a tab.
  const accountSettingsOpen = ref(false)
  const accountSettingsTab = ref('team')
  // A one-shot deep-link anchor: when a surface opens account settings AND wants to land on a
  // specific section within the (long) tab body, it sets this to that section's id. The owning
  // panel scrolls the matching element into view once, then calls `clearAccountSettingsScrollTarget`
  // so a later plain open doesn't re-scroll. Null when no section was requested.
  const accountSettingsScrollTarget = ref<string | null>(null)

  function openWorkspaceSettings(tab = 'workspace') {
    resetHubReturn()
    workspaceSettingsTab.value = tab
    workspaceSettingsOpen.value = true
  }
  function closeWorkspaceSettings() {
    workspaceSettingsOpen.value = false
  }
  function setWorkspaceSettingsTab(tab: string) {
    workspaceSettingsTab.value = tab
  }
  function openAccountSettings(tab = 'team') {
    resetHubReturn()
    accountSettingsTab.value = tab
    accountSettingsOpen.value = true
  }
  // Deep-link to the content (binary-artifact) storage configuration, which lives near the
  // bottom of the account settings' team tab (`AccountDeploymentSettings`). Used by the
  // pipeline-start error prompt when a storage-reliant agent (the UI Tester) has no storage
  // configured. Sets a scroll anchor so the panel brings the storage section into view rather
  // than dropping the user at the top of the long team tab to hunt for it.
  function openContentStorageSettings() {
    accountSettingsScrollTarget.value = 'content-storage'
    openAccountSettings('team')
  }
  function clearAccountSettingsScrollTarget() {
    accountSettingsScrollTarget.value = null
  }
  function closeAccountSettings() {
    accountSettingsOpen.value = false
    accountSettingsScrollTarget.value = null
  }
  function setAccountSettingsTab(tab: string) {
    accountSettingsTab.value = tab
  }

  return {
    workspaceSettingsOpen,
    workspaceSettingsTab,
    accountSettingsOpen,
    accountSettingsTab,
    accountSettingsScrollTarget,
    openWorkspaceSettings,
    closeWorkspaceSettings,
    setWorkspaceSettingsTab,
    openAccountSettings,
    openContentStorageSettings,
    clearAccountSettingsScrollTarget,
    closeAccountSettings,
    setAccountSettingsTab,
  }
}

/**
 * The Infrastructure window (agent containers + test environments) and the environment setup
 * wizard, plus the `cat-factory k3s` CLI deep-link capture that seeds the kube engine form.
 */
function createInfraModals(resetHubReturn: ResetHubReturn) {
  // The single tabbed Infrastructure window — a TOP-LEVEL navbar destination (no longer
  // reached via the Integrations hub). Two topical tabs: "Agent containers" (the execution
  // backend + self-hosted runner pool, plus the local-mode warm pool/checkout) and "Test
  // environments" (the ephemeral-environment provider). `infrastructureOpen` is the modal
  // flag; `infrastructureTab` selects the tab. `openInfrastructure()` is the navbar entry;
  // `openProviderConnection(kind)` remains for deep-links (a banner's "Configure…" button).
  const infrastructureOpen = ref(false)
  const infrastructureTab = ref<'environment' | 'runner-pool'>('runner-pool')
  // Non-secret prefill captured from the `cat-factory k3s` CLI deep-link (see
  // `consumeK3sSetupDeepLink`). When set, the Test-environments tab's kube engine form seeds the
  // `local-k3s` connection from it; the ServiceAccount token is deliberately NOT in the link (a
  // secret in a URL leaks into history/logs), so the user still pastes it before Test → Save.
  const k3sSetupPrefill = ref<K3sSetupPrefill | null>(null)
  // Environment setup wizard (shared-stacks slice 7): the guided detect → review → preflight →
  // trial → save flow for a service frame's `docker-compose` provisioning. `environmentWizardOpen`
  // is the modal flag; `environmentWizardFrameId` preselects the service frame the flow targets
  // (set when launched from a frame's inspector nudge; null ⇒ the wizard's pick step chooses one).
  const environmentWizardOpen = ref(false)
  const environmentWizardFrameId = ref<string | null>(null)

  // Top-level navbar entry into the Infrastructure window. No hub-return marker (it isn't
  // reached from the Integrations hub), so the window shows no "Back to Integrations" control.
  function openInfrastructure(tab: 'environment' | 'runner-pool' = 'runner-pool') {
    resetHubReturn()
    infrastructureTab.value = tab
    infrastructureOpen.value = true
  }
  function openProviderConnection(kind: 'environment' | 'runner-pool') {
    resetHubReturn()
    infrastructureTab.value = kind
    infrastructureOpen.value = true
  }
  function closeProviderConnection() {
    infrastructureOpen.value = false
    // Drop any consumed CLI prefill so re-opening the window normally doesn't re-seed the form.
    k3sSetupPrefill.value = null
  }
  // Capture a `cat-factory k3s` deep-link (`?infraSetup=local-k3s&…`) on app load: stash the
  // non-secret connection values, open the Infrastructure window on the Test-environments tab so
  // the kube engine form seeds from them, then strip the params from the URL (mirrors the
  // `?invite=` handling in the auth store) so a reload doesn't re-trigger and the link isn't left
  // in history. No-op when the query param is absent.
  function consumeK3sSetupDeepLink() {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('infraSetup') !== 'local-k3s') return
    k3sSetupPrefill.value = {
      label: params.get('label') ?? 'Local k3s',
      apiServerUrl: params.get('apiServerUrl') ?? '',
      namespaceTemplate: params.get('namespaceTemplate') ?? '',
      hostTemplate: params.get('hostTemplate') ?? '',
      // Only carry the flag the link actually set — a missing param leaves the form's engine
      // default (skip-TLS on for a local self-signed cluster) untouched.
      insecureSkipTlsVerify: params.has('insecureSkipTlsVerify')
        ? params.get('insecureSkipTlsVerify') === '1'
        : undefined,
    }
    resetHubReturn()
    infrastructureTab.value = 'environment'
    infrastructureOpen.value = true
    for (const key of [
      'infraSetup',
      'label',
      'apiServerUrl',
      'namespaceTemplate',
      'hostTemplate',
      'insecureSkipTlsVerify',
    ]) {
      params.delete(key)
    }
    const qs = params.toString()
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }
  // Launch the environment setup wizard, optionally preselecting the service frame it targets
  // (the inspector nudge passes the frame; the navbar entry opens it with the pick step active).
  function openEnvironmentSetup(frameId: string | null = null) {
    resetHubReturn()
    environmentWizardFrameId.value = frameId
    environmentWizardOpen.value = true
  }
  function closeEnvironmentSetup() {
    environmentWizardOpen.value = false
    environmentWizardFrameId.value = null
  }

  return {
    infrastructureOpen,
    infrastructureTab,
    openInfrastructure,
    k3sSetupPrefill,
    consumeK3sSetupDeepLink,
    environmentWizardOpen,
    environmentWizardFrameId,
    openProviderConnection,
    closeProviderConnection,
    openEnvironmentSetup,
    closeEnvironmentSetup,
  }
}

/**
 * AI-onboarding surfaces (driven by `useAiReadiness`) + the infra-setup banner's per-session
 * dismissals. The `*Dismissed` flags are per-session: they suppress the auto-open (and let the
 * banner be dismissed) without permanently hiding the prompt — it re-evaluates on the next load.
 */
function createAiOnboardingModals() {
  // `aiProviderSetupOpen` is the "no usable AI source" dialog; `aiPresetMismatchOpen` is the
  // "default preset points at unavailable models" dialog. Both clear themselves once the
  // underlying gap is closed.
  const aiProviderSetupOpen = ref(false)
  const aiPresetMismatchOpen = ref(false)
  const aiSetupDismissed = ref(false)
  const aiPresetDismissed = ref(false)

  // Infra-setup banner: per-SESSION dismissals, one flag per area, cleared on workspace switch
  // exactly like the AI-onboarding flags (a dismissal in one workspace must not suppress the
  // independent prompt for another). The PERMANENT "don't notify me again" dismissal is per-USER
  // and persists in localStorage from the banner component; this only covers "hide for now".
  const infraSetupSessionDismissed = ref<InfraSetupArea[]>([])
  function dismissInfraSetupForSession(area: InfraSetupArea) {
    if (!infraSetupSessionDismissed.value.includes(area))
      infraSetupSessionDismissed.value = [...infraSetupSessionDismissed.value, area]
  }
  function resetInfraSetupDismissals() {
    infraSetupSessionDismissed.value = []
  }

  function openAiProviderSetup() {
    aiProviderSetupOpen.value = true
  }
  function closeAiProviderSetup() {
    aiProviderSetupOpen.value = false
  }
  function openAiPresetMismatch() {
    aiPresetMismatchOpen.value = true
  }
  function closeAiPresetMismatch() {
    aiPresetMismatchOpen.value = false
  }
  // Banner dismissal is distinct from closing the dialog: closing the dialog leaves the
  // banner so the user can reopen it; dismissing the banner hides the whole prompt for
  // the session (it re-evaluates on the next load).
  function dismissAiSetup() {
    aiProviderSetupOpen.value = false
    aiSetupDismissed.value = true
  }
  function dismissAiPresetMismatch() {
    aiPresetMismatchOpen.value = false
    aiPresetDismissed.value = true
  }
  // Clear the per-session AI-onboarding state (open dialogs + dismissed flags). Called on
  // workspace switch: dismissals are per-session-per-workspace, so a prompt dismissed in one
  // workspace must not suppress the (independent) prompt for another workspace that also
  // lacks a usable AI source / has a broken default preset.
  function resetAiOnboarding() {
    aiProviderSetupOpen.value = false
    aiPresetMismatchOpen.value = false
    aiSetupDismissed.value = false
    aiPresetDismissed.value = false
  }

  return {
    aiProviderSetupOpen,
    aiPresetMismatchOpen,
    aiSetupDismissed,
    aiPresetDismissed,
    infraSetupSessionDismissed,
    dismissInfraSetupForSession,
    resetInfraSetupDismissals,
    openAiProviderSetup,
    closeAiProviderSetup,
    openAiPresetMismatch,
    closeAiPresetMismatch,
    dismissAiSetup,
    dismissAiPresetMismatch,
    resetAiOnboarding,
  }
}

/**
 * The modal / panel slice of the UI store: every open-close flag for the dozens of modals,
 * panels and hubs (document + task import, bootstrap, integrations, workspace/account settings,
 * infrastructure, vendor credentials, the startup health advisories, the AI-onboarding surfaces,
 * …), their deep-link params, and the hub came-from markers. Split out of the navigation +
 * result-view state per refactoring candidate #4 so the god-object's modal churn is contained to
 * one place. Composed into {@link useUiStore} with the same public names, so consumers are
 * unchanged. The state itself is grouped into cohesive sub-slices (health advisories, document +
 * task sources, integration panels, settings, infrastructure, AI onboarding), composed here behind
 * the shared hub came-from markers.
 */
export function createUiModals() {
  // Integrations / My-setup hub came-from markers — the one piece of state SHARED across slices
  // (many `open*` handlers reset it), so it lives here and `resetHubReturn` is threaded into the
  // slices that need it. `cameFromIntegrations` is true while an integration's own panel is showing
  // AND it was reached from the Integrations hub; `cameFromPersonal` is the My-setup analogue.
  const cameFromIntegrations = ref(false)
  const cameFromPersonal = ref(false)
  const integrationsOpen = ref(false)
  const personalSetupOpen = ref(false)

  // Clear BOTH hub came-from markers. Every direct `open*` in the slices calls this so that a
  // panel opened outside the hubs never grows a dead Back control, and so switching from one
  // hub's panel to the other's clears the stale marker.
  function resetHubReturn() {
    cameFromIntegrations.value = false
    cameFromPersonal.value = false
  }
  function openIntegrations() {
    // Reaching the hub itself (fresh, or via a panel's Back control) clears the
    // came-from markers — we're at the hub, not inside a hub-spawned panel.
    resetHubReturn()
    integrationsOpen.value = true
  }
  function closeIntegrations() {
    integrationsOpen.value = false
  }
  function openPersonalSetup() {
    resetHubReturn()
    personalSetupOpen.value = true
  }
  function closePersonalSetup() {
    personalSetupOpen.value = false
  }
  // Open a user-scoped panel FROM the My-setup hub: run its open handler (which resets the
  // markers), then mark that we came from My setup and dismiss it, so the panel's
  // IntegrationBackTitle returns here rather than to the workspace Integrations hub.
  function openFromPersonal(open: () => void) {
    open()
    cameFromPersonal.value = true
    personalSetupOpen.value = false
  }
  // Open an integration's own panel FROM the hub: run its open handler (which resets
  // `cameFromIntegrations`), then mark that we came from the hub and dismiss it. The
  // panel reads `cameFromIntegrations` to show its Back control.
  function openFromIntegrations(open: () => void) {
    open()
    cameFromIntegrations.value = true
    integrationsOpen.value = false
  }

  const health = createHealthAdvisoryModals()
  const misc = createMiscModals()
  const documentsTasks = createDocumentTaskModals(resetHubReturn)
  const overlays = createOverlayModals()
  const panels = createIntegrationPanelModals(resetHubReturn)
  const settings = createSettingsModals(resetHubReturn)
  const infra = createInfraModals(resetHubReturn)
  const ai = createAiOnboardingModals()

  return {
    integrationsOpen,
    cameFromIntegrations,
    personalSetupOpen,
    cameFromPersonal,
    openIntegrations,
    closeIntegrations,
    openFromIntegrations,
    openPersonalSetup,
    closePersonalSetup,
    openFromPersonal,
    ...health,
    ...misc,
    ...documentsTasks,
    ...overlays,
    ...panels,
    ...settings,
    ...infra,
    ...ai,
  }
}
