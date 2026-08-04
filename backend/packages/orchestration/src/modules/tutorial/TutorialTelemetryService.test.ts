import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { OperationalCounter, OperationalDimensions } from '@cat-factory/kernel'
import {
  MAX_DISTINCT_TOURS,
  OTHER_TOUR,
  TutorialTelemetryService,
} from './TutorialTelemetryService.js'

function recordingMetrics() {
  const calls: { counter: OperationalCounter; dimensions: OperationalDimensions }[] = []
  return {
    calls,
    metrics: {
      increment: (counter: OperationalCounter, dimensions: OperationalDimensions = {}) => {
        calls.push({ counter, dimensions })
      },
    },
  }
}

describe('TutorialTelemetryService', () => {
  it('counts each funnel event on its own counter, dimensioned by tour', () => {
    const { calls, metrics } = recordingMetrics()
    const svc = new TutorialTelemetryService({ metrics })
    svc.record('started', 'board-basics')
    svc.record('completed', 'board-basics')
    svc.record('abandoned', 'run-task')
    expect(calls).toEqual([
      { counter: 'tutorial.tour_started', dimensions: { tour: 'board-basics' } },
      { counter: 'tutorial.tour_completed', dimensions: { tour: 'board-basics' } },
      { counter: 'tutorial.tour_abandoned', dimensions: { tour: 'run-task' } },
    ])
  })

  it('bounds the dimension, folding ids past the cap onto one bucket', () => {
    // The rule that makes a browser-supplied dimension safe. The wire schema constrains an id's
    // SHAPE, which stops junk but not VOLUME: a buggy client can emit unlimited well-formed ids,
    // and every distinct one is its own time series in the operator's backend.
    const { calls, metrics } = recordingMetrics()
    const svc = new TutorialTelemetryService({ metrics })
    for (let i = 0; i < MAX_DISTINCT_TOURS; i++) svc.record('started', `tour-${i}`)
    svc.record('started', 'one-too-many')
    expect(calls).toHaveLength(MAX_DISTINCT_TOURS + 1)
    expect(calls.at(-1)?.dimensions).toEqual({ tour: OTHER_TOUR })
    // An id ALREADY counted keeps its own series past the cap: the cap bounds how many distinct
    // values exist, and dropping a known one would make an established series go quiet instead.
    svc.record('completed', 'tour-0')
    expect(calls.at(-1)?.dimensions).toEqual({ tour: 'tour-0' })
  })

  it('reports the overflow once, naming the cap', () => {
    // A cap nobody can see reads exactly like complete coverage, so the fold is logged as well as
    // being visible in the data. Once, because it is per process and would otherwise repeat for
    // every event for the life of the deployment.
    const logger = createRecordingLogger()
    const { metrics } = recordingMetrics()
    const svc = new TutorialTelemetryService({ metrics, logger })
    for (let i = 0; i < MAX_DISTINCT_TOURS; i++) svc.record('started', `tour-${i}`)
    expect(logger.lines.filter((r) => r.level === 'warn')).toHaveLength(0)
    svc.record('started', 'over-1')
    svc.record('started', 'over-2')
    const warnings = logger.lines.filter((r) => r.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields?.limit).toBe(MAX_DISTINCT_TOURS)
  })

  it('runs without a logger', () => {
    // The service is constructed by every facade's container; a harness that passes no logger must
    // not be the reason an increment throws on an instrumentation path.
    const { metrics } = recordingMetrics()
    const svc = new TutorialTelemetryService({ metrics })
    expect(() => svc.record('started', 'board-basics')).not.toThrow()
  })
})
