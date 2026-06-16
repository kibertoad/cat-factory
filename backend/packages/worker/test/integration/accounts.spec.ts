import type { Account, GitHubConnection, Workspace, WorkspaceSnapshot } from '@cat-factory/core'
import type { CoreDependencies } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import {
  HmacSigner,
  TOKEN_AUDIENCE,
  type SessionPayload,
} from '../../src/infrastructure/auth/signing'
import { githubDeps, uniqueInstallationId } from '../helpers'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

// Account tenancy is an authenticated concept, so these run with auth ENABLED —
// minting session tokens directly (mirroring auth.spec) and passing a tailored
// env to app.fetch. Each test uses fresh user ids so the shared D1 stays isolated.

const SECRET = 'test-session-secret-0123456789abcdef'
const BASE = 'https://cat-factory.test'

const authEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: SECRET,
} as typeof env

interface TestUser {
  id: number
  login: string
}

let nextUserId = 700_000
function user(login: string): TestUser {
  return { id: ++nextUserId, login }
}

function token(u: TestUser): Promise<string> {
  const payload: SessionPayload = {
    aud: TOKEN_AUDIENCE.session,
    id: u.id,
    login: u.login,
    name: u.login,
    avatarUrl: null,
    exp: Date.now() + 60_000,
  }
  return new HmacSigner(SECRET).sign(payload)
}

function makeApp(overrides?: Partial<CoreDependencies>) {
  const app = createApp(overrides ? { overrides } : {})
  async function call<T = unknown>(
    u: TestUser,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { authorization: `Bearer ${await token(u)}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      authEnv,
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }
  return { call }
}

describe('accounts', () => {
  it('gives each user a personal account on first listing', async () => {
    const { call } = makeApp()
    const alice = user('alice')
    const res = await call<Account[]>(alice, 'GET', '/accounts')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]!.type).toBe('personal')
    expect(res.body[0]!.role).toBe('owner')
    expect(res.body[0]!.githubAccountLogin).toBe('alice')
  })

  it('scopes workspace visibility to account members', async () => {
    const { call } = makeApp()
    const alice = user('alice')
    const bob = user('bob')

    const org = (await call<Account>(alice, 'POST', '/accounts', { name: 'Acme' })).body
    const board = (
      await call<WorkspaceSnapshot>(alice, 'POST', '/workspaces', {
        accountId: org.id,
        seed: false,
        name: 'Org board',
      })
    ).body.workspace

    // Alice (owner) sees it; Bob (not a member) does not, and cannot open it.
    const aliceList = await call<Workspace[]>(alice, 'GET', '/workspaces')
    expect(aliceList.body.map((w) => w.id)).toContain(board.id)

    const bobList = await call<Workspace[]>(bob, 'GET', '/workspaces')
    expect(bobList.body.map((w) => w.id)).not.toContain(board.id)
    expect((await call(bob, 'GET', `/workspaces/${board.id}`)).status).toBe(404)

    // Bob cannot create a board in an account he doesn't belong to.
    const denied = await call(bob, 'POST', '/workspaces', { accountId: org.id, seed: false })
    expect(denied.status).toBe(404)

    // Once added, Bob sees and can open the board.
    const added = await call(alice, 'POST', `/accounts/${org.id}/members`, { userId: bob.id })
    expect(added.status).toBe(201)
    const bobList2 = await call<Workspace[]>(bob, 'GET', '/workspaces')
    expect(bobList2.body.map((w) => w.id)).toContain(board.id)
    expect((await call(bob, 'GET', `/workspaces/${board.id}`)).status).toBe(200)
  })

  it('only an owner can add members, and not to a personal account', async () => {
    const { call } = makeApp()
    const alice = user('alice')
    const carol = user('carol')

    const personal = (await call<Account[]>(alice, 'GET', '/accounts')).body[0]!
    const toPersonal = await call(alice, 'POST', `/accounts/${personal.id}/members`, {
      userId: carol.id,
    })
    expect(toPersonal.status).toBe(422)

    // A non-member cannot manage an org's roster (reported as 404, not 403).
    const org = (await call<Account>(alice, 'POST', '/accounts', { name: 'Acme' })).body
    const byOutsider = await call(carol, 'POST', `/accounts/${org.id}/members`, { userId: 999 })
    expect(byOutsider.status).toBe(404)
  })

  it('shares one installation across every workspace in the account', async () => {
    const client = new FakeGitHubClient()
    client.installation = { accountLogin: 'acme', targetType: 'Organization' }
    const { call } = makeApp(githubDeps({ client }))
    const alice = user('alice')

    const org = (await call<Account>(alice, 'POST', '/accounts', { name: 'Acme' })).body
    const wsA = (
      await call<WorkspaceSnapshot>(alice, 'POST', '/workspaces', {
        accountId: org.id,
        seed: false,
      })
    ).body.workspace
    const wsB = (
      await call<WorkspaceSnapshot>(alice, 'POST', '/workspaces', {
        accountId: org.id,
        seed: false,
      })
    ).body.workspace

    // Connect the installation through one board…
    const installationId = uniqueInstallationId()
    const connected = await call(alice, 'POST', `/workspaces/${wsA.id}/github/connect`, {
      installationId,
    })
    expect(connected.status).toBe(201)

    // …and the OTHER board in the same account sees it as connected (shared).
    const onB = await call<{ connection: GitHubConnection | null }>(
      alice,
      'GET',
      `/workspaces/${wsB.id}/github/connection`,
    )
    expect(onB.body.connection?.installationId).toBe(installationId)
  })

  it('rejects sharing an installation across different accounts', async () => {
    const client = new FakeGitHubClient()
    const { call } = makeApp(githubDeps({ client }))
    const alice = user('alice')

    // A board in Alice's personal account, and one in an org she owns.
    const personalBoard = (
      await call<WorkspaceSnapshot>(alice, 'POST', '/workspaces', { seed: false })
    ).body.workspace
    const org = (await call<Account>(alice, 'POST', '/accounts', { name: 'Acme' })).body
    const orgBoard = (
      await call<WorkspaceSnapshot>(alice, 'POST', '/workspaces', {
        accountId: org.id,
        seed: false,
      })
    ).body.workspace

    const installationId = uniqueInstallationId()
    expect(
      (
        await call(alice, 'POST', `/workspaces/${personalBoard.id}/github/connect`, {
          installationId,
        })
      ).status,
    ).toBe(201)
    // Same installation, a different account → conflict (cross-tenant guard).
    const conflict = await call(alice, 'POST', `/workspaces/${orgBoard.id}/github/connect`, {
      installationId,
    })
    expect(conflict.status).toBe(409)
  })
})
