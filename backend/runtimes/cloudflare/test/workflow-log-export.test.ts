import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import { getLogSink, logger, setLogLevel, setLogSink } from '@cat-factory/server'
import { withWorkflowLogExport } from '../src/infrastructure/workflows/logExport'
import { ExecutionWorkflow } from '../src/infrastructure/workflows/ExecutionWorkflow'
import { BootstrapWorkflow } from '../src/infrastructure/workflows/BootstrapWorkflow'
import { EnvConfigRepairWorkflow } from '../src/infrastructure/workflows/EnvConfigRepairWorkflow'
import { EnvironmentTestWorkflow } from '../src/infrastructure/workflows/EnvironmentTestWorkflow'
import { GitHubBackfillWorkflow } from '../src/infrastructure/workflows/GitHubBackfillWorkflow'
import type { Env } from '../src/infrastructure/env'

// The WORKFLOW half of the Worker's OTLP log export (`log-export-wiring.test.ts` covers the
// request/cron/queue half). Two properties, and the second is the one the gap was made of:
//
//   1. A wake installs the sink for its own isolate. A `WorkflowEntrypoint` is instantiated by
//      workerd in an isolate no other entry point has run in, so nothing else can have.
//   2. A wake drains BEFORE each durable wait, not only at the end. `step.sleep` /
//      `step.waitForEvent` give the isolate back and the buffer goes with it, so a driver that
//      polls for hours would otherwise export its last wake and lose every one before it. A
//      `step.do` attempt that THREW is the third such wait (the engine holds the instance for
//      the step's retry backoff, and can evict it there) and the one that reads as safe.
//
// The per-class cases at the bottom drive the REAL five entrypoints rather than asserting on
// their source: each gets its own collector endpoint, so a POST arriving there is proof that
// THAT class's wake both installed the sink and drained it.

/**
 * A collector endpoint of this case's OWN, because the installed exporter is module state keyed
 * by endpoint and outlives a test. A POST arriving at one of these therefore cannot have come
 * from a sibling case's sink, which is what lets each case assert that the code under test
 * installed one rather than inheriting one.
 */
function endpointFor(name: string): string {
  return `http://collector-${name.toLowerCase()}.test:4318`
}

/** Everything the capturing `fetch` and the fake step append to, in order. Reset per test. */
const trace: string[] = []
const bodies: string[] = []
const urls: string[] = []

/**
 * Stubbed globally rather than injected: a workflow reaches the exporter through
 * `applyLogSettings`, which takes no deps: that IS the seam under test. Installed once, since
 * the exporter captures `fetch` at construction and the module-level exporter outlives a test.
 */
vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
  urls.push(String(url))
  bodies.push(String(init?.body))
  trace.push('post')
  return new Response('', { status: 200 })
}) as unknown as typeof fetch)

function envFor(endpoint: string): Env {
  return {
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_LOGS: 'true',
  } as unknown as Env
}

/**
 * A `WorkflowStep` that records what it was asked to do instead of suspending. `maxSleeps`
 * bounds a wake: the real drivers poll until a budget is spent, and a fake sleep that always
 * resolves would run every one of those iterations here for nothing.
 */
function fakeStep(maxSleeps = Number.POSITIVE_INFINITY): WorkflowStep {
  let sleeps = 0
  return {
    do: (async (name: string, configOrRun: unknown, maybeRun?: unknown) => {
      trace.push(`do:${name}`)
      logger.warn('workflow-probe', { at: `do:${name}` })
      const run = (typeof configOrRun === 'function' ? configOrRun : maybeRun) as (
        ctx?: unknown,
      ) => Promise<unknown>
      // `return await`, not `return`: a bare return hands the callback's promise back for the
      // caller to adopt a turn later, and workerd flags the gap as an unhandled rejection when
      // (as here) the callback throws.
      return await run()
    }) as unknown as WorkflowStep['do'],
    sleep: async (name) => {
      trace.push(`sleep:${name}`)
      logger.warn('workflow-probe', { at: `sleep:${name}` })
      if (++sleeps >= maxSleeps) throw new Error('test: wake bounded')
    },
    sleepUntil: async (name) => {
      trace.push(`sleepUntil:${name}`)
    },
    waitForEvent: (async (name: string) => {
      trace.push(`wait:${name}`)
      return { payload: {}, timestamp: new Date(), instanceId: 'test' }
    }) as unknown as WorkflowStep['waitForEvent'],
  }
}

