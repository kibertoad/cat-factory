import type { PublicServiceSpec } from '@cat-factory/contracts'
import type { RepoContentEntry, RepoFiles, RunRepoContext } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { publicSpecController } from './PublicSpecController.js'

// The spec read has FOUR outcomes and the entire point of this controller is that it never folds
// them: three of them produce an empty tree and demand different reactions from the caller, and
// the fold they invite is always the same one: reporting a VCS outage as a service that has
// written no requirements.
//
// Each test below drives the REAL route through the real error funnel, because that funnel is what
// turns a thrown refusal into the `details.reason` a headless caller branches on: a hand-built
// envelope structurally cannot carry one, and a test app without `handleError` reads every refusal
// as a 500.

const SERVICE_ID = 'frm_1'

const SPEC_FILES: Record<string, string> = {
  'spec/service.json': JSON.stringify({ service: 'Checkout', summary: 'Buy things.' }),
  'spec/modules/orders/_module.json': JSON.stringify({ name: 'Orders' }),
  'spec/modules/orders/place.json': JSON.stringify({
    name: 'Place an order',
    requirements: [
      {
        id: 'req-total-positive',
        title: 'Totals are positive',
        statement: 'The system SHALL refuse a negative order total.',
        kind: 'constraint',
        priority: 'must',
      },
    ],
  }),
  'spec/features/orders/place.feature': 'Feature: Place an order\n',
}

/** An in-memory `RepoFiles` over a flat path→content map, one directory level deep. */
function fakeRepo(files: Record<string, string>): RepoFiles {
  return {
    getFile: async (path) => (path in files ? { content: files[path]!, sha: `sha-${path}` } : null),
    listDirectory: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const seen = new Map<string, RepoContentEntry>()
      for (const full of Object.keys(files)) {
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash)
        const path = `${prefix}${name}`
        if (!seen.has(path)) {
          seen.set(path, { path, name, type: slash === -1 ? 'file' : 'dir', sha: `sha-${path}` })
        }
      }
      return [...seen.values()]
    },
    headSha: async () => 'commit-sha',
    createBranch: async () => undefined,
    deleteBranch: async () => undefined,
    commitFiles: async () => ({ sha: 'c' }),
    openPullRequest: async () => ({ number: 1, url: 'u' }) as never,
  }
}

function repoContext(repo: RepoFiles): RunRepoContext {
  return {
    repo,
    baseBranch: 'main',
    repoId: 'repo-1',
    owner: 'acme',
    name: 'checkout',
    provider: 'github',
  }
}

interface HarnessOptions {
  /** Omitted ⇒ the deployment wired no run-repo resolver at all. */
  resolve?: ServerContainer['resolveRunRepoContext']
  /** Ids the board answers a visible service frame for; defaults to the one service. */
  services?: string[]
}

function harness(opts: HarnessOptions = {}) {
  const services = new Set(opts.services ?? [SERVICE_ID])
  const container = {
    boardService: {
      getService: async (_ws: string, serviceId: string) =>
        services.has(serviceId) ? { id: serviceId } : null,
    },
    publicApiKeys: {
      authenticate: async (secret?: string) =>
        secret === 'good' ? { workspaceId: 'ws_1', scope: 'read', keyId: 'k1' } : null,
    },
    ...(opts.resolve ? { resolveRunRepoContext: opts.resolve } : {}),
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicSpecController())

  return async (serviceId = SERVICE_ID, key = 'good') => {
    const res = await app.request(`/api/v1/services/${serviceId}/spec`, {
      headers: { authorization: `Bearer ${key}` },
    })
    return { status: res.status, body: (await res.json()) as never }
  }
}

const reasonOf = (body: unknown) =>
  (body as { error?: { details?: { reason?: string } } }).error?.details?.reason

