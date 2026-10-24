import { describe, expect, it } from 'vitest'
import { LOD_MIN_ZOOM, zoomToLod } from './useSemanticZoom'

describe('zoomToLod', () => {
  it.each([
    [0.2, 'far'],
    [0.59, 'far'],
    [0.6, 'mid'],
    [1.19, 'mid'],
    [1.2, 'close'],
    [1.8, 'steps'],
    [2.39, 'steps'],
    [2.4, 'subtasks'],
    [3, 'subtasks'],
  ] as const)('reads zoom %s as %s', (zoom, lod) => {
    expect(zoomToLod(zoom)).toBe(lod)
  })

  it('starts each level at its LOD_MIN_ZOOM', () => {
    for (const [lod, zoom] of Object.entries(LOD_MIN_ZOOM)) expect(zoomToLod(zoom)).toBe(lod)
  })
})
