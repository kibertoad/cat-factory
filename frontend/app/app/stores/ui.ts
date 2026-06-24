import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DocumentSourceKind, TaskSourceKind, LodLevel } from '~/types/domain'
import { zoomToLod, lodAtLeast } from '~/composables/useSemanticZoom'
import { useExecutionStore } from '~/stores/execution'
import { agentKindMeta } from '~/utils/catalog'

/** Transient UI state: selection, panels, zoom level. */
export const useUiStore = defineStore('ui', () => {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)
  const builderOpen = ref(false)
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
  const taskImport = ref<{ source: TaskSourceKind | null } | null>(null)

  // Add-task modal: the container (service frame or module) a new task is being
  // added to, or null when closed. The user types the title + description; nothing
  // is launched until they explicitly start the created task.
  const addTaskContainerId = ref<string | null>(null)

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

  // Integrations hub: a single modal listing every external system the workspace
  // can enable/link (GitHub, Slack, document + task sources, Datadog, LLM vendors,
  // local runners, OpenRouter). Replaces the per-integration navbar buttons; each
  // row inside it opens that integration's own panel via the handlers below.
  const integrationsOpen = ref(false)

  // Workspace-settings modal: a single tabbed window gathering the workspace-wide
  // config (workspace / merge thresholds / issue writeback / service best practices).
  // `workspaceSettingsTab` lets other surfaces deep-link straight to a tab.
  const workspaceSettingsOpen = ref(false)
  const workspaceSettingsTab = ref('workspace')
  // Observability integration: the post-release-health connection panel (Datadog
  // today, pluggable). NB: distinct from `observabilityInstanceId` below, which is the
  // LLM per-call observability panel.
  const observabilityConnectionOpen = ref(false)
  const modelDefaultsOpen = ref(false)
  // LLM-vendor subscription credentials (the token pool powering the Claude Code
  // / Codex harnesses).
  const vendorCredentialsOpen = ref(false)
  // Per-user settings panel: the signed-in user's own-machine local model runners.
  const localModelsOpen = ref(false)
  // Per-workspace settings panel: the OpenRouter dynamic catalog (browse/enable gateway models).
  const openRouterOpen = ref(false)

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

  /** A frame shows its tasks when manually expanded OR once zoomed in to `close`
   * or any deeper band (`steps`/`subtasks` drill further into those tasks). */
  function isFrameExpanded(id: string) {
    return expandedFrames.value.has(id) || lodAtLeast(lod.value, 'close')
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
      resultView.value = { view, blockId: instance.blockId, instanceId, stepIndex }
      return
    }
    stepDetail.value = { instanceId, stepIndex }
  }

  function openDocumentConnect(source: DocumentSourceKind) {
    documentConnect.value = { source }
  }
  function closeDocumentConnect() {
    documentConnect.value = null
  }
  function openDocumentImport(
    targetFrameId: string | null = null,
    source: DocumentSourceKind | null = null,
  ) {
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
    taskConnect.value = { source }
  }
  function closeTaskConnect() {
    taskConnect.value = null
  }
  function openTaskImport(source: TaskSourceKind | null = null) {
    taskImport.value = { source }
  }
  function closeTaskImport() {
    taskImport.value = null
  }
  function openAddTask(containerId: string) {
    addTaskContainerId.value = containerId
  }
  function closeAddTask() {
    addTaskContainerId.value = null
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
    githubOpen.value = true
  }
  function closeGitHub() {
    githubOpen.value = false
  }
  function openSlack() {
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
  function openIntegrations() {
    integrationsOpen.value = true
  }
  function closeIntegrations() {
    integrationsOpen.value = false
  }
  function openWorkspaceSettings(tab = 'workspace') {
    workspaceSettingsTab.value = tab
    workspaceSettingsOpen.value = true
  }
  function closeWorkspaceSettings() {
    workspaceSettingsOpen.value = false
  }
  function setWorkspaceSettingsTab(tab: string) {
    workspaceSettingsTab.value = tab
  }
  function openObservabilityConnection() {
    observabilityConnectionOpen.value = true
  }
  function closeObservabilityConnection() {
    observabilityConnectionOpen.value = false
  }
  function openModelDefaults() {
    modelDefaultsOpen.value = true
  }
  function closeModelDefaults() {
    modelDefaultsOpen.value = false
  }
  function openVendorCredentials() {
    vendorCredentialsOpen.value = true
  }
  function closeVendorCredentials() {
    vendorCredentialsOpen.value = false
  }
  function openLocalModels() {
    localModelsOpen.value = true
  }
  function closeLocalModels() {
    localModelsOpen.value = false
  }
  function openOpenRouter() {
    openRouterOpen.value = true
  }
  function closeOpenRouter() {
    openRouterOpen.value = false
  }
  function openRequirementReview(blockId: string) {
    resultView.value = { view: 'requirements-review', blockId, instanceId: null, stepIndex: null }
  }
  function openClarityReview(blockId: string) {
    resultView.value = { view: 'clarity-review', blockId, instanceId: null, stepIndex: null }
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

  return {
    selectedBlockId,
    focusBlockId,
    builderOpen,
    decisionContext,
    documentConnect,
    documentImport,
    spawnPreview,
    taskConnect,
    taskImport,
    addTaskContainerId,
    addRecurringFrameId,
    bootstrapOpen,
    addServiceOpen,
    githubOpen,
    slackOpen,
    fragmentLibraryOpen,
    commandBarOpen,
    integrationsOpen,
    workspaceSettingsOpen,
    workspaceSettingsTab,
    observabilityConnectionOpen,
    modelDefaultsOpen,
    vendorCredentialsOpen,
    localModelsOpen,
    openRouterOpen,
    resultView,
    closeResultView,
    stepDetail,
    observabilityInstanceId,
    zoom,
    lod,
    expandedFrames,
    toggleFrame,
    expandFrame,
    isFrameExpanded,
    select,
    focus,
    openBuilder,
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
    openIntegrations,
    closeIntegrations,
    openWorkspaceSettings,
    closeWorkspaceSettings,
    setWorkspaceSettingsTab,
    openObservabilityConnection,
    closeObservabilityConnection,
    openModelDefaults,
    closeModelDefaults,
    openVendorCredentials,
    closeVendorCredentials,
    openLocalModels,
    closeLocalModels,
    openOpenRouter,
    closeOpenRouter,
    openRequirementReview,
    openClarityReview,
    closeRequirementReview,
    openStepDetail,
    closeStepDetail,
    openObservability,
    closeObservability,
  }
})