describe('GET /api/v1/services/:serviceId/spec', () => {
  it('serves the tree, the Gherkin and the ref + commit it was read at', async () => {
    const call = harness({ resolve: async () => repoContext(fakeRepo(SPEC_FILES)) })
    const { status, body } = await call()
    const spec = body as PublicServiceSpec

    expect(status).toBe(200)
    expect(spec.present).toBe(true)
    expect(spec.serviceId).toBe(SERVICE_ID)
    expect(spec.spec?.modules?.[0]?.groups?.[0]?.requirements?.[0]?.id).toBe('req-total-positive')
    expect(spec.features[0]?.path).toBe('spec/features/orders/place.feature')
    // Provenance is what makes this a snapshot rather than a claim about now: the spec on the
    // default branch is not the spec a run with an open pull request is working against.
    expect(spec.provenance).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'checkout',
      ref: 'main',
      commit: 'commit-sha',
    })
    expect(spec.issues).toEqual([])
    expect(spec.truncations).toEqual([])
  })

  it('answers present: false for a repository that simply holds no spec', async () => {
    const call = harness({ resolve: async () => repoContext(fakeRepo({})) })
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body).toMatchObject({ present: false, spec: null, features: [] })
  })

  it('REFUSES with spec_read_failed when the repository could not be read', async () => {
    const repo = fakeRepo(SPEC_FILES)
    repo.getFile = async () => {
      throw new Error('GitHub 502')
    }
    const call = harness({ resolve: async () => repoContext(repo) })
    const { status, body } = await call()
    // The case this endpoint exists to get right. The reader degrades an unreadable repo to the
    // same empty view an absent spec produces, so answering 200 here would tell an integrator
    // that the service declares no requirements for the length of the outage.
    expect(status).toBe(503)
    expect(reasonOf(body)).toBe('spec_read_failed')
  })

  it('serves a PARTIAL spec, naming the file that did not survive', async () => {
    const call = harness({
      resolve: async () =>
        repoContext(fakeRepo({ ...SPEC_FILES, 'spec/modules/orders/broken.json': '{ not json' })),
    })
    const { status, body } = await call()
    const spec = body as PublicServiceSpec
    expect(status).toBe(200)
    expect(spec.present).toBe(true)
    // Served, not refused: the part that arrived is useful, and `issues` is what stops it reading
    // as the whole.
    expect(spec.issues).toEqual([
      { path: 'spec/modules/orders/broken.json', kind: 'unparsed', dropped: 0 },
    ])
  })

  it('answers vcs_not_configured for a deployment with no resolver, and for an unconnected workspace', async () => {
    const unwired = await harness()()
    expect(unwired.status).toBe(503)
    expect(reasonOf(unwired.body)).toBe('vcs_not_configured')

    // A wired deployment whose workspace has connected nothing resolves null, which is the same
    // instruction to the caller (connect version control) and the same code.
    const unconnected = await harness({ resolve: async () => null })()
    expect(unconnected.status).toBe(503)
    expect(reasonOf(unconnected.body)).toBe('vcs_not_configured')
  })

  it('404s an id that names no service this key may read, BEFORE reporting on wiring', async () => {
    // Ordering matters: a mistyped id on a deployment with no VCS integration must answer "no
    // such service", not a report on how the deployment is configured.
    const { status, body } = await harness()('frm_nope')
    expect(status).toBe(404)
    expect(reasonOf(body)).toBe('service_not_found')
  })

  it('lets an unlinked service surface as the ValidationError every other surface gives it', async () => {
    const call = harness({
      resolve: async () => {
        throw new ValidationError('Block is not under a repo-linked service')
      },
    })
    const { status } = await call()
    // Not a 200 with an empty spec: a service nothing can RUN must not read as one that merely
    // has nothing to say. There is deliberately no first-repo fallback anywhere in the platform.
    expect(status).toBe(422)
  })

  it('refuses an unauthenticated caller before touching the board', async () => {
    const { status } = await harness({ resolve: async () => repoContext(fakeRepo(SPEC_FILES)) })(
      SERVICE_ID,
      'bad',
    )
    expect(status).toBe(401)
  })
})