/** The event shape every driver reads its payload off; one bag covers all five. */
function fakeEvent(): WorkflowEvent<never> {
  return {
    payload: {
      workspaceId: 'ws_test',
      executionId: 'ex_test',
      jobId: 'job_test',
      installationId: 1,
    },
    timestamp: new Date(),
    instanceId: 'wf_test',
  } as unknown as WorkflowEvent<never>
}

beforeEach(() => {
  trace.length = 0
  bodies.length = 0
  urls.length = 0
  // Exception to the suite-wide `setLogLevel('silent')` (`test/setup/silenceLogs.ts`), for the same
  // reason `log-export-wiring.test.ts` states: the sink is behind the same level gate, and every
  // assertion below reads a line this file emitted. Stated rather than relied on — silenced, these
  // would assert on lines that were never produced.
  setLogLevel('info')
})

afterEach(() => {
  setLogSink(null)
  setLogLevel('silent')
})
afterAll(() => vi.unstubAllGlobals())

describe('withWorkflowLogExport', () => {
  it('installs the sink for the wake’s isolate and drains before every durable suspension', async () => {
    const endpoint = endpointFor('suspensions')

    await withWorkflowLogExport(envFor(endpoint), fakeStep(), async (step) => {
      logger.warn('line before the sleep')
      await step.sleep('poll-wait-0', '30 seconds')
      logger.warn('line before the park')
      await step.waitForEvent('await-decision', { type: 'decision-d1' })
      logger.warn('line after the park')
    })

    expect(getLogSink()).not.toBeNull()
    // A POST in FRONT of each suspension, and a last one for what the body logged after the
    // final suspension. The ordering is the assertion: a drain that only ran at the end would
    // read as one trailing `post`.
    expect(trace).toEqual(['post', 'sleep:poll-wait-0', 'post', 'wait:await-decision', 'post'])
    // …and each drain carried the lines emitted since the previous one, rather than the whole
    // wake arriving at the end.
    expect(bodies[0]).toContain('line before the sleep')
    expect(bodies[0]).not.toContain('line before the park')
    expect(bodies[1]).toContain('line before the park')
    expect(urls).toEqual([`${endpoint}/v1/logs`, `${endpoint}/v1/logs`, `${endpoint}/v1/logs`])
  })

  it('drains a wake that ends by THROWING, which is when its lines matter most', async () => {
    await expect(
      withWorkflowLogExport(envFor(endpointFor('throwing')), fakeStep(), async () => {
        logger.error('the run died here')
        throw new Error('wake failed')
      }),
    ).rejects.toThrow('wake failed')

    expect(bodies.join('')).toContain('the run died here')
  })

  it('delegates `do` to the step workerd passed, keeping its own `this`', async () => {
    const seen: string[] = []
    const real = {
      marker: 'the real step',
      do(this: { marker: string }, _name: string, run: () => Promise<unknown>) {
        // A wrapper on the prototype chain would hand `this` to the WRAPPER here, so anything
        // the host object writes through `this` would land on it and be lost with the wake.
        seen.push(this.marker)
        return run()
      },
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async () => ({}),
    } as unknown as WorkflowStep

    await withWorkflowLogExport(envFor(endpointFor('delegation')), real, (step) =>
      step.do('work', async () => undefined),
    )

    expect(seen).toEqual(['the real step'])
  })

  it('drains a `do` attempt that THREW, before the engine’s retry backoff can evict it', async () => {
    await withWorkflowLogExport(envFor(endpointFor('do-failure')), fakeStep(), async (step) => {
      await step
        .do('advance-0', { retries: { limit: 3, delay: '5 seconds' } }, async (): Promise<void> => {
          logger.error('why the attempt failed')
          throw new Error('attempt failed')
        })
        .catch(() => {
          // silent-catch-ok: the driver's own handling of an exhausted step is not what this
          // asserts; the drain has already happened by the time the rejection surfaces here.
        })
      trace.push('the backoff would start here')
    })

    // The drain sits INSIDE the failing attempt, so its POST lands before the rejection is handed
    // back to the engine. Deferring to the `finally` would read as a trailing `post` instead, and
    // an eviction during the backoff would have taken those lines with it.
    expect(trace).toEqual(['do:advance-0', 'post', 'the backoff would start here'])
    expect(bodies[0]).toContain('why the attempt failed')
  })

  it('leaves a `do` that SUCCEEDED un-drained: its lines ride the next wait', async () => {
    await withWorkflowLogExport(envFor(endpointFor('do-success')), fakeStep(), async (step) => {
      await step.do('advance-0', async (): Promise<void> => {
        logger.warn('a line from a step that worked')
      })
      logger.warn('a line after the step returned')
      await step.sleep('poll-wait-0', '30 seconds')
    })

    // ONE POST in front of the sleep, carrying both lines. A wrapper that drained every `do`
    // would split them across two, buying a collector round-trip per step for lines the next
    // wait was always going to carry.
    expect(trace).toEqual(['do:advance-0', 'post', 'sleep:poll-wait-0', 'post'])
    expect(bodies[0]).toContain('a line from a step that worked')
    expect(bodies[0]).toContain('a line after the step returned')
  })

  it('installs nothing and posts nothing when the deployment has not opted in', async () => {
    await withWorkflowLogExport({} as Env, fakeStep(), async (step) => {
      logger.warn('a line nobody exports')
      await step.sleep('poll-wait-0', '30 seconds')
    })

    expect(getLogSink()).toBeNull()
    expect(trace).toEqual(['sleep:poll-wait-0'])
  })
})

