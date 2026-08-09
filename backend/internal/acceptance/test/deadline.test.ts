import { describe, expect, it } from 'vitest'
import { formatDuration, formatExpiry, waitFor } from '../src/deadline.ts'
import { hostSuffix, renderEnvironmentHost } from '../src/k3s.ts'

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

describe('hostSuffix', () => {
  it('keeps only the fixed tail, which is all a spec can honestly assert', () => {
    expect(hostSuffix('{{namespace}}.127.0.0.1.nip.io')).toBe('.127.0.0.1.nip.io')
    expect(hostSuffix('{{branch}}.{{namespace}}.preview.example.com')).toBe('.preview.example.com')
  })

  it('returns a template with no holes unchanged', () => {
    expect(hostSuffix('preview.example.com')).toBe('preview.example.com')
  })
})
