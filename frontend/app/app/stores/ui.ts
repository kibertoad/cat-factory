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

  // Repo-bootstrap modal (manage reference architectures + launch a bootstrap).
  const bootstrapOpen = ref(false)

  // "Add a service from an existing GitHub repo" modal (no bootstrap run).
  const addServiceOpen = ref(false)

  // GitHub integration panel (connection management + repo/PR/issue browsing).
  const githubOpen = ref(false)

  // Prompt-fragment library panel (manage the board's best-practice catalog +
  // linked guideline repos; ADR 0006).
  const fragmentLibraryOpen = ref(false)

  // Requirements-review panel: the block whose requirements review (questions /
  // gaps / clarifications) to show, or null when closed.
  const requirementReviewBlockId = ref<string | null>(null)

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
  function openRequirementReview(blockId: string) {
    requirementReviewBlockId.value = blockId
  }
  function closeRequirementReview() {
    requirementReviewBlockId.value = null
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
    bootstrapOpen,
    addServiceOpen,
    githubOpen,
    fragmentLibraryOpen,
    requirementReviewBlockId,
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
    openBootstrap,
    closeBootstrap,
    openAddService,
    closeAddService,
    openGitHub,
    closeGitHub,
    openFragmentLibrary,
    closeFragmentLibrary,
    openRequirementReview,
    closeRequirementReview,
  }
})
