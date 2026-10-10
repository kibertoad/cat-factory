import { describe, expect, it, vi } from 'vitest'
import { useSingleFlight } from '~/composables/useSingleFlight'

describe('useSingleFlight', () => {
  it('joins concurrent callers of one key onto a single call', async () => {
    const fn = vi.fn(() => Promise.resolve('answer'))
    const flight = useSingleFlight<string, string>()

    const [a, b] = await Promise.all([flight.run('k', fn), flight.run('k', fn)])
    expect(fn).toHaveBeenCalledTimes(1)
    expect([a, b]).toEqual(['answer', 'answer'])
  })

  it('keeps different keys apart', async () => {
    const fn = vi.fn((k: string) => Promise.resolve(k))
    const flight = useSingleFlight<string, string>()

    await Promise.all([flight.run('a', () => fn('a')), flight.run('b', () => fn('b'))])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('coalesces rather than caches: a later call runs again', async () => {
    const fn = vi.fn(() => Promise.resolve('answer'))
    const flight = useSingleFlight<string, string>()

    await flight.run('k', fn)
    expect(flight.isRunning('k')).toBe(false)
    await flight.run('k', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('gives every joiner the same failure, and lets the next caller retry', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom')))
    const flight = useSingleFlight<string, string>()

    const results = await Promise.allSettled([flight.run('k', fn), flight.run('k', fn)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(fn).toHaveBeenCalledTimes(1)

    await expect(flight.run('k', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})
