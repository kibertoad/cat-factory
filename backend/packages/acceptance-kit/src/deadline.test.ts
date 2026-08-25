import { CatFactoryApiError } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { formatDuration, formatExpiry, formatOutage, waitFor } from './deadline.js'
import { deploymentOutageTolerance } from './deploymentOutage.js'
import { sdkRefusedAfter, sdkTransportFailure } from './testing/sdkFailures.js'

// The transport failures below are DRIVEN through a real SDK client rather than built here, because
// the probe a tolerance actually reads is `client.tasks.getRun(...)`: the kit never calls `fetch`
// itself, so a bare undici `TypeError` is a shape no wait in this suite can be handed. It stopped
// being a distinction without a difference when the SDK began composing its own message (ADR 0060),
// which is what an expiry quotes.

/** A deployment that stopped listening, seen by a client it had been answering. */
function refusedConnection(): Promise<Error> {
  return sdkRefusedAfter(3)
}

/** The same, for a cause that is a CONFIGURATION fault rather than a restart. */
function transportFailure(code: string, message: string): Promise<Error> {
  return sdkTransportFailure({ message, code, answeredCalls: 3 })
}

/**
 * A refusal in the shape the SDK actually throws, which is the whole point of building one here.
 *
 * A plain `Error` carrying a `status` property does NOT reach the answered branch: nothing
 * classifies it, so it lands in `unanswered`/`unknown` and is rethrown by the excluded-cause arm.
 * That still rejects, so a test written that way passes while the branch it names goes unrun.
 */
function apiRefusal(status: number, code: string, message: string): CatFactoryApiError {
  return new CatFactoryApiError({
    status,
    code,
    message,
    requestId: 'req_19312e8862264172b1fa1051',
    body: { error: { code, message } },
  })
}

