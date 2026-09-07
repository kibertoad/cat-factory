import type { EnvironmentTestMode, EnvironmentTestRun } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { environmentController } from '../src/modules/environments/EnvironmentController.js'

// The self-test START route, whose one interesting property is a transport one rather than a
// domain one: the route was body-less for its whole life and now carries an ALL-OPTIONAL `{ mode }`
// body. `buildHonoRoute` mounts a validator that reads `c.req.json()` BEFORE consulting the
// schema, so without `optionalJsonBody` in front of it every body-less caller would start getting
// a 400 from a schema that says every field is optional.
//
// `optionalJsonBody`'s own test pins the middleware; what it structurally cannot pin is that THIS
// route mounts it, and which mode a body-less call resolves to. Both are asserted here, by
// driving the real controller and reading what reached the service.

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

function makeApp() {
  const startTest = vi.fn(
    async (
      _workspaceId: string,
      _blockId: string,
      _initiatedBy: string | null,
      mode: EnvironmentTestMode,
    ) => ({ ...RUN, mode }),
  )
  const container = {
    environments: { environmentTest: { startTest } },
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
  return { app, startTest }
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
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'provision')
  })

  it('accepts an explicitly empty body too', async () => {
    const { app, startTest } = makeApp()
    const res = await start(app, { headers: { 'content-length': '0' } })
    expect(res.status).toBe(201)
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'provision')
  })

  it('starts an AGENT DRY RUN when the body names that mode', async () => {
    const { app, startTest } = makeApp()
    const res = await start(app, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent-probe' }),
    })
    expect(res.status).toBe(201)
    expect(startTest).toHaveBeenCalledWith('ws_1', 'frame_1', 'usr_1', 'agent-probe')
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
