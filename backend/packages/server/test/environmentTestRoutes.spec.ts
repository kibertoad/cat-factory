import type {
  EnvironmentTestMode,
  EnvironmentTestRun,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { PERSONAL_PASSWORD_HEADER } from '@cat-factory/contracts'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { environmentController } from '../src/modules/environments/EnvironmentController.js'

// The self-test START route, which has two properties worth driving the real controller for.
//
// The first is a transport one: the route was body-less for its whole life and now carries an
// ALL-OPTIONAL `{ mode }` body. `buildHonoRoute` mounts a validator that reads `c.req.json()`
// BEFORE consulting the schema, so without `optionalJsonBody` in front of it every body-less
// caller would start getting a 400 from a schema that says every field is optional.
// `optionalJsonBody`'s own test pins the middleware; what it structurally cannot pin is that THIS
// route mounts it, and which mode a body-less call resolves to.
//
// The second is the PERSONAL-CREDENTIAL gate on an `agent-probe` start. A dry run spends a model
// call, and the model it spends comes from the workspace's preset, which can name a personal
// subscription (Claude). Ungated, the dispatch reached the lease with no activation minted and the
// developer was never asked for their unlock password at all, so the prober silently ran on
// whatever the deployment's env routing defaulted to. `provision` mode runs no agent and so must
// stay ungated, which is also what keeps the historical body-less start working.

const RUN: EnvironmentTestRun = {
  id: 'envtest_1',
  workspaceId: 'ws_1',
  blockId: 'frame_1',
  mode: 'provision',
  status: 'running',
  stage: 'creating_branch',
  branch: null,
  envUrl: null,
  error: null,
  failedStage: null,
  probe: null,
  probeProgress: null,
  createdAt: 1,
  updatedAt: 1,
}

function makeApp(
  over: {
    /** The individual-usage vendors the dry run's model would lease a personal credential for. */
    vendors?: SubscriptionVendor[]
    /** Whether the deployment has a personal-subscription store at all. */
    personalStore?: boolean
    /** The vendors native local mode serves with the developer's own ambient CLI login. */
    nativeAmbientAuth?: string[]
  } = {},
) {
  const startTest = vi.fn(
    async (
      _workspaceId: string,
      _blockId: string,
      _initiatedBy: string | null,
      mode: EnvironmentTestMode,
      _activate?: (runId: string) => Promise<void>,
    ) => ({ ...RUN, mode }),
  )
  const probeAgentKind = vi.fn(async () => 'environment-prober-api')
  const activateForRun = vi.fn(async () => {})
  const container = {
    environments: { environmentTest: { startTest, probeAgentKind } },
    config: { nativeAmbientAuth: over.nativeAmbientAuth ?? [] },
    executionService: {
      individualVendorsForAgentKind: vi.fn(async () => over.vendors ?? []),
    },
    ...(over.personalStore === false
      ? {}
      : {
          personalSubscriptions: {
            list: async () => (over.vendors ?? []).map((vendor) => ({ vendor })),
            activateForRun,
          },
        }),
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    c.set('user', {
      id: 'usr_1',
      login: 'dev',
      name: null,
      avatarUrl: null,
      aud: 'session',
      exp: 0,
      gen: 0,
    })
    // The controller gates its own writes on `integrations.manage`
    // (`mountWorkspacePermission`), which the real auth gate publishes. Supply it, since a
    // 403 here would mask exactly the transport behaviour these cases are about.
    c.set('workspaceAccess', {
      role: 'admin',
      permissions: new Set(['integrations.manage']),
    } as never)
    await next()
  })
  app.route('/workspaces/:workspaceId', environmentController())
  // Without this a refusal reads as a 500 (CLAUDE.md, the controller rules).
  app.onError(handleError)
  return {
    app,
    startTest,
    probeAgentKind,
    activateForRun,
    container: container as unknown as {
      executionService: { individualVendorsForAgentKind: ReturnType<typeof vi.fn> }
    },
  }
}

const start = (app: Hono<AppEnv>, init?: RequestInit) =>
  app.request('/workspaces/ws_1/blocks/frame_1/environment-test', {
    method: 'POST',
    ...init,
  } as RequestInit)

