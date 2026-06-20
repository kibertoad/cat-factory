import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DocumentSourceKind, TaskSourceKind, LodLevel } from '~/types/domain'
import { zoomToLod, lodAtLeast } from '~/composables/useSemanticZoom'

/** Transient UI state: selection, panels, zoom level. */
export const useUiStore = defineStore('ui', () => {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)
  const builderOpen = ref(false)
  const decisionContext = ref<{ instanceId: string; decisionId: string } | null>(null)
  // Approval-gate modal: the run + gate a human is reviewing, or null when closed.
  const approvalContext = ref<{ instanceId: string; approvalId: string } | null>(null)

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

  // Prompt-fragment library panel (manage the board's best-practice catalog +
  // linked guideline repos; ADR 0006).
  const fragmentLibraryOpen = ref(false)

  // Command bar (⌘K) — searchable launcher for every navbar action.
  const commandBarOpen = ref(false)

  // Workspace-settings panels: merge-threshold preset library + per-agent-kind
  // default model overrides.
  const mergeThresholdsOpen = ref(false)
  const modelDefaultsOpen = ref(false)

  // Requirements-review panel: the block whose requirements review (questions /
  // gaps / clarifications) to show, or null when closed.
  const requirementReviewBlockId = ref<string | null>(null)

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

  function openApproval(instanceId: string, approvalId: string) {
    approvalContext.value = { instanceId, approvalId }
  }
  function closeApproval() {
    approvalContext.value = null
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
  function openMergeThresholds() {
    mergeThresholdsOpen.value = true
  }
  function closeMergeThresholds() {
    mergeThresholdsOpen.value = false
  }
  function openModelDefaults() {
    modelDefaultsOpen.value = true
  }
  function closeModelDefaults() {
    modelDefaultsOpen.value = false
  }
  function openRequirementReview(blockId: string) {
    requirementReviewBlockId.value = blockId
  }
  function closeRequirementReview() {
    requirementReviewBlockId.value = null
  }
  function openStepDetail(instanceId: string, stepIndex: number) {
    stepDetail.value = { instanceId, stepIndex }
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
    approvalContext,
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
    fragmentLibraryOpen,
    commandBarOpen,
    mergeThresholdsOpen,
    modelDefaultsOpen,
    requirementReviewBlockId,
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
    openApproval,
    closeApproval,
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
    openFragmentLibrary,
    closeFragmentLibrary,
    openCommandBar,
    closeCommandBar,
    toggleCommandBar,
    openMergeThresholds,
    closeMergeThresholds,
    openModelDefaults,
    closeModelDefaults,
    openRequirementReview,
    closeRequirementReview,
    openStepDetail,
    closeStepDetail,
    openObservability,
    closeObservability,
  }
})
