import { CatFactoryApiError } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { formatDuration, formatExpiry, formatOutage, waitFor } from '../src/deadline.ts'
import { deploymentOutageTolerance } from '../src/deploymentOutage.ts'
import {
  hostSuffix,
  imageTemplateSample,
  renderEnvironmentHost,
  renderEnvironmentImage,
} from '../src/k3s.ts'

/** A transport failure in the shape Node actually produces: the cause is the informative half. */
function refusedConnection(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
      code: 'ECONNREFUSED',
    }),
  })
}

/** The same shape, for a cause that is a CONFIGURATION fault rather than a restart. */
function transportFailure(code: string, message: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
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
          throw refusedConnection()
        },
      }),
    ).rejects.toThrow(/Last observed: step 3 'coder' working[\s\S]*ran out mid-outage/)
  })

  it('refuses a transport failure that is a configuration fault, not a restart', async () => {
    // A DNS entry that stopped resolving is its own diagnosis, and every second spent sitting on it
    // is a second before the operator reads it, followed by a message blaming a restart.
    const dnsFailure = transportFailure('ENOTFOUND', 'getaddrinfo ENOTFOUND cat-factory.invalid')
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
        if (calls === 1) throw transportFailure('ECONNRESET', 'socket hang up')
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
  it('says nothing was cleaned up, because nothing was', () => {
    // The suite deliberately leaves a failed run's pull request and namespace in place to be
    // inspected. Saying so is what stops someone assuming the state they need is gone.
    const message = formatExpiry('the run', 'step 2 working', 1000, 5000)
    expect(message).toContain('Nothing was cleaned up')
    expect(message).toContain('ACCEPTANCE_RUN_ID')
  })

  it('dates the observation when the budget ran out mid-outage', () => {
    // Both facts, because they are read together: an observation from four minutes ago is worth
    // having, and worth knowing to be four minutes old.
    const message = formatExpiry('the run', 'step 2 working', 1000, 5000, 'no answer for 1m00s')
    expect(message).toContain('Last observed: step 2 working')
    expect(message).toContain('ran out mid-outage')
  })
})

