import { describe, expect, it } from 'vitest'
import {
  createOperationalMetricsCollector,
  createRecordingLogger,
  type OperationalCounterSample,
  type OperationalGaugeSample,
} from '@cat-factory/kernel'
import { flushOperationalMetrics } from './operationalMetricsFlush.js'

function fakeSink() {
  const calls: { counters: OperationalCounterSample[]; gauges: OperationalGaugeSample[] }[] = []
  return {
    calls,
    sink: {
      exportOperational: async (
        counters: OperationalCounterSample[],
        gauges: OperationalGaugeSample[],
      ) => {
        calls.push({ counters, gauges })
      },
    },
  }
}

describe('flushOperationalMetrics', () => {
  it('drains the collector and exports counters with probed gauges', async () => {
    const collector = createOperationalMetricsCollector()
    collector.increment('container.dispatch_failed', { kind: 'container' })
    const { sink, calls } = fakeSink()

    const flushed = await flushOperationalMetrics({
      collector,
      sink,
      probeGauges: async () => [
        {
          gauge: 'queue.depth',
          dimensions: { queue: 'execution.advance', state: 'ready' },
          value: 7,
        },
      ],
      now: 1_000,
    })

    expect(flushed).toBe(2)
    expect(calls[0]!.counters[0]!.counter).toBe('container.dispatch_failed')
    expect(calls[0]!.gauges[0]!.value).toBe(7)
    // Drained: a second flush with nothing new must not re-report the same delta.
    expect(await flushOperationalMetrics({ collector, sink, now: 2_000 })).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('sends NOTHING when there is nothing to say', async () => {
    // An unflushed zero and a genuine zero are different facts, and a request-path flush on the
    // Worker runs on every invocation — so an empty flush must not cost an OTLP POST either.
    const { sink, calls } = fakeSink()
    const flushed = await flushOperationalMetrics({
      collector: createOperationalMetricsCollector(),
      sink,
      now: 1_000,
    })
    expect(flushed).toBe(0)
    expect(calls).toEqual([])
  })

  it('still exports the counters when the gauge probe throws', async () => {
    // The counters are already OUT of the collector by then, so dropping them because an
    // unrelated `COUNT(*)` failed would lose events nothing can recover.
    const collector = createOperationalMetricsCollector()
    collector.increment('sweep.run_stalled', { kind: 'execution' })
    const { sink, calls } = fakeSink()
    const logger = createRecordingLogger()

    const flushed = await flushOperationalMetrics({
      collector,
      sink,
      probeGauges: async () => {
        throw new Error('queue read failed')
      },
      now: 1_000,
      logger,
    })

    expect(flushed).toBe(1)
    expect(calls[0]!.counters).toHaveLength(1)
    expect(calls[0]!.gauges).toEqual([])
    expect(logger.lines.some((line) => line.msg.includes('gauge probe failed'))).toBe(true)
  })

  it('reports a failed export rather than swallowing it, and never throws into the caller', async () => {
    // The accepted cost of an in-memory accumulator: a failed sink loses the drained deltas.
    // That must be a logged fact, not a silent one — telemetry completeness is exactly what
    // nothing else measures.
    const collector = createOperationalMetricsCollector()
    collector.increment('cache.miss', { cache: 'workspace-settings' })
    const logger = createRecordingLogger()

    const flushed = await flushOperationalMetrics({
      collector,
      sink: {
        exportOperational: async () => {
          throw new Error('collector unreachable')
        },
      },
      now: 1_000,
      logger,
    })

    expect(flushed).toBe(0)
    const warned = logger.lines.find((line) => line.msg.includes('export failed'))
    expect(warned).toBeDefined()
    expect(warned!.fields?.counters).toBe(1)
  })
})
