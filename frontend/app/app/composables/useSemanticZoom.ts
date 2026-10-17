import type { LodLevel } from '~/types/domain'

/** The LOD scale, shallow → deep. Index order lets callers ask "is at least". */
const LOD_ORDER: LodLevel[] = ['far', 'mid', 'close', 'steps', 'subtasks']

/** The zoom each level starts at; the level holds until the next one's. */
export const LOD_MIN_ZOOM: Record<LodLevel, number> = {
  far: 0,
  mid: 0.6,
  close: 1.2,
  steps: 1.8,
  subtasks: 2.4,
}

/** Map a raw zoom factor to a level-of-detail bucket. Shared by the main board
 * and the drill-down focus view so both honour the same thresholds.
 *
 * Past `close` (where a frame opens to show its tasks) two deeper bands drill
 * into an individual task: `steps` reveals its build-pipeline steps, `subtasks`
 * expands each step's live todo breakdown — the spatial analogue of opening a
 * task in the inspector. */
export function zoomToLod(zoom: number): LodLevel {
  return LOD_ORDER.findLast((level) => zoom >= LOD_MIN_ZOOM[level]) ?? 'far'
}

/** True when `lod` is at least as deep as `min` on the LOD scale. */
export function lodAtLeast(lod: LodLevel, min: LodLevel): boolean {
  return LOD_ORDER.indexOf(lod) >= LOD_ORDER.indexOf(min)
}

/** Reactive LOD bound to the global UI zoom (set by the board canvas). */
export function useSemanticZoom() {
  const ui = useUiStore()
  const lod = computed<LodLevel>(() => zoomToLod(ui.zoom))
  return { lod, zoom: computed(() => ui.zoom) }
}
