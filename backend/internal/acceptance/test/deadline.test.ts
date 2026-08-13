import { describe, expect, it } from 'vitest'
import { formatDuration, formatExpiry, formatOutage, waitFor } from '../src/deadline.ts'
import { deploymentOutageTolerance } from '../src/deploymentOutage.ts'
import { hostSuffix, renderEnvironmentHost, renderEnvironmentImage } from '../src/k3s.ts'

/** A transport failure in the shape Node actually produces: the cause is the informative half. */
function refusedConnection(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    }),
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
        if (calls <= 2) throw refusedConnection()
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
          throw refusedConnection()
        },
      }),
    ).rejects.toThrow(/stopped answering[\s\S]*ECONNREFUSED[\s\S]*run itself may well be fine/)
  })

  it('rethrows a throw the tolerance does not own, untouched', async () => {
    // An ANSWER is evidence, and sitting through evidence turns a revoked key into a two-minute
    // silence followed by the wrong message. Untouched, because callers read the SDK error's own
    // status and request id off it.
    const refusal = Object.assign(new Error('boom'), { status: 401 })
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
  it('says nothing was cleaned up, because nothing was', () => {
    // The suite deliberately leaves a failed run's pull request and namespace in place to be
    // inspected. Saying so is what stops someone assuming the state they need is gone.
    const message = formatExpiry('the run', 'step 2 working', 1000, 5000)
    expect(message).toContain('Nothing was cleaned up')
    expect(message).toContain('ACCEPTANCE_RUN_ID')
  })
})

describe('formatOutage', () => {
  it('sends the reader to the deployment rather than to the run', () => {
    // The distinction the message exists for: nothing about the RUN is evidence here, and a
    // reader who takes it as one goes looking at a pipeline that never stopped.
    const message = formatOutage('the run to settle', 'no answer (refused)', 130_000, 120_000)
    expect(message).toContain('The deployment stopped answering')
    expect(message).toContain('run itself may well be fine')
    expect(message).toContain('Nothing was cleaned up')
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

describe('renderEnvironmentHost', () => {
  it('renders the namespace hole', () => {
    expect(renderEnvironmentHost('{{namespace}}.127.0.0.1.nip.io', 'cf-acc-7')).toBe(
      'cf-acc-7.127.0.0.1.nip.io',
    )
  })

  it('reports a template it cannot fully render rather than emitting a broken host', () => {
    // `{{pullNumber}}` is not known before a run opens its pull request, so guessing at it would
    // produce a host nothing resolves and a preflight that passed.
    expect(renderEnvironmentHost('{{branch}}-{{namespace}}.example', 'ns')).toBeNull()
  })
})

describe('renderEnvironmentImage', () => {
  const sample = {
    repoOwner: 'kibertoad',
    repoName: 'cf-acc-catalog-api',
    pullNumber: '4',
    branch: 'cat-factory/task_19312e88',
    namespace: 'cf-acc-4',
  }

  it('renders the default template', () => {
    const verdict = renderEnvironmentImage(
      'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}',
      sample,
    )
    expect(verdict).toEqual({ ok: true, rendered: 'ghcr.io/kibertoad/cf-acc-catalog-api:pr-4' })
  })

  it('names a placeholder a provision does not fill rather than emitting the empty string', () => {
    // Exactly what the platform does with an unknown key, minus the silence: a manifest applied
    // with `image: ""` is refused by the apiserver as a Deployment whose image is missing, which
    // accuses the manifest of a fault that belongs to the configuration.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{commitSha}}', sample)
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.ok ? '' : verdict.problem).toContain('{{commitSha}}')
  })

  it('refuses a tag with a slash in it, because that is what {{branch}} renders', () => {
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{branch}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain("may not contain '/'")
  })

  it('refuses a reference with no tag, which could never be the code under review', () => {
    const verdict = renderEnvironmentImage('ghcr.io/o/r', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('no tag')
  })

  it('keeps a registry port out of the tag reading', () => {
    // `localhost:5000/app` has a colon that is not a tag separator, so a naive split reports a
    // perfectly good reference as untagged.
    expect(renderEnvironmentImage('localhost:5000/app:pr-{{pullNumber}}', sample)).toEqual({
      ok: true,
      rendered: 'localhost:5000/app:pr-4',
    })
    expect(renderEnvironmentImage('localhost:5000/app', sample).ok).toBe(false)
  })

  it('refuses an uppercase name, and points at where it came from', () => {
    const verdict = renderEnvironmentImage('ghcr.io/{{repoOwner}}/r:pr-1', {
      ...sample,
      repoOwner: 'Lokalise',
    })
    expect(verdict.ok ? '' : verdict.problem).toContain('ACCEPTANCE_REPO_OWNER')
  })
})

describe('hostSuffix', () => {
  it('keeps only the fixed tail, which is all a scenario can honestly assert', () => {
    expect(hostSuffix('{{namespace}}.127.0.0.1.nip.io')).toBe('.127.0.0.1.nip.io')
    expect(hostSuffix('{{branch}}.{{namespace}}.preview.example.com')).toBe('.preview.example.com')
  })

  it('returns a template with no holes unchanged', () => {
    expect(hostSuffix('preview.example.com')).toBe('preview.example.com')
  })
})
