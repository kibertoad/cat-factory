import { describe, expect, it } from 'vitest'
import { createOperationalMetricsCollector, noopOperationalMetrics } from './operational-metrics.js'

// The collector is the whole seam's correctness: every counter in the platform funnels through
// it, and the two properties below are what make DELTA export honest across a process restart
// or an isolate eviction.

describe('createOperationalMetricsCollector', () => {
  it('accumulates by counter and dimension set', () => {
    const metrics = createOperationalMetricsCollector()
    metrics.increment('container.evicted', { kind: 'crash' })
    metrics.increment('container.evicted', { kind: 'crash' })
    metrics.increment('container.evicted', { kind: 'transient' })
    metrics.increment('cache.hit', { cache: 'repo-projection' }, 5)

    const samples = metrics.drain()
    expect(samples).toHaveLength(3)
    expect(samples).toContainEqual({
      counter: 'container.evicted',
      dimensions: { kind: 'crash' },
      value: 2,
    })
    expect(samples).toContainEqual({
      counter: 'container.evicted',
      dimensions: { kind: 'transient' },
      value: 1,
    })
    expect(samples).toContainEqual({
      counter: 'cache.hit',
      dimensions: { cache: 'repo-projection' },
      value: 5,
    })
  })

  it('treats dimension maps with the same entries as one series regardless of key order', () => {
    // Two call sites that build the same dimensions in different orders must not produce two
    // time series — an operator summing a dashboard would see the counter split in half.
    const metrics = createOperationalMetricsCollector()
    metrics.increment('sweep.run_redriven', { kind: 'execution', sweep: 'stale-run' })
    metrics.increment('sweep.run_redriven', { sweep: 'stale-run', kind: 'execution' })
    const samples = metrics.drain()
    expect(samples).toHaveLength(1)
    expect(samples[0]!.value).toBe(2)
  })

  it('RESETS on drain, so two flushers never double-report the same events', () => {
    // This is what makes delta temporality correct: whoever drains owns a set of deltas nobody
    // else will report. A second drain of the same events would inflate every dashboard.
    const metrics = createOperationalMetricsCollector()
    metrics.increment('telemetry.export_dropped', { operation: 'recordGeneration' })
    expect(metrics.drain()).toHaveLength(1)
    expect(metrics.drain()).toEqual([])
  })

  it('drains empty when nothing happened, rather than reporting zeroes', () => {
    // An unflushed zero and a genuine zero are different facts. Only the ABSENCE of a data
    // point states the first one honestly, so an idle collector must produce no samples at all.
    expect(createOperationalMetricsCollector().drain()).toEqual([])
  })

  it('counts into the void through the noop, without throwing', () => {
    expect(() =>
      noopOperationalMetrics.increment('telemetry.export_dropped', { operation: 'x' }),
    ).not.toThrow()
  })
})