describe('waitFor', () => {
  it("returns the probe's value as soon as it is done", async () => {
    let calls = 0
    const value = await waitFor<string>({
      label: 'a thing',
      budgetMs: 1000,
      intervalMs: 1,
      probe: async () => {
        calls += 1
        return calls < 3 ? { done: false, state: `attempt ${calls}` } : { done: true, value: 'ok' }
      },
    })
    expect(value).toBe('ok')
    expect(calls).toBe(3)
  })

  it('carries the LAST observation into the expiry, which is the whole point of this module', async () => {
    // A wait that expires reporting only a duration is indistinguishable from every other stall,
    // and this suite's waits are an hour long. If a refactor ever throws a generic timeout here,
    // this is the test that says so.
    await expect(
      waitFor({
        label: 'the run to settle',
        budgetMs: 5,
        intervalMs: 1,
        probe: async () => ({ done: false, state: "step 3 'coder' working" }),
      }),
    ).rejects.toThrow(/step 3 'coder' working/)
  })

  it('never sleeps past its own deadline', async () => {
    // Checked BEFORE the sleep rather than after, so an expiry reports the budget it was given
    // rather than the budget plus one whole poll interval.
    const startedAt = Date.now()
    await waitFor({
      label: 'x',
      budgetMs: 30,
      intervalMs: 25,
      probe: async () => ({ done: false, state: 'still going' }),
    }).catch(() => undefined)
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('waits through a deployment that stops answering, and reports it as an observation', async () => {
    // The regression this exists for: a scaffold run 41 minutes in, its coder and reviewer done
    // and a pull request open, died because the deployment cycled between two polls. The run was
    // fine; the watcher was not.
    const seen: string[] = []
    let calls = 0
    const value = await waitFor<string>({
      label: 'the run to settle',
      budgetMs: 1000,
      intervalMs: 1,
      tolerate: deploymentOutageTolerance(500),
      onProgress: (state) => seen.push(state),
      probe: async () => {
        calls += 1
        if (calls <= 2) throw await refusedConnection()
        return { done: true, value: 'settled' }
      },
    })
    expect(value).toBe('settled')
    expect(seen.some((state) => state.includes('refused'))).toBe(true)
    // The recovery is stated too: a gap in the observations with no line explaining it is how a
    // restart becomes invisible in the journal an operator reads an hour later.
    expect(seen.some((state) => state.includes('answered again'))).toBe(true)
  })

  it('gives up on an outage that outlasts its grace, saying the run may be fine', async () => {
    await expect(
      waitFor({
        label: 'the run to settle',
        budgetMs: 60_000,
        intervalMs: 1,
        tolerate: deploymentOutageTolerance(5),
        probe: async () => {
          throw await refusedConnection()
        },
      }),
    ).rejects.toThrow(/stopped answering[\s\S]*ECONNREFUSED[\s\S]*run itself may well be fine/)
  })

  it('keeps the last ANSWERED observation, rather than the outage that followed it', async () => {
    // The rule this module exists for, defended against its own tolerance: "the deployment did not
    // answer" is not evidence about the run, so an expiry that reported it would have thrown away
    // the only thing worth reading while still telling its reader to go and look at the run.
    let calls = 0
    await expect(
      waitFor({
        label: 'the run to settle',
        budgetMs: 40,
        intervalMs: 1,
        tolerate: deploymentOutageTolerance(60_000),
        probe: async () => {
          calls += 1
          if (calls === 1) return { done: false, state: "step 3 'coder' working" }
          throw await refusedConnection()
        },
      }),
    ).rejects.toThrow(/Last observed: step 3 'coder' working[\s\S]*ran out mid-outage/)
  })

  it('refuses a transport failure that is a configuration fault, not a restart', async () => {
    // A DNS entry that stopped resolving is its own diagnosis, and every second spent sitting on it
    // is a second before the operator reads it, followed by a message blaming a restart.
    const dnsFailure = await transportFailure(
      'ENOTFOUND',
      'getaddrinfo ENOTFOUND cat-factory.invalid',
    )
    await expect(
      waitFor({
        label: 'x',
        budgetMs: 60_000,
        intervalMs: 1,
        tolerate: deploymentOutageTolerance(60_000),
        probe: async () => {
          throw dnsFailure
        },
      }),
    ).rejects.toBe(dnsFailure)
  })

  it('waits through a connection RESET, which is what a process killed mid-response produces', async () => {
    let calls = 0
    const value = await waitFor<string>({
      label: 'x',
      budgetMs: 1000,
      intervalMs: 1,
      tolerate: deploymentOutageTolerance(500),
      probe: async () => {
        calls += 1
        if (calls === 1) throw await transportFailure('ECONNRESET', 'socket hang up')
        return { done: true, value: 'settled' }
      },
    })
    expect(value).toBe('settled')
  })

  it('rethrows an ANSWERED refusal untouched, rather than sitting through evidence', async () => {
    // An ANSWER is evidence, and sitting through evidence turns a revoked key into a two-minute
    // silence followed by the wrong message. Untouched, because callers read the SDK error's own
    // status and request id off it, and `toBe` is what pins that: a re-wrapped equivalent would
    // satisfy any looser assertion while dropping both.
    const refusal = apiRefusal(401, 'unauthorized', 'The API key has been revoked.')
    await expect(
      waitFor({
        label: 'x',
        budgetMs: 60_000,
        intervalMs: 1,
        tolerate: deploymentOutageTolerance(60_000),
        probe: async () => {
          throw refusal
        },
      }),
    ).rejects.toBe(refusal)
  })

  it('rethrows a 503, because that status IS the deployment speaking', async () => {
    // The one exclusion from the tolerated statuses, and the one most easily "fixed" back in by a
    // reader who sees 502 and 504 waited through and assumes 5xx was the rule. It is not: our own
    // `handleError` emits 503 for a capability this deployment has not wired, so waiting for it to
    // change its mind is waiting for nothing, while 502 and 504 it cannot emit at all.
    const unavailable = apiRefusal(503, 'unavailable', 'No model provider is configured.')
    await expect(
      waitFor({
        label: 'x',
        budgetMs: 60_000,
        intervalMs: 1,
        tolerate: deploymentOutageTolerance(60_000),
        probe: async () => {
          throw unavailable
        },
      }),
    ).rejects.toBe(unavailable)
  })

  it('waits through a 502, which can only be something in front of the deployment', async () => {
    let calls = 0
    const value = await waitFor<string>({
      label: 'x',
      budgetMs: 1000,
      intervalMs: 1,
      tolerate: deploymentOutageTolerance(500),
      probe: async () => {
        calls += 1
        if (calls === 1) throw apiRefusal(502, 'internal', 'Bad gateway')
        return { done: true, value: 'settled' }
      },
    })
    expect(value).toBe('settled')
  })

  it('reports progress so a long wait is not silent', async () => {
    const seen: string[] = []
    await waitFor({
      label: 'x',
      budgetMs: 5,
      intervalMs: 1,
      probe: async () => ({ done: false, state: 'working' }),
      onProgress: (state) => seen.push(state),
    }).catch(() => undefined)
    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('formatExpiry', () => {
  it("carries the suite's own epilogue, which is what says the state is still there", () => {
    // A suite deliberately leaves a failed run's pull request and namespace in place to be
    // inspected, and says so through its identity (`leftInPlaceNote`). The clock does not know
    // that sentence and must not invent one: what is pinned here is that it prints what it is
    // handed, so an operator reads the resume for the variable their own suite reads.
    const message = formatExpiry({
      label: 'the run',
      lastState: 'step 2 working',
      elapsedMs: 1000,
      budgetMs: 5000,
      epilogue: 'Nothing was cleaned up: re-run with ACME_RUN_ID set.',
    })
    expect(message).toContain('Nothing was cleaned up')
    expect(message).toContain('ACME_RUN_ID')
  })

  it('dates the observation when the budget ran out mid-outage', () => {
    // Both facts, because they are read together: an observation from four minutes ago is worth
    // having, and worth knowing to be four minutes old.
    const message = formatExpiry({
      label: 'the run',
      lastState: 'step 2 working',
      elapsedMs: 1000,
      budgetMs: 5000,
      silence: 'no answer for 1m00s',
    })
    expect(message).toContain('Last observed: step 2 working')
    expect(message).toContain('ran out mid-outage')
  })

  it('ends on its last clause when there is no epilogue, not on a blank line', () => {
    // Each optional clause carries its own separator, because this string becomes an `Error.message`
    // that rides into a scenario failure report and the journal's collapsed one-line phase summary.
    const message = formatExpiry({
      label: 'the run',
      lastState: 'step 2 working',
      elapsedMs: 1000,
      budgetMs: 5000,
    })
    expect(message.endsWith('Last observed: step 2 working')).toBe(true)
  })
})

describe('formatOutage', () => {
  it('sends the reader to the deployment rather than to the run', () => {
    // The distinction the message exists for: nothing about the RUN is evidence here, and a
    // reader who takes it as one goes looking at a pipeline that never stopped. Which is also why
    // what it prints is the last ANSWER: this message's own advice is unusable without it.
    const message = formatOutage({
      label: 'the run to settle',
      outage: 'the deployment did not answer (refused)',
      lastState: "step 3 'coder' working",
      outageMs: 130_000,
      graceMs: 120_000,
      epilogue: 'Nothing was cleaned up: re-run with ACME_RUN_ID set.',
    })
    expect(message).toContain('The deployment stopped answering')
    // Both halves: the cause says where the fix is, the last ANSWER says whether to worry.
    expect(message).toContain('No answer since: the deployment did not answer (refused)')
    expect(message).toContain("Last observed: step 3 'coder' working")
    expect(message).toContain('run itself may well be fine')
    expect(message).toContain('Nothing was cleaned up')
    expect(message.endsWith('re-run with ACME_RUN_ID set.')).toBe(true)
  })

  it('ends on its last clause when there is no epilogue, not on a blank line', () => {
    const message = formatOutage({
      label: 'the run to settle',
      outage: 'the deployment did not answer (refused)',
      lastState: "step 3 'coder' working",
      outageMs: 130_000,
      graceMs: 120_000,
    })
    expect(message.endsWith('before reading anything into the run.')).toBe(true)
  })
})

describe('formatDuration', () => {
  it('reads as a human would say it', () => {
    expect(formatDuration(900)).toBe('900ms')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(90_000)).toBe('1m30s')
    expect(formatDuration(5_400_000)).toBe('1h30m')
  })
})
