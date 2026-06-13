import type { LodLevel } from '~/types/domain'

/** Map a raw zoom factor to a level-of-detail bucket. Shared by the main board
 * and the drill-down focus view so both honour the same thresholds. */
export function zoomToLod(zoom: number): LodLevel {
  if (zoom < 0.6) return 'far'
  if (zoom < 1.2) return 'mid'
  return 'close'
}

/** Reactive LOD bound to the global UI zoom (set by the board canvas). */
export function useSemanticZoom() {
  const ui = useUiStore()
  const lod = computed<LodLevel>(() => zoomToLod(ui.zoom))
  return { lod, zoom: computed(() => ui.zoom) }
}
