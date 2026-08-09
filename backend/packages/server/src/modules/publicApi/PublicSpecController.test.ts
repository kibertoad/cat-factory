import type { PublicRunSpec, PublicServiceSpec, ServiceSpecView } from '@cat-factory/contracts'
import { readServiceSpec } from '@cat-factory/agents'
import type { RepoContentEntry, RepoFiles, RunRepoContext } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { RunSpecRead } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { publicSpecController } from './PublicSpecController.js'

// The spec read has SEVERAL outcomes and the entire point of this controller is that it never
// folds them: most of them produce an empty tree and demand different reactions from the caller,
// and the fold they invite is always the same one: reporting a VCS outage, an unreachable
// repository or a corrupt anchor as a service that has written no requirements.
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
    expect(spec.anchor).toBe('present')
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

  it('answers anchor: absent for a repository that simply holds no spec', async () => {
    const call = harness({ resolve: async () => repoContext(fakeRepo({})) })
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body).toMatchObject({ anchor: 'absent', spec: null, features: [] })
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

  it('REFUSES rather than reporting "no spec" when the branch itself would not resolve', async () => {
    // The fold this endpoint is most likely to make WITHOUT noticing. A repository that was
    // renamed, transferred or deleted, a `baseBranch` that no longer exists and an installation
    // that lost access all answer 404, and the client maps 404 to "no such file" exactly as it
    // does for a repository that genuinely holds no spec. Only the ref resolution tells them
    // apart, so an unresolved ref may not be served as a confident empty answer.
    const repo = fakeRepo({})
    repo.headSha = async () => null
    const call = harness({ resolve: async () => repoContext(repo) })
    const { status, body } = await call()
    expect(status).toBe(503)
    expect(reasonOf(body)).toBe('spec_ref_unresolved')
  })

  it('still serves a spec whose ref would not resolve, because the tree PROVES the read', async () => {
    // The other half of the same rule: a provider degraded only on refs answered the anchor's own
    // bytes, so the branch is demonstrably readable and refusing would drop an answer we hold.
    // The commit is null, which the provenance already exists to say.
    const repo = fakeRepo(SPEC_FILES)
    repo.headSha = async () => {
      throw new Error('refs API down')
    }
    const { status, body } = await harness({ resolve: async () => repoContext(repo) })()
    const spec = body as PublicServiceSpec
    expect(status).toBe(200)
    expect(spec.anchor).toBe('present')
    expect(spec.provenance.commit).toBeNull()
  })

  it('answers anchor: unparsed for a corrupt anchor, never folding it onto absent', async () => {
    // A `spec/service.json` that is there and unusable is a repository state somebody has to fix.
    // Answered as `absent` it would read as a service that declares nothing, which is the exact
    // shape of the mistake the whole endpoint refuses to make one layer up.
    const call = harness({
      resolve: async () => repoContext(fakeRepo({ 'spec/service.json': '{ not json' })),
    })
    const { status, body } = await call()
    const spec = body as PublicServiceSpec
    expect(status).toBe(200)
    expect(spec.anchor).toBe('unparsed')
    expect(spec.spec).toBeNull()
    expect(spec.issues).toEqual([{ path: 'spec/service.json', kind: 'unparsed', dropped: 0 }])
  })

  it('serves a PARTIAL spec, naming the file that did not survive', async () => {
    const call = harness({
      resolve: async () =>
        repoContext(fakeRepo({ ...SPEC_FILES, 'spec/modules/orders/broken.json': '{ not json' })),
    })
    const { status, body } = await call()
    const spec = body as PublicServiceSpec
    expect(status).toBe(200)
    expect(spec.anchor).toBe('present')
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

// ---------------------------------------------------------------------------
// The RUN read. The document is the same and so are the caps, so what is worth pinning here is
// only what DIFFERS: which read it delegates to, and the fourth outcome the service read cannot
// have. The read itself (the branch rule, the tester gate, the memo) belongs to the engine's
// evidence loader and is pinned there; a controller that composed its own would be able to hand a
// caller a tree the run's own outcome summary was never joined against.
// ---------------------------------------------------------------------------

const RUN_ID = 'exec_1'

const PROVENANCE = {
  provider: 'github' as const,
  owner: 'acme',
  repo: 'checkout',
  ref: 'cat/add-login',
  commit: 'commit-sha',
}

interface RunHarnessOptions {
  /** What the engine's run-spec read answers. */
  read: RunSpecRead | null
  /** Ids the workspace resolves a run for; defaults to the one run. */
  runs?: string[]
}

function runHarness(opts: RunHarnessOptions) {
  const runs = new Set(opts.runs ?? [RUN_ID])
  const container = {
    executionRepository: {
      get: async (_ws: string, runId: string) =>
        runs.has(runId) ? { id: runId, blockId: 'blk_1' } : null,
    },
    boardService: {
      getServiceTask: async () => ({ id: 'blk_1' }),
      getInternalTask: async () => null,
    },
    executionService: {
      readRunSpecOutcome: async () => opts.read,
    },
    publicApiKeys: {
      authenticate: async (secret?: string) =>
        secret === 'good' ? { workspaceId: 'ws_1', scope: 'read', keyId: 'k1' } : null,
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicSpecController())

  return async (runId = RUN_ID, key = 'good') => {
    const res = await app.request(`/api/v1/runs/${runId}/spec`, {
      headers: { authorization: `Bearer ${key}` },
    })
    return { status: res.status, body: (await res.json()) as never }
  }
}

/** The reader's view of a repository that carries the fixture spec, as the loader hands it over. */
async function fixtureView(files: Record<string, string> = SPEC_FILES): Promise<ServiceSpecView> {
  return readServiceSpec(fakeRepo(files), PROVENANCE.ref)
}

describe('GET /api/v1/runs/:runId/spec', () => {
  it("serves the tree at the RUN's branch, naming the ref and commit it was read at", async () => {
    const view = await fixtureView()
    const call = runHarness({ read: { status: 'read', view, provenance: PROVENANCE } })
    const { status, body } = await call()
    const spec = body as PublicRunSpec

    expect(status).toBe(200)
    expect(spec.anchor).toBe('present')
    expect(spec.runId).toBe(RUN_ID)
    expect(spec.spec?.modules?.[0]?.groups?.[0]?.requirements?.[0]?.id).toBe('req-total-positive')
    // The whole reason this endpoint is a sibling of the service read rather than a flag on it:
    // the ref is the run's own branch, which carries the requirements the run added and the
    // default branch does not.
    expect(spec.provenance).toEqual(PROVENANCE)
  })

  it('answers anchor: not_read, with no provenance, when the run has consulted no tree yet', async () => {
    // The run-only outcome, and a 200 rather than a refusal: the platform has read no spec for
    // this run, which is exactly what `requirements.spec: "not_read"` on the same run's outcome
    // summary reports. Served as `absent` it would claim the branch holds no requirements, which
    // is a statement nothing has checked.
    const { status, body } = await runHarness({ read: { status: 'not_read' } })()
    expect(status).toBe(200)
    expect(body).toMatchObject({
      runId: RUN_ID,
      anchor: 'not_read',
      spec: null,
      features: [],
      provenance: null,
      issues: [],
      truncations: [],
    })
  })

  it('REFUSES with spec_read_failed rather than reporting a run judged against nothing', async () => {
    const { status, body } = await runHarness({ read: { status: 'read_failed' } })()
    expect(status).toBe(503)
    expect(reasonOf(body)).toBe('spec_read_failed')
  })

  it('answers vcs_not_configured for an unwired deployment and an unconnected workspace alike', async () => {
    const unwired = await runHarness({ read: { status: 'vcs_unwired' } })()
    expect(unwired.status).toBe(503)
    expect(reasonOf(unwired.body)).toBe('vcs_not_configured')

    const unconnected = await runHarness({ read: { status: 'no_connection' } })()
    expect(unconnected.status).toBe(503)
    expect(reasonOf(unconnected.body)).toBe('vcs_not_configured')
  })

  it("REFUSES an empty branch whose ref would not resolve, sharing the service read's rule", async () => {
    // Same judgement, same helper: a provider answers 404 for an absent file and for a repository
    // nobody can reach, and only the resolved commit tells them apart.
    const view = await fixtureView({})
    const { status, body } = await runHarness({
      read: { status: 'read', view, provenance: { ...PROVENANCE, commit: null } },
    })()
    expect(status).toBe(503)
    expect(reasonOf(body)).toBe('spec_ref_unresolved')
  })

  it('404s a run this key may not read, before asking the engine for anything', async () => {
    const { status, body } = await runHarness({ read: { status: 'not_read' }, runs: [] })()
    expect(status).toBe(404)
    expect(reasonOf(body)).toBe('run_not_found')
  })

  it('refuses an unauthenticated caller', async () => {
    const { status } = await runHarness({ read: { status: 'not_read' } })(RUN_ID, 'bad')
    expect(status).toBe(401)
  })
})
