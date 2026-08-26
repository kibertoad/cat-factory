import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createPassClient, describeStepTransitions } from './client.js'
import type { StepObservation } from './client.js'

const TARGET = { baseUrl: 'https://deployment.invalid', apiKey: 'cfk_test' }

/**
 * A deployment that refuses `failures` connections and then answers.
 *
 * The refusal is the shape a restart actually produces (a transport failure with no response), which
 * is both what the raised budget exists to absorb and what the SDK will replay on a `GET`.
 *
 * Installed on `globalThis` rather than passed as the client's `fetch` option, because that option
 * is how a suite's extra headers ride and a client built WITHOUT any must reach the real global.
 * The SDK binds it at construction, so every client here is built after the stub is in place.
 */
function deploymentRefusing(failures: number): { calls: () => number } {
  let calls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls += 1
    if (calls <= failures) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
          code: 'ECONNREFUSED',
        }),
      })
    }
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls: () => calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// Three refusals then an answer is the one population that tells the two budgets apart at their
// cheapest: the SDK default gives up on it and the pass budget rides through it, with the whole
// backoff ladder under two seconds.
describe('the two retry budgets', () => {
  it('refuses fast before a pass has spent anything', async () => {
    // The budget a preflight probe runs on, and the reason it is the SDK's default rather than a
    // raised one: a dozen checks run in sequence and none bails early, so a deployment that is not
    // running is reported in seconds instead of once every probe has climbed its own ladder.
    const deployment = deploymentRefusing(3)
    await expect(createClient(TARGET).models.list()).rejects.toThrow()
    expect(deployment.calls()).toBe(3)
  })

  it('rides through a restart once a pass has an hour of work at stake', async () => {
    const deployment = deploymentRefusing(3)
    await expect(createPassClient(TARGET).models.list()).resolves.toEqual({ models: [] })
    expect(deployment.calls()).toBe(4)
  })

  it('never replays a write, on either budget', async () => {
    // The property that makes any budget here safe to raise: answering a decision costs real LLM
    // work and a replayed `POST` would answer it twice. It is the SDK's rule rather than ours, so
    // this asserts the rule still holds through the client we build rather than restating it.
    const deployment = deploymentRefusing(1)
    await expect(
      createPassClient(TARGET).tasks.create('svc_1', { title: 'x', taskType: 'feature' }),
    ).rejects.toThrow()
    expect(deployment.calls()).toBe(1)
  })
})

describe('the header seam', () => {
  it('re-reads the headers on EVERY request, which is what a per-user credential needs', async () => {
    // The reason this is a function rather than a record: the credential is not known until a call
    // has already been refused for want of it, and must then ride every later request. Snapshotted
    // at construction (which is what the SDK's own `headers` option does), the client built before
    // the refusal would go on sending none.
    const sent: (string | undefined)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(new Headers(init?.headers).get('x-unlock') ?? undefined)
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    let held: Record<string, string> = {}
    const client = createClient(TARGET, { headers: () => held })
    await client.models.list()
    held = { 'x-unlock': 'held' }
    await client.models.list()
    expect(sent).toEqual([undefined, 'held'])
  })
})

describe('describeStepTransitions', () => {
  const chain = (...states: string[]): StepObservation[] =>
    states.map((state, index) => ({ agentKind: `k${index}`, state }))

  it('announces nothing on the first look, so a fresh chain is a baseline and not eleven events', () => {
    expect(describeStepTransitions(undefined, chain('working', 'pending'))).toEqual([])
  })

  it('names a step that started AND finished between two polls', () => {
    // The regression this function exists for. A `deployer` finished in one second against a
    // ten-second poll, so `describeRun` printed step 3 and then step 5 and nothing ever said the
    // deployer ran, which is exactly how the failure that followed got attributed to the wrong
    // layer. Sampling `currentStep` cannot catch this at any cadence; diffing the chain always does.
    const before: StepObservation[] = [
      { agentKind: 'reviewer', state: 'working' },
      { agentKind: 'deployer', state: 'pending' },
      { agentKind: 'tester-api', state: 'pending' },
    ]
    const after: StepObservation[] = [
      { agentKind: 'reviewer', state: 'done' },
      { agentKind: 'deployer', state: 'done' },
      { agentKind: 'tester-api', state: 'working' },
    ]
    expect(describeStepTransitions(before, after)).toEqual([
      "step 0 'reviewer': working -> done",
      "step 1 'deployer': pending -> done",
      "step 2 'tester-api': pending -> working",
    ])
  })

  it('says SKIPPED rather than done, which is the one thing a done state cannot tell a reader', () => {
    const before: StepObservation[] = [{ agentKind: 'tester-ui', state: 'pending' }]
    const after: StepObservation[] = [{ agentKind: 'tester-ui', state: 'done', skipped: true }]
    expect(describeStepTransitions(before, after)).toEqual([
      "step 0 'tester-ui': pending -> skipped",
    ])
  })

  it('reports a step that moved BACKWARDS, which a high-water mark would hide', () => {
    // A companion bouncing its producer is a real transition and the one a reader most needs
    // named: without it the run looks stalled on a step it already passed.
    const before: StepObservation[] = [{ agentKind: 'architect', state: 'done' }]
    const after: StepObservation[] = [{ agentKind: 'architect', state: 'working' }]
    expect(describeStepTransitions(before, after)).toEqual(["step 0 'architect': done -> working"])
  })

  it('stays quiet when nothing moved, so a long working step does not repeat itself every poll', () => {
    const steps = chain('done', 'working')
    expect(describeStepTransitions(steps, chain('done', 'working'))).toEqual([])
    expect(steps).toHaveLength(2)
  })

  it('treats a step the chain GREW as having no baseline rather than as a change', () => {
    // A companion or an auto-inserted gate lengthens the chain mid-run. The new tail has no prior
    // state, and announcing `undefined -> pending` for it would be noise, not an event.
    expect(describeStepTransitions(chain('working'), chain('working', 'pending'))).toEqual([])
  })
})
