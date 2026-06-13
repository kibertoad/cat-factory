import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { LodLevel } from '~/types/domain'

/** Transient UI state: selection, panels, simulation play/pause, zoom level. */
export const useUiStore = defineStore('ui', () => {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)
  const builderOpen = ref(false)
  const decisionContext = ref<{ instanceId: string; decisionId: string } | null>(null)

  // Confluence integration modals. `confluenceImport` and `spawnPreview` carry an
  // optional target frame, so structure spawned from a frame's inspector lands
  // inside that frame rather than creating new top-level frames.
  const confluenceConnectOpen = ref(false)
  const confluenceImport = ref<{ targetFrameId: string | null } | null>(null)
  const spawnPreview = ref<{ pageId: string; targetFrameId: string | null } | null>(null)

  /** Simulation clock running? */
  const simRunning = ref(true)

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

  function toggleSim() {
    simRunning.value = !simRunning.value
  }

  function openConfluenceConnect() {
    confluenceConnectOpen.value = true
  }
  function closeConfluenceConnect() {
    confluenceConnectOpen.value = false
  }
  function openConfluenceImport(targetFrameId: string | null = null) {
    confluenceImport.value = { targetFrameId }
  }
  function closeConfluenceImport() {
    confluenceImport.value = null
  }
  function openSpawnPreview(pageId: string, targetFrameId: string | null = null) {
    spawnPreview.value = { pageId, targetFrameId }
  }
  function closeSpawnPreview() {
    spawnPreview.value = null
  }

  return {
    selectedBlockId,
    focusBlockId,
    builderOpen,
    decisionContext,
    confluenceConnectOpen,
    confluenceImport,
    spawnPreview,
    simRunning,
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
    openConfluenceConnect,
    closeConfluenceConnect,
    openConfluenceImport,
    closeConfluenceImport,
    openSpawnPreview,
    closeSpawnPreview,
    toggleSim,
  }
})
