import type { AccountRole, WorkspaceAccessRow, WorkspaceRole } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, HmacSigner, type SessionPayload } from '../src/auth/signing.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { mountAuthGate } from '../src/http/authGate.js'
import { handleError } from '../src/http/errorHandler.js'

// Unit-test the shared gate directly with a faked container — including the workspace-RBAC
// resolution branch (default-account overlay, restricted-board sole grant, the account-admin
// escape hatch) + the viewer write floor, which the facade integration suites can only reach
// with a real session + datastore. The Node/Worker facades both call mountAuthGate, so this
// is the single source of truth for default-deny + public-bypass + RBAC resolution rules.

const SECRET = 's'.repeat(32)

interface FakeOpts {
  enabled?: boolean
  devOpen?: boolean
  accessRowOf?: (id: string) => Promise<WorkspaceAccessRow | undefined>
  rolesFor?: (accountId: string, userId: string) => Promise<AccountRole[]>
  memberRoleOf?: (workspaceId: string, userId: string) => Promise<WorkspaceRole | null>
}

function makeApp(opts: FakeOpts = {}) {
  const container = {
    config: {
      auth: {
        enabled: opts.enabled ?? true,
        devOpen: opts.devOpen ?? false,
        sessionSecret: SECRET,
      },
    },
    workspaceService: {
      accessRowOf: opts.accessRowOf ?? (async () => undefined),
      memberRoleOf: opts.memberRoleOf ?? (async () => null),
    },
    accountService: { rolesFor: opts.rolesFor ?? (async () => []) },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  mountAuthGate(app)
  // Echo the resolved access so the RBAC assertions can read the role the gate published.
  app.all('*', (c) => {
    const access = c.get('workspaceAccess')
    return c.json({
      ok: true,
      access: access ? { role: access.role, permissions: [...access.permissions] } : null,
    })
  })

  return (method: string, path: string, token?: string) =>
    app.fetch(
      new Request(`https://t.test${path}`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    )
}

async function sessionToken(id: string): Promise<string> {
  const payload: SessionPayload = {
    id,
    login: 'octocat',
    name: null,
    avatarUrl: null,
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 3_600_000,
  }
  return new HmacSigner(SECRET).sign(payload)
}

const legacy = (ownerUserId: string | null): WorkspaceAccessRow => ({
  accountId: null,
  ownerUserId,
  accessMode: 'account',
})
const scoped = (accessMode: 'account' | 'restricted'): WorkspaceAccessRow => ({
  accountId: 'acc_1',
  ownerUserId: null,
  accessMode,
})

async function roleOf(res: Response): Promise<WorkspaceRole | null> {
  return ((await res.json()) as { access: { role: WorkspaceRole } | null }).access?.role ?? null
}

describe('mountAuthGate — default-deny', () => {
  it('allows /health and public prefixes, denies protected routes without a session', async () => {
    const call = makeApp()
    expect((await call('GET', '/health')).status).toBe(200)
    expect((await call('GET', '/auth/login')).status).toBe(200)
    expect((await call('GET', '/v1/chat')).status).toBe(200)
    expect((await call('GET', '/workspaces')).status).toBe(401)
  })

  it('fails closed (503) when auth is unconfigured and dev-open is off', async () => {
    const call = makeApp({ enabled: false, devOpen: false })
    expect((await call('GET', '/workspaces')).status).toBe(503)
  })

  it('passes through when dev-open is on', async () => {
    const call = makeApp({ enabled: false, devOpen: true })
    expect((await call('GET', '/workspaces')).status).toBe(200)
  })
})

describe('mountAuthGate — workspace-RBAC resolution', () => {
  it('skips the unscoped /workspaces collection', async () => {
    const call = makeApp()
    expect((await call('GET', '/workspaces', await sessionToken('usr_1'))).status).toBe(200)
  })

  it('lets the handler 404 a missing board (accessRowOf undefined)', async () => {
    const call = makeApp({ accessRowOf: async () => undefined })
    const res = await call('GET', '/workspaces/ws_x/blocks', await sessionToken('usr_1'))
    expect(res.status).toBe(200)
    expect(await roleOf(res)).toBeNull() // no access published for a missing board
  })

  it('legacy board: only the owner may access it (else 404)', async () => {
    const owned = makeApp({ accessRowOf: async () => legacy('usr_1') })
    const ok = await owned('GET', '/workspaces/ws_x', await sessionToken('usr_1'))
    expect(ok.status).toBe(200)
    expect(await roleOf(ok)).toBe('admin')
    const foreign = makeApp({ accessRowOf: async () => legacy('usr_2') })
    const res = await foreign('GET', '/workspaces/ws_x', await sessionToken('usr_1'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('account mode: an account member resolves to member; a non-member gets 404', async () => {
    const member = makeApp({
      accessRowOf: async () => scoped('account'),
      rolesFor: async () => ['developer'],
    })
    const ok = await member('GET', '/workspaces/ws_x', await sessionToken('usr_1'))
    expect(ok.status).toBe(200)
    expect(await roleOf(ok)).toBe('member')
    const outsider = makeApp({
      accessRowOf: async () => scoped('account'),
      rolesFor: async () => [],
    })
    expect((await outsider('GET', '/workspaces/ws_x', await sessionToken('usr_1'))).status).toBe(
      404,
    )
  })

  it('account admin is a workspace admin even with no member row (escape hatch)', async () => {
    const call = makeApp({
      accessRowOf: async () => scoped('restricted'),
      rolesFor: async () => ['admin'],
    })
    const res = await call('GET', '/workspaces/ws_x', await sessionToken('usr_1'))
    expect(res.status).toBe(200)
    expect(await roleOf(res)).toBe('admin')
  })

  it('restricted board: the member row is the sole grant; no row ⇒ 404', async () => {
    const denied = makeApp({
      accessRowOf: async () => scoped('restricted'),
      rolesFor: async () => ['developer'],
      memberRoleOf: async () => null,
    })
    expect((await denied('GET', '/workspaces/ws_x', await sessionToken('usr_1'))).status).toBe(404)
    const viewer = makeApp({
      accessRowOf: async () => scoped('restricted'),
      rolesFor: async () => ['developer'],
      memberRoleOf: async () => 'viewer',
    })
    const res = await viewer('GET', '/workspaces/ws_x', await sessionToken('usr_1'))
    expect(res.status).toBe(200)
    expect(await roleOf(res)).toBe('viewer')
  })
})

describe('mountAuthGate — viewer write floor', () => {
  const asViewer = () =>
    makeApp({
      accessRowOf: async () => scoped('restricted'),
      rolesFor: async () => ['developer'],
      memberRoleOf: async () => 'viewer',
    })

  it('lets a viewer read but rejects any state-changing method with 403', async () => {
    const call = asViewer()
    const token = await sessionToken('usr_1')
    expect((await call('GET', '/workspaces/ws_x', token)).status).toBe(200)
    const patch = await call('PATCH', '/workspaces/ws_x', token)
    expect(patch.status).toBe(403)
    expect(((await patch.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    expect((await call('POST', '/workspaces/ws_x/blocks', token)).status).toBe(403)
  })

  it('allowlists the read-only stream ticket mint for a viewer', async () => {
    const call = asViewer()
    expect(
      (await call('POST', '/workspaces/ws_x/events/ticket', await sessionToken('usr_1'))).status,
    ).toBe(200)
  })

  it('lets a member pass the floor on a write', async () => {
    const call = makeApp({
      accessRowOf: async () => scoped('restricted'),
      rolesFor: async () => ['developer'],
      memberRoleOf: async () => 'member',
    })
    expect((await call('PATCH', '/workspaces/ws_x', await sessionToken('usr_1'))).status).toBe(200)
  })
})
