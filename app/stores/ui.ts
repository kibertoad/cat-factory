import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DocumentSourceKind, LodLevel } from '~/types/domain'

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

  // Repo-bootstrap modal (manage reference architectures + launch a bootstrap).
  const bootstrapOpen = ref(false)

  // GitHub integration panel (connection management + repo/PR/issue browsing).
  const githubOpen = ref(false)

  /** Current canvas zoom (driven by Vue Flow viewport). */
  const zoom = ref(1)

  const lod = computed<LodLevel>(() => {
    if (zoom.value < 0.6) return 'far'
    if (zoom.value < 1.2) return 'mid'
    return 'close'
  })

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

  /** A frame shows its tasks when manually expanded OR when zoomed in close. */
  function isFrameExpanded(id: string) {
    return expandedFrames.value.has(id) || lod.value === 'close'
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
  function openBootstrap() {
    bootstrapOpen.value = true
  }
  function closeBootstrap() {
    bootstrapOpen.value = false
  }
  function openGitHub() {
    githubOpen.value = true
  }
  function closeGitHub() {
    githubOpen.value = false
  }

  return {
    selectedBlockId,
    focusBlockId,
    builderOpen,
    decisionContext,
    documentConnect,
    documentImport,
    spawnPreview,
    bootstrapOpen,
    githubOpen,
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
    openBootstrap,
    closeBootstrap,
    openGitHub,
    closeGitHub,
  }
})
