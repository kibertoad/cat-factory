import { describe, expect, it } from 'vitest'
import { resolveInfraReachabilityConfig, shouldRunReachabilityPass } from './infraReachability.js'

const TICK = 2 * 60_000

describe('resolveInfraReachabilityConfig', () => {
  it('defaults and clamps both durations', () => {
    expect(resolveInfraReachabilityConfig({ enabled: true })).toEqual({
      enabled: true,
      intervalMs: 5 * 60_000,
      probeTimeoutMs: 5_000,
    })
    // A `0`/tiny interval would turn the sweep into an outbound busy-loop; a sub-second probe
    // budget would report every healthy-but-distant apiserver as an outage.
    const clamped = resolveInfraReachabilityConfig({
      enabled: true,
      intervalMs: '0',
      probeTimeoutMs: '10',
    })
    expect(clamped.intervalMs).toBe(30_000)
    expect(clamped.probeTimeoutMs).toBe(1_000)
    expect(
      resolveInfraReachabilityConfig({ enabled: true, probeTimeoutMs: '600000' }).probeTimeoutMs,
    ).toBe(60_000)
  })

  it('falls back to the defaults for garbage and negatives', () => {
    const cfg = resolveInfraReachabilityConfig({
      enabled: false,
      intervalMs: 'soon',
      probeTimeoutMs: '-1',
    })
    expect(cfg).toEqual({ enabled: false, intervalMs: 5 * 60_000, probeTimeoutMs: 5_000 })
  })
})

describe('shouldRunReachabilityPass', () => {
  it('runs on every tick when the interval is at or below the tick period', () => {
    // What a Node deployment with the same setting gets from its timer.
    for (let i = 0; i < 5; i++) {
      expect(shouldRunReachabilityPass(i * TICK, TICK, TICK)).toBe(true)
      expect(shouldRunReachabilityPass(i * TICK, TICK, 30_000)).toBe(true)
    }
  })

  it('runs at most once per interval window across a run of cron ticks', () => {
    // The operator's cadence knob has to mean something on the Worker too: opting in bought a fixed
    // 2-minute probe cadence before this gate, on the one sweep that calls out per workspace.
    const intervalMs = 10 * 60_000
    const ticks = Array.from({ length: 60 }, (_, i) => i * TICK)
    const ran = ticks.filter((t) => shouldRunReachabilityPass(t, TICK, intervalMs))
    expect(ran.length).toBe(12)
    for (let i = 1; i < ran.length; i++) {
      expect(ran[i]! - ran[i - 1]!).toBe(intervalMs)
    }
  })

  it('averages the requested interval even when it is not a multiple of the tick', () => {
    const intervalMs = 5 * 60_000
    const ticks = Array.from({ length: 60 }, (_, i) => i * TICK)
    const ran = ticks.filter((t) => shouldRunReachabilityPass(t, TICK, intervalMs))
    // 120 minutes of ticks, one pass per 5-minute window: never more often than asked for.
    expect(ran.length).toBe(24)
    for (let i = 1; i < ran.length; i++) {
      expect(ran[i]! - ran[i - 1]!).toBeGreaterThanOrEqual(4 * 60_000)
    }
  })
})
