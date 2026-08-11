import { describe, expect, it } from 'vitest'
import {
  ISSUE_APIS,
  ISSUE_SOURCE_BY_PROVIDER,
  issueTarget,
  UNSUPPORTED_PROVIDER_REASON,
} from '../src/vcsIssues.ts'
import type { AcceptanceConfig } from '../src/config.ts'

// The reporter's client, over a fake transport.
//
// What is worth pinning here is the MAPPING from a provider's answer to a verdict, because every one
// of those answers is ambiguous in a way that matters: a 404 is a repository that does not exist AND
// one the credential cannot see, a 200 with `has_issues: false` is a repository that will refuse the
// file with a 410 that reads like a permission problem, and a thrown fetch is neither. The gate
// prints different instructions for each, so a client that flattened them would send an operator to
// re-mint a working token.

const TARGET = { owner: 'acme', repo: 'catalog-api' }

/**
 * One canned answer. `throws` takes the VALUE thrown rather than a message, because the shapes that
 * matter here are undici's: a contentless wrapper over the link that names the failure. `text` is
 * for a body that is not JSON at all, which is what something other than the API answers with.
 */
type Route = { status: number; body?: unknown; text?: string; throws?: unknown }

/** A `fetch` answering a table keyed by `METHOD /path`, and 599 for anything unrouted. */
function fakeFetch(
  routes: Record<string, Route>,
  calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.replace('https://api.test', '')
    calls.push({
      method,
      url,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    const route = routes[`${method} ${path}`]
    if (route?.throws) throw route.throws
    const status = route?.status ?? 599
    return new Response(route?.text ?? JSON.stringify(route?.body ?? {}), { status })
  }) as unknown as typeof fetch
}

function github(
  routes: Record<string, Route>,
  calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [],
) {
  const build = ISSUE_APIS.github
  if (!build) throw new Error('the GitHub client is the one this suite must always have')
  return build({
    token: 'reporter-secret',
    apiBaseUrl: 'https://api.test',
    fetchImpl: fakeFetch(routes, calls),
  })
}

describe('the reporter credential probe', () => {
  it('is READY for a repository it can read that accepts issues', async () => {
    const api = github({
      'GET /repos/acme/catalog-api': { status: 200, body: { has_issues: true } },
    })
    expect(await api.probe(TARGET)).toEqual({ status: 'ready' })
  })

  it('reads a 401 as the TOKEN and a 404 as the repository, which need opposite fixes', async () => {
    const unauthenticated = github({ 'GET /repos/acme/catalog-api': { status: 401 } })
    expect(await unauthenticated.probe(TARGET)).toEqual({ status: 'unauthenticated' })
    const missing = github({ 'GET /repos/acme/catalog-api': { status: 404 } })
    expect(await missing.probe(TARGET)).toEqual({ status: 'unreachable' })
  })

  it('catches Issues being switched off, which otherwise fails at FILE time as a 410', async () => {
    const api = github({
      'GET /repos/acme/catalog-api': { status: 200, body: { has_issues: false } },
    })
    expect(await api.probe(TARGET)).toEqual({ status: 'issues-disabled' })
  })

  it('reports a transport failure as UNREADABLE, never as a bad credential', async () => {
    // The three-state rule at its sharpest: a proxy that is down must not be reported as a token to
    // go and re-mint, which is a fix that cannot work and costs the operator a token rotation.
    const api = github({
      'GET /repos/acme/catalog-api': {
        status: 0,
        throws: new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 140.82.121.6:443'), {
            code: 'ECONNREFUSED',
          }),
        }),
      },
    })
    expect(await api.probe(TARGET)).toMatchObject({ status: 'unreadable' })
  })

  it('names the CAUSE of that failure, and the address it was reaching', async () => {
    // `error.message` here is undici's contentless `fetch failed`, identical for a DNS typo, a
    // refused connection, an untrusted certificate and an Enterprise Server that is down, and the
    // gate prints it verbatim as its verdict. It is also the ONE probe in the gate that leaves the
    // deployment, so the runner's probe context (the backend) cannot describe it: this is where the
    // provider's own address gets named.
    const api = github({
      'GET /repos/acme/catalog-api': {
        status: 0,
        throws: new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND ghe.internal'), {
            code: 'ENOTFOUND',
          }),
        }),
      },
    })
    const verdict = await api.probe(TARGET)
    if (verdict.status !== 'unreadable') throw new Error('expected an unreadable verdict')
    expect(verdict.detail).toContain('getaddrinfo ENOTFOUND ghe.internal')
    expect(verdict.detail).not.toContain('fetch failed')
    expect(verdict.hint).toContain('https://api.test')
    expect(verdict.hint).toContain('does not resolve')
  })

  it('reports an unexpected status as unreadable rather than guessing which fault it is', async () => {
    const api = github({ 'GET /repos/acme/catalog-api': { status: 500 } })
    const verdict = await api.probe(TARGET)
    expect(verdict.status).toBe('unreadable')
  })

  it('reports a 200 that is not JSON as unreadable, rather than throwing out of the check', async () => {
    // The body read used to sit OUTSIDE the try, so a captive portal answering 200 with HTML threw
    // out of the probe. The gate then described a failure at the PROVIDER against the deployment's
    // address, `curl` command included, which is the misattribution the probe describer exists to
    // remove. It is also not evidence about the credential, hence `unreadable` and not a fault.
    const api = github({
      'GET /repos/acme/catalog-api': { status: 200, text: '<!DOCTYPE html><title>Sign in</title>' },
    })
    const verdict = await api.probe(TARGET)
    if (verdict.status !== 'unreadable') throw new Error('expected an unreadable verdict')
    expect(verdict.detail).toContain('HTTP 200 with a body that is not the JSON this API documents')
    expect(verdict.hint).toContain('intercepting proxy')
  })
})

