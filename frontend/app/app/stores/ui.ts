import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DocumentSourceKind, TaskSourceKind, LodLevel } from '~/types/domain'
import type { PendingContext } from '~/composables/useContextLinking'
import { zoomToLod } from '~/composables/useSemanticZoom'
import { useExecutionStore } from '~/stores/execution'
import { agentKindMeta } from '~/utils/catalog'

/** Values used to seed the add-task form when it is opened from another surface. */
export interface AddTaskPrefill {
  title?: string
  description?: string
  /** Context items staged on the new task (e.g. the source issue), linked once created. */
  context?: PendingContext[]
}

/** Transient UI state: selection, panels, zoom level. */
export const useUiStore = defineStore('ui', () => {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)
  const builderOpen = ref(false)
  // Pipeline-health startup advisory: lists invalid pipelines (delete / reseed) + built-ins
  // with a newer catalog version (reseed). `pipelineHealthSeen` gates auto-open to once per
  // session so it does not re-pop on every snapshot re-hydration.
  const pipelineHealthOpen = ref(false)
  const pipelineHealthSeen = ref(false)
  const decisionContext = ref<{ instanceId: string; decisionId: string } | null>(null)

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

  // Repo-bootstrap modal (manage reference architectures + launch a bootstrap).
  const bootstrapOpen = ref(false)

  // "Add a service from an existing GitHub repo" modal (no bootstrap run).
  const addServiceOpen = ref(false)

  // GitHub integration panel (connection management + repo/PR/issue browsing).
  const githubOpen = ref(false)

  // Slack integration panel (connect the account's Slack + per-workspace routing).
  const slackOpen = ref(false)

  // Prompt-fragment library panel (manage the board's best-practice catalog +
  // linked guideline repos; ADR 0006).
  const fragmentLibraryOpen = ref(false)

  // Command bar (⌘K) — searchable launcher for every navbar action.
  const commandBarOpen = ref(false)

  // Mobile navigation drawer: on compact (< lg) viewports the SideBar is an
  // off-canvas drawer toggled by a hamburger; on lg+ it is a static aside and this
  // flag is ignored. Closed on any nav action so the board is revealed immediately.
  const mobileNavOpen = ref(false)

  // Integrations hub: a single modal listing every external system the workspace
  // can enable/link (GitHub, Slack, document + task sources, Datadog, LLM vendors,
  // local runners, OpenRouter). Replaces the per-integration navbar buttons; each
  // row inside it opens that integration's own panel via the handlers below.
  const integrationsOpen = ref(false)
  // True while an integration's own panel is showing AND it was reached from the hub
  // (not the command bar, sidebar, a banner or an inspector link). Drives the "Back to
  // Integrations" control those panels render: it only offers a return path when there
  // is one. Every direct `open*` below resets it; `openFromIntegrations` sets it.
  const cameFromIntegrations = ref(false)

  // Personal "My setup" hub: a user-scoped sibling of the Integrations hub, listing the
  // signed-in user's own connections (GitHub PAT, local runners, personal subscriptions)
  // separated out of the workspace-scoped Integrations hub. `cameFromPersonal` is the
  // symmetric came-from marker, so a panel reached from here renders a "Back to My setup"
  // control instead of "Back to Integrations".
  const personalSetupOpen = ref(false)
  const cameFromPersonal = ref(false)

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
  // Observability integration: the post-release-health connection panel (Datadog
  // today, pluggable). NB: distinct from `observabilityInstanceId` below, which is the
  // LLM per-call observability panel.
  const observabilityConnectionOpen = ref(false)
  // The single tabbed Infrastructure window (ephemeral-environment provider + self-hosted
  // runner pool — the same custom pool typically backs both jobs, so they're configured
  // together). `infrastructureOpen` is the modal flag; `infrastructureTab` selects which
  // provider's tab is shown. `openProviderConnection(kind)` stays the entry API but now
  // selects the matching tab instead of mounting a per-kind standalone panel.
  const infrastructureOpen = ref(false)
  const infrastructureTab = ref<'environment' | 'runner-pool'>('runner-pool')
  const modelConfigOpen = ref(false)
  // LLM-vendor subscription credentials (the token pool powering the Claude Code
  // / Codex harnesses). `vendorCredentialsTab` lets a caller deep-link to one tab —
  // the user-scoped "My subscriptions" entry opens straight onto the `personal` tab.
  const vendorCredentialsOpen = ref(false)
  const vendorCredentialsTab = ref('pool')
  // Per-user settings panel: the signed-in user's own-machine local model runners.
  const localModelsOpen = ref(false)
  // Local-mode-only settings panel: the warm-container pool sizing + per-repo checkout reuse
  // (a per-deployment singleton that replaced the LOCAL_POOL_* / HARNESS_* env vars).
  const localModeSettingsOpen = ref(false)
  // The Sandbox (parallel prompt/model testing) surface — an opt-in, on-demand window.
  const sandboxOpen = ref(false)
  const userSecretsOpen = ref(false)
  // Per-workspace settings panel: the OpenRouter dynamic catalog (browse/enable gateway models).
  const openRouterOpen = ref(false)

  // AI-onboarding surfaces (driven by `useAiReadiness`). `aiProviderSetupOpen` is the
  // "no usable AI source" dialog; `aiPresetMismatchOpen` is the "default preset points at
  // unavailable models" dialog. The `*Dismissed` flags are per-session: they suppress the
  // auto-open (and let the banner be dismissed) without permanently hiding the prompt — it
  // re-evaluates on the next load. Both clear themselves once the underlying gap is closed.
  const aiProviderSetupOpen = ref(false)
  const aiPresetMismatchOpen = ref(false)
  const aiSetupDismissed = ref(false)
  const aiPresetDismissed = ref(false)

  // Dedicated result-view overlay: a step whose agent kind declares a bespoke
  // visualization (via the archetype's `resultView`) opens here instead of the generic
  // prose step-detail panel. `view` is the registry id (e.g. 'requirements-review');
  // `blockId` is always set; `instanceId`/`stepIndex` are present on the pipeline path and
  // null for an off-path open (e.g. the inspector's pre-start requirements review).
  const resultView = ref<{
    view: string
    blockId: string
    instanceId: string | null
    stepIndex: number | null
    // The brainstorm dialogue stage, set only when `view === 'brainstorm'` (its two agent
    // kinds share one window). Derived from the step's agent kind on the pipeline path, or
    // passed explicitly on an off-path open.
    stage?: 'requirements' | 'architecture'
  } | null>(null)

  // Agent step-detail overlay: which pipeline step (a run instance + step index)
  // a human is inspecting, or null when closed. The overlay resolves the step
  // from the execution store so it stays live; it shows the step's metadata
  // (model, state, progress, subtasks, …) and — when the agent produced prose —
  // a reader for it (ToC + collapsible sections).
  const stepDetail = ref<{ instanceId: string; stepIndex: number } | null>(null)

  // LLM observability panel: which run (execution instance) a human is inspecting
  // the per-call model activity for, or null when closed. The panel loads the full
  // per-call detail from the observability store on open.
  const observabilityInstanceId = ref<string | null>(null)

  // The Kaizen screen (grading history + verified-combo library), a full-panel overlay
  // opened from the sidebar. Distinct from the per-run grading status shown in run details.
  const kaizenScreenOpen = ref(false)

  /** Current canvas zoom (driven by Vue Flow viewport). */
  const zoom = ref(1)

  const lod = computed<LodLevel>(() => zoomToLod(zoom.value))

  /** Frames the user has manually expanded to reveal their tasks. */
  const expandedFrames = ref<Set<string>>(new Set())

  function toggleFrame(id: string) {
    const next = new Set(expandedFrames.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expandedFrames.value = next
  }

  function expandFrame(id: string) {
    if (expandedFrames.value.has(id)) return
    expandedFrames.value = new Set(expandedFrames.value).add(id)
  }

  /** Services are always expanded to their task canvas, at every zoom level, so the
   * board layout is fixed: panning never changes it and zooming has no expand/collapse
   * transition to snap on. (`expandedFrames`/`toggleFrame` are retained for callers but
   * no longer gate rendering.) */
  function isFrameExpanded(_id: string) {
    return true
  }

  function select(id: string | null) {
    selectedBlockId.value = id
  }

  function focus(id: string | null) {
    focusBlockId.value = id
  }

  function openBuilder() {
    builderOpen.value = true
  }

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

  function openDecision(instanceId: string, decisionId: string) {
    decisionContext.value = { instanceId, decisionId }
  }

  function closeDecision() {
    decisionContext.value = null
  }

  /**
   * Open a pending approval gate in the conclusions reader (approval mode). Resolves
   * the step index from the gate id so every board/inspector entry point can keep
   * passing the approval id it already has.
   */
  function openApprovalDetail(instanceId: string, approvalId: string) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    const idx = instance?.steps.findIndex((s) => s.approval?.id === approvalId) ?? -1
    if (idx >= 0) dispatchStepView(instanceId, idx)
  }

  /**
   * Open a pipeline step: route it to its agent kind's DEDICATED result window when the
   * archetype declares one (the universal `resultView` seam), else the generic prose
   * step-detail panel. This is the single dispatch every board/inspector entry point uses,
   * so adding a bespoke window for a new agent is just declaring `resultView` + registering
   * a component — no caller changes.
   */
  function dispatchStepView(instanceId: string, stepIndex: number) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    const step = instance?.steps[stepIndex]
    // A step that actually ran the consensus mechanism opens the dedicated Consensus
    // Session window, regardless of its kind's normal result view — consensus is an
    // execution MODE on a kind, not a kind, so it can't be a static archetype `resultView`.
    const view = step?.consensus?.enabled
      ? 'consensus-session'
      : step
        ? agentKindMeta(step.agentKind).resultView
        : undefined
    if (view && instance) {
      // The brainstorm window is shared by both stages; carry which one from the step's kind.
      const stage =
        view === 'brainstorm'
          ? step?.agentKind === 'architecture-brainstorm'
            ? 'architecture'
            : 'requirements'
          : undefined
      resultView.value = {
        view,
        blockId: instance.blockId,
        instanceId,
        stepIndex,
        ...(stage ? { stage } : {}),
      }
      return
    }
    stepDetail.value = { instanceId, stepIndex }
  }

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
  function openMobileNav() {
    mobileNavOpen.value = true
  }
  function closeMobileNav() {
    mobileNavOpen.value = false
  }
  function toggleMobileNav() {
    mobileNavOpen.value = !mobileNavOpen.value
  }
  // Clear BOTH hub came-from markers. Every direct `open*` below calls this so that a
  // panel opened outside the hubs never grows a dead Back control, and so switching from
  // one hub's panel to the other's clears the stale marker.
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
  function closeAccountSettings() {
    accountSettingsOpen.value = false
  }
  function setAccountSettingsTab(tab: string) {
    accountSettingsTab.value = tab
  }
  function openObservabilityConnection() {
    resetHubReturn()
    observabilityConnectionOpen.value = true
  }
  function closeObservabilityConnection() {
    observabilityConnectionOpen.value = false
  }
  function openProviderConnection(kind: 'environment' | 'runner-pool') {
    resetHubReturn()
    infrastructureTab.value = kind
    infrastructureOpen.value = true
  }
  function closeProviderConnection() {
    infrastructureOpen.value = false
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
  function openLocalModeSettings() {
    resetHubReturn()
    localModeSettingsOpen.value = true
  }
  function closeLocalModeSettings() {
    localModeSettingsOpen.value = false
  }
  function openSandbox() {
    sandboxOpen.value = true
  }
  function closeSandbox() {
    sandboxOpen.value = false
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
  function openRequirementReview(blockId: string) {
    resultView.value = { view: 'requirements-review', blockId, instanceId: null, stepIndex: null }
  }
  function openClarityReview(blockId: string) {
    resultView.value = { view: 'clarity-review', blockId, instanceId: null, stepIndex: null }
  }
  function openBrainstorm(blockId: string, stage: 'requirements' | 'architecture') {
    resultView.value = { view: 'brainstorm', blockId, instanceId: null, stepIndex: null, stage }
  }
  // Open the service-spec window for a service frame (the inspector's "View Requirements").
  function openServiceSpec(blockId: string) {
    resultView.value = { view: 'service-spec', blockId, instanceId: null, stepIndex: null }
  }
  // Open the Follow-up companion window for a run's Coder step (the blinking chip + the
  // `followup_pending` notification). Resolves the Coder step index from the run when not
  // given, so callers that only know the run can still open it.
  function openFollowUps(instanceId: string, stepIndex: number | null = null) {
    const execution = useExecutionStore()
    const instance = execution.getInstance(instanceId)
    if (!instance) return
    // A pipeline may carry more than one follow-up-enabled Coder step, so don't blindly pick
    // the first when no index is given: prefer the step that still has undecided items (the
    // one the run is parked on), else the current step, else the first enabled one.
    const resolveIdx = () => {
      const pending = instance.steps.findIndex(
        (s) => s.followUps?.enabled && s.followUps.items.some((i) => i.status === 'pending'),
      )
      if (pending >= 0) return pending
      const current = instance.steps[instance.currentStep]
      if (current?.followUps?.enabled) return instance.currentStep
      return instance.steps.findIndex((s) => s.followUps?.enabled)
    }
    const idx = stepIndex ?? resolveIdx()
    if (idx < 0) return
    resultView.value = {
      view: 'follow-ups',
      blockId: instance.blockId,
      instanceId,
      stepIndex: idx,
    }
  }
  function closeResultView() {
    resultView.value = null
  }
  // Kept name for the requirements window's close handler.
  const closeRequirementReview = closeResultView
  function openStepDetail(instanceId: string, stepIndex: number) {
    dispatchStepView(instanceId, stepIndex)
  }
  function closeStepDetail() {
    stepDetail.value = null
  }
  function openObservability(instanceId: string) {
    observabilityInstanceId.value = instanceId
  }
  function closeObservability() {
    observabilityInstanceId.value = null
  }
  function openKaizen() {
    kaizenScreenOpen.value = true
  }
  function closeKaizen() {
    kaizenScreenOpen.value = false
  }

  return {
    selectedBlockId,
    focusBlockId,
    builderOpen,
    pipelineHealthOpen,
    pipelineHealthSeen,
    decisionContext,
    documentConnect,
    documentImport,
    spawnPreview,
    taskConnect,
    taskImport,
    addTaskContainerId,
    addTaskPrefill,
    addRecurringFrameId,
    bootstrapOpen,
    addServiceOpen,
    githubOpen,
    slackOpen,
    fragmentLibraryOpen,
    commandBarOpen,
    mobileNavOpen,
    integrationsOpen,
    cameFromIntegrations,
    personalSetupOpen,
    cameFromPersonal,
    workspaceSettingsOpen,
    workspaceSettingsTab,
    accountSettingsOpen,
    accountSettingsTab,
    observabilityConnectionOpen,
    infrastructureOpen,
    infrastructureTab,
    modelConfigOpen,
    vendorCredentialsOpen,
    vendorCredentialsTab,
    localModelsOpen,
    localModeSettingsOpen,
    sandboxOpen,
    userSecretsOpen,
    openRouterOpen,
    aiProviderSetupOpen,
    aiPresetMismatchOpen,
    aiSetupDismissed,
    aiPresetDismissed,
    resultView,
    closeResultView,
    stepDetail,
    observabilityInstanceId,
    kaizenScreenOpen,
    zoom,
    lod,
    expandedFrames,
    toggleFrame,
    expandFrame,
    isFrameExpanded,
    select,
    focus,
    openBuilder,
    maybeOpenPipelineHealth,
    openPipelineHealth,
    closePipelineHealth,
    openDecision,
    closeDecision,
    openApprovalDetail,
    openDocumentConnect,
    closeDocumentConnect,
    openDocumentImport,
    closeDocumentImport,
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
    openBootstrap,
    closeBootstrap,
    openAddService,
    closeAddService,
    openGitHub,
    closeGitHub,
    openSlack,
    closeSlack,
    openFragmentLibrary,
    closeFragmentLibrary,
    openCommandBar,
    closeCommandBar,
    toggleCommandBar,
    openMobileNav,
    closeMobileNav,
    toggleMobileNav,
    openIntegrations,
    closeIntegrations,
    openFromIntegrations,
    openPersonalSetup,
    closePersonalSetup,
    openFromPersonal,
    openWorkspaceSettings,
    closeWorkspaceSettings,
    setWorkspaceSettingsTab,
    openAccountSettings,
    closeAccountSettings,
    setAccountSettingsTab,
    openObservabilityConnection,
    closeObservabilityConnection,
    openProviderConnection,
    closeProviderConnection,
    openModelConfig,
    closeModelConfig,
    openVendorCredentials,
    setVendorCredentialsTab,
    closeVendorCredentials,
    openLocalModels,
    closeLocalModels,
    openLocalModeSettings,
    closeLocalModeSettings,
    openSandbox,
    closeSandbox,
    openUserSecrets,
    closeUserSecrets,
    openOpenRouter,
    closeOpenRouter,
    openAiProviderSetup,
    closeAiProviderSetup,
    openAiPresetMismatch,
    closeAiPresetMismatch,
    dismissAiSetup,
    dismissAiPresetMismatch,
    resetAiOnboarding,
    openRequirementReview,
    openClarityReview,
    openBrainstorm,
    openServiceSpec,
    openFollowUps,
    closeRequirementReview,
    openStepDetail,
    closeStepDetail,
    openObservability,
    closeObservability,
    openKaizen,
    closeKaizen,
  }
})