describe('POST /workspaces/:ws/blocks/:blockId/environment-test', () => {
  it('accepts a BODY-LESS start and reads it as the provisioning self-test', async () => {
    const { app, startTest } = makeApp()
    const res = await start(app)
    expect(res.status).toBe(201)
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'provision', undefined)
  })

  it('accepts an explicitly empty body too', async () => {
    const { app, startTest } = makeApp()
    const res = await start(app, { headers: { 'content-length': '0' } })
    expect(res.status).toBe(201)
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'provision', undefined)
  })

  it('starts an AGENT DRY RUN when the body names that mode', async () => {
    const { app, startTest } = makeApp()
    const res = await start(app, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent-probe' }),
    })
    expect(res.status).toBe(201)
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'agent-probe', undefined)
    expect((await res.json()) as EnvironmentTestRun).toMatchObject({ mode: 'agent-probe' })
  })

  it('still rejects a mode this build does not know', async () => {
    // The middleware normalises ABSENCE only; it must not weaken validation of what IS sent, or a
    // typo would start a run in whichever mode the service defaults to. The refusal is the shared
    // validation envelope (400) from the contract validator, so it never reaches the handler.
    const { app, startTest } = makeApp()
    const res = await start(app, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'probe-everything' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation')
    expect(startTest).not.toHaveBeenCalled()
  })
})

const startProbe = (app: Hono<AppEnv>, headers: Record<string, string> = {}) =>
  app.request('/workspaces/ws_1/blocks/frame_1/environment-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ mode: 'agent-probe' }),
  } as RequestInit)

describe('the personal-credential gate on an agent dry run', () => {
  it('asks for the unlock password before creating anything, for a personal-subscription model', async () => {
    // The failure this closes: the run was admitted, a branch was created, an environment was
    // provisioned, and only then did the dispatch discover it had no credential to lease, having
    // never asked anyone for one.
    const { app, startTest } = makeApp({ vendors: ['claude'] })
    const res = await startProbe(app)
    expect(res.status).toBe(428)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'credential_required',
    )
    expect(startTest).not.toHaveBeenCalled()
  })

  it('hands the run an activation closure once the password is supplied', async () => {
    const { app, startTest, activateForRun } = makeApp({ vendors: ['claude'] })
    const res = await startProbe(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })
    expect(res.status).toBe(201)
    const activate = startTest.mock.calls[0]![4]
    expect(activate).toBeTypeOf('function')
    // Minted against the RUN id, which is the id the prober's dispatch leases against: an
    // activation keyed on anything else is a credential the probe cannot open.
    await activate!('envtest_1')
    expect(activateForRun).toHaveBeenCalledWith('envtest_1', 'usr_1', 'claude', 'correct horse')
  })

  it('gates the kind the DISPATCH will resolve its model under, never a guess', async () => {
    const { app, probeAgentKind, container } = makeApp({ vendors: ['claude'] })
    await startProbe(app, { [PERSONAL_PASSWORD_HEADER]: 'correct horse' })
    expect(probeAgentKind).toHaveBeenCalledWith('ws_1', 'frame_1')
    expect(container.executionService.individualVendorsForAgentKind).toHaveBeenCalledWith(
      'ws_1',
      'frame_1',
      'environment-prober-api',
      expect.any(Function),
    )
  })

  it('needs no password when the model is not an individual-usage one', async () => {
    const { app, startTest } = makeApp({ vendors: [] })
    const res = await startProbe(app)
    expect(res.status).toBe(201)
    expect(startTest.mock.calls[0]![4]).toBeUndefined()
  })

  it('needs no password for a vendor native local mode serves with the ambient CLI', async () => {
    // Nothing is leased on that path, so demanding an unlock would refuse a run that needs no
    // managed credential. Decided by the same predicate the dispatch's ambient branch uses.
    const { app, startTest } = makeApp({ vendors: ['claude'], nativeAmbientAuth: ['claude-code'] })
    const res = await startProbe(app)
    expect(res.status).toBe(201)
    expect(startTest.mock.calls[0]![4]).toBeUndefined()
  })

  it('leaves the PROVISIONING self-test ungated, since it runs no agent', async () => {
    const { app, startTest, probeAgentKind } = makeApp({ vendors: ['claude'] })
    const res = await app.request('/workspaces/ws_1/blocks/frame_1/environment-test', {
      method: 'POST',
    } as RequestInit)
    expect(res.status).toBe(201)
    expect(probeAgentKind).not.toHaveBeenCalled()
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'provision', undefined)
  })
})