describe('filing an issue', () => {
  it('posts the title and body, authenticated, and returns what the task will be linked through', async () => {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] =
      []
    const api = github(
      {
        'POST /repos/acme/catalog-api/issues': {
          status: 201,
          body: { number: 7, html_url: 'https://github.com/acme/catalog-api/issues/7' },
        },
      },
      calls,
    )
    const filed = await api.file(TARGET, { title: 'Paging repeats an item', body: 'Steps…' })
    expect(filed).toEqual({ number: 7, url: 'https://github.com/acme/catalog-api/issues/7' })
    const [call] = calls
    expect(call?.method).toBe('POST')
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      title: 'Paging repeats an item',
      body: 'Steps…',
    })
    // The API version is pinned and the scheme is `Bearer`, which is what a fine-grained token needs.
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28')
    expect(call?.headers.authorization).toBe('Bearer reporter-secret')
  })

  it('carries the provider’s own body into the failure, since that is where the cause is', async () => {
    const api = github({
      'POST /repos/acme/catalog-api/issues': {
        status: 410,
        body: { message: 'Issues are disabled for this repo' },
      },
    })
    await expect(api.file(TARGET, { title: 't', body: 'b' })).rejects.toThrow(
      /410.*Issues are disabled/s,
    )
  })

  it('refuses an accepted issue that came back without a number and URL', async () => {
    // A 201 whose body cannot be linked to is worse than a failure: the issue exists, and a pass
    // that recorded nothing about it would file a second one on the next attempt.
    const api = github({ 'POST /repos/acme/catalog-api/issues': { status: 201, body: {} } })
    await expect(api.file(TARGET, { title: 't', body: 'b' })).rejects.toThrow(/no number and URL/)
  })
})

describe('reading an issue back', () => {
  it('reports the provider’s own state word alongside the boolean, plus every comment', async () => {
    const api = github({
      'GET /repos/acme/catalog-api/issues/7': {
        status: 200,
        body: { state: 'closed', html_url: 'https://github.com/acme/catalog-api/issues/7' },
      },
      'GET /repos/acme/catalog-api/issues/7/comments?per_page=100': {
        status: 200,
        body: [{ body: 'a pull request was opened' }, { body: 'merged and resolved' }],
      },
    })
    const state = await api.read(TARGET, 7)
    expect(state).toEqual({
      state: 'closed',
      closed: true,
      url: 'https://github.com/acme/catalog-api/issues/7',
      comments: ['a pull request was opened', 'merged and resolved'],
    })
  })

  it('answers NULL for an issue that is gone, which a resume must tell from a broken provider', async () => {
    const api = github({ 'GET /repos/acme/catalog-api/issues/7': { status: 404 } })
    expect(await api.read(TARGET, 7)).toBeNull()
  })

  it('propagates a broken provider rather than reporting the issue as gone', async () => {
    const api = github({ 'GET /repos/acme/catalog-api/issues/7': { status: 500 } })
    await expect(api.read(TARGET, 7)).rejects.toThrow(/500/)
  })
})

describe('the provider tables', () => {
  it('withholds a client for a provider whose instance is unknowable, and says what is missing', async () => {
    // Null is the honest answer rather than a gap: `configureEnv.ts` makes the same call for the
    // repository creation link, for the same reason, and both refusals name the one missing value.
    expect(ISSUE_APIS.gitlab).toBeNull()
    expect(UNSUPPORTED_PROVIDER_REASON.gitlab.join('\n')).toContain('ACCEPTANCE_VCS_API_BASE')
    expect(UNSUPPORTED_PROVIDER_REASON.github).toEqual([])
  })

  it('maps every provider to the task source its issues arrive as', async () => {
    // Derived over the table's own keys rather than a pinned count: adding a provider should not
    // need this edited, and what matters is that no key maps to nothing.
    for (const [provider, source] of Object.entries(ISSUE_SOURCE_BY_PROVIDER)) {
      expect(source, `${provider} has no task source`).toBeTruthy()
    }
  })

  it('files against the BACKEND repository, which is the one the gate probes', async () => {
    const config = {
      repoOwner: 'acme',
      repos: { backend: 'catalog-api', frontend: 'catalog-web' },
    } as AcceptanceConfig
    expect(issueTarget(config)).toEqual({ owner: 'acme', repo: 'catalog-api' })
  })
})
