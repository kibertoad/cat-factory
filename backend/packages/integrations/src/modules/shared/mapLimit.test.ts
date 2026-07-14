import { describe, expect, it } from 'vitest'
import { mapLimit } from './mapLimit.js'

describe('mapLimit', () => {
  it('preserves input order in the result regardless of completion order', async () => {
    // Later items resolve sooner, so a naive push-on-settle would reorder them.
    const out = await mapLimit([30, 20, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([30, 20, 10])
  })

  it('never runs more than `limit` tasks concurrently', async () => {
    let inFlight = 0
    let max = 0
    await mapLimit(
      Array.from({ length: 10 }, (_v, i) => i),
      3,
      async () => {
        inFlight++
        max = Math.max(max, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
      },
    )
    expect(max).toBe(3)
  })

  it('still processes every item when limit exceeds the item count', async () => {
    const out = await mapLimit([1, 2], 10, async (n) => n * 2)
    expect(out).toEqual([2, 4])
  })

  it('is a no-op on an empty list', async () => {
    expect(await mapLimit([], 4, async (n) => n)).toEqual([])
  })
})
