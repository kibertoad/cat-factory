import { describe, expect, it, vi } from 'vitest'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'

// Single-flight probe guard (app-startup initiative, item 12). Pure logic, no Pinia/Nuxt: a fake
// `run` (counting calls, with a manually-resolved promise) and a mutable `id` getter.

/** A `run` whose promise the test resolves by hand, plus a call counter. */
function deferredRun() {
  let resolve!: () => void
  const calls = { count: 0 }
  const run = vi.fn(() => {
    calls.count++
    return new Promise<void>((r) => (resolve = r))
  })
  return { run, calls, resolve: () => resolve() }
}

describe('useSingleFlightProbe', () => {
  it('coalesces concurrent probe() calls for the same board into one run', async () => {
    const { run, calls, resolve } = deferredRun()
    const { probe } = useSingleFlightProbe(run, () => 'ws1')

    const a = probe()
    const b = probe()
    expect(calls.count).toBe(1) // one in-flight run shared by both callers
    resolve()
    await Promise.all([a, b])
  })

  it('ensureProbed() is a no-op once the board is already probed', async () => {
    const { run, calls, resolve } = deferredRun()
    const { ensureProbed } = useSingleFlightProbe(run, () => 'ws1')

    const first = ensureProbed()
    resolve()
    await first
    expect(calls.count).toBe(1)

    await ensureProbed() // already settled for ws1 → does not run again
    expect(calls.count).toBe(1)
  })

  it('ensureProbed() re-runs when the workspace id changes', async () => {
    const { run, calls, resolve } = deferredRun()
    let id = 'ws1'
    const { ensureProbed } = useSingleFlightProbe(run, () => id)

    const first = ensureProbed()
    resolve()
    await first
    expect(calls.count).toBe(1)

    id = 'ws2' // a switch — connections are per board, so it must re-probe
    const second = ensureProbed()
    resolve()
    await second
    expect(calls.count).toBe(2)
  })

  it('probe() always re-runs (a deliberate refresh) even after a completed probe', async () => {
    const { run, calls, resolve } = deferredRun()
    const guard = useSingleFlightProbe(run, () => 'ws1')

    const first = guard.probe()
    resolve()
    await first
    expect(calls.count).toBe(1)

    const refresh = guard.probe() // e.g. after a connect — re-reads
    resolve()
    await refresh
    expect(calls.count).toBe(2)
  })

  it('a probe() refresh in flight is shared by a concurrent ensureProbed()', async () => {
    const { run, calls, resolve } = deferredRun()
    const guard = useSingleFlightProbe(run, () => 'ws1')

    const refresh = guard.probe()
    const ensured = guard.ensureProbed() // rides the in-flight probe rather than firing a duplicate
    expect(calls.count).toBe(1)
    resolve()
    await Promise.all([refresh, ensured])
  })
})