/** Every `WorkflowEntrypoint` the facade exports. A sixth one belongs here the day it lands. */
const WORKFLOWS = [
  ExecutionWorkflow,
  BootstrapWorkflow,
  EnvConfigRepairWorkflow,
  EnvironmentTestWorkflow,
  GitHubBackfillWorkflow,
]

/**
 * The real `run` of a real workflow class, over a fake `this` carrying only `env`.
 *
 * Built with `Object.create` rather than `new`, because a `WorkflowEntrypoint` constructor is
 * workerd's own and takes a genuine `ExecutionContext` that nothing in the test pool can mint
 * (`createExecutionContext()` is for handler invocation and is refused here). Skipping the
 * constructor costs nothing that matters: `run` reads only `this.env` plus its own prototype
 * methods, so what runs below is each class's real driver, not a stand-in for it.
 */
function wakeOf(Workflow: { prototype: object }, env: Env): (step: WorkflowStep) => Promise<void> {
  const instance = Object.create(Workflow.prototype) as {
    env: Env
    run(event: WorkflowEvent<never>, step: WorkflowStep): Promise<unknown>
  }
  instance.env = env
  return async (step) => {
    // The wake is EXPECTED to fail: there are no bindings, and the fake step's sleep budget cuts
    // a poll loop short. Which failure it is belongs to each driver's own tests; this one asserts
    // what happens to its lines, which is the same obligation however it ends.
    await Promise.resolve(instance.run(fakeEvent(), step)).catch(() => {})
  }
}

describe('every WorkflowEntrypoint exports its wake', () => {
  for (const Workflow of WORKFLOWS) {
    it(`${Workflow.name} installs the sink and drains what it logged`, async () => {
      const endpoint = endpointFor(Workflow.name)

      await wakeOf(Workflow, envFor(endpoint))(fakeStep(3))

      expect(urls).toContain(`${endpoint}/v1/logs`)
      expect(bodies.join('')).toContain('workflow-probe')
    })
  }
})