describe('formatOutage', () => {
  it('sends the reader to the deployment rather than to the run', () => {
    // The distinction the message exists for: nothing about the RUN is evidence here, and a
    // reader who takes it as one goes looking at a pipeline that never stopped. Which is also why
    // what it prints is the last ANSWER: this message's own advice is unusable without it.
    const message = formatOutage(
      'the run to settle',
      'the deployment did not answer (refused)',
      "step 3 'coder' working",
      130_000,
      120_000,
    )
    expect(message).toContain('The deployment stopped answering')
    // Both halves: the cause says where the fix is, the last ANSWER says whether to worry.
    expect(message).toContain('No answer since: the deployment did not answer (refused)')
    expect(message).toContain("Last observed: step 3 'coder' working")
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

  it('renders a padded hole, because the platform does', () => {
    // `renderTemplate` matches `{{\s*key\s*}}`, so `{{ namespace }}` is a template that WORKS in
    // production. Reading only the unpadded spelling refused it here, in the name of rendering
    // exactly as the platform does, before the pass had spent anything.
    expect(renderEnvironmentHost('{{ namespace }}.127.0.0.1.nip.io', 'cf-acc-7')).toBe(
      'cf-acc-7.127.0.0.1.nip.io',
    )
  })

  it('reports a template it cannot fully render rather than emitting a broken host', () => {
    // `{{pullNumber}}` is not known before a run opens its pull request, so guessing at it would
    // produce a host nothing resolves and a preflight that passed.
    expect(renderEnvironmentHost('{{branch}}-{{namespace}}.example', 'ns')).toBeNull()
  })

  it('still refuses a hole that is not hole-SHAPED, on either spelling', () => {
    // A placeholder is `{{someName}}` with no punctuation inside, so `{{repo-owner}}` matches the
    // substitution on neither side and survives verbatim into a host nothing resolves.
    expect(renderEnvironmentHost('{{ repo-owner }}.example', 'ns')).toBeNull()
  })
})

describe('renderEnvironmentImage', () => {
  const sample = imageTemplateSample({ owner: 'kibertoad', name: 'cf-acc-catalog-api' })

  it('renders the default template', () => {
    const verdict = renderEnvironmentImage(
      'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}',
      sample,
    )
    expect(verdict).toEqual({ ok: true, rendered: 'ghcr.io/kibertoad/cf-acc-catalog-api:pr-1' })
  })

  it('refuses {{namespace}}, which the platform renders the image one step too early to know', () => {
    // The trap this sample's key set exists for: `{{namespace}}` is a hole in the manifests and in
    // the ingress host, so it reads as a per-PR value an image may be built from. It is not.
    // `provisionContext` renders the image template against the bare inputs and only THEN adds the
    // namespace, so a gate that sampled one would pass a template the platform renders to
    // `ghcr.io/o/r:`, the empty image this whole check exists to refuse.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{namespace}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('{{namespace}}')
  })

  it('accepts a template built from an input the deployer really supplies', () => {
    // The other half of the same rule: a key MISSING from the sample refuses a working template
    // and names the wrong vocabulary doing it. `blockId` is supplied on every provision, primary
    // frame or peer.
    expect(renderEnvironmentImage('ghcr.io/o/r:{{blockId}}', sample)).toEqual({
      ok: true,
      rendered: `ghcr.io/o/r:${sample.blockId}`,
    })
  })

  it('refuses a hole that is not hole-SHAPED, in the name half as well as the tag', () => {
    // `{{repo-owner}}` matches no placeholder on either side, so it survives rendering verbatim and
    // reaches the apiserver as a reference with braces in it. The tag half was covered by accident
    // through the tag charset; the name half was not covered at all.
    const verdict = renderEnvironmentImage('ghcr.io/{{repo-owner}}/r:pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('brace')
  })

  it('refuses a prototype member, which is not a value any provision fills', () => {
    // `{{toString}}` matches the hole charset and finds a FUNCTION up the prototype chain, so a
    // nullish read reported it as filled and spliced `function toString() { [native code] }` in.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{toString}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('{{toString}}')
  })

  it('refuses a stray space rather than trimming one the platform would keep', () => {
    // `renderTemplate` trims nothing, so a gate that trimmed reported a reference the platform
    // would never produce, from the one input shape a `.env` line does not clean up for you.
    const verdict = renderEnvironmentImage('ghcr.io/o/r: pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('whitespace')
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
      rendered: 'localhost:5000/app:pr-1',
    })
    expect(renderEnvironmentImage('localhost:5000/app', sample).ok).toBe(false)
  })

  it('refuses an uppercase name, and points at where it came from', () => {
    const verdict = renderEnvironmentImage('ghcr.io/{{repoOwner}}/r:pr-1', {
      ...sample,
      repoOwner: 'Lokalise',
    })
    expect(verdict.ok ? '' : verdict.problem).toContain('ACCEPTANCE_REPO_OWNER')
    // And says what it cannot promise: the platform re-derives the owner from the pull request URL,
    // so a lowercase ACCEPTANCE_REPO_OWNER is not evidence the reference stays lowercase.
    expect(verdict.ok ? '' : verdict.problem).toContain('pull request URL')
  })

  it('blames no variable for an uppercase letter the template hard-codes', () => {
    // The remedy is instructions: naming ACCEPTANCE_REPO_OWNER for a name that never asked for the
    // owner sends a reader to edit a variable that is not in the reference.
    const verdict = renderEnvironmentImage('ghcr.io/Lokalise/r:pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('not lowercase')
    expect(verdict.ok ? '' : verdict.problem).not.toContain('ACCEPTANCE_REPO_OWNER')
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
