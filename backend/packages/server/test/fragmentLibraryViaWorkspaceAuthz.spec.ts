import type { AccountRole, WorkspaceAccessRow, WorkspaceRole } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { fragmentLibraryController } from '../src/modules/fragmentLibrary/FragmentLibraryController.js'

// SEC-RBAC-0: the account-scoped document-fragment routes accept a `viaWorkspaceId` from the
// request body/query and fetch through THAT workspace's stored document-source credentials. The
// account guard only authorized the PATH account, so `viaWorkspaceId` is an unauthorized secondary
// id — it MUST be re-authorized (belongs to the same account AND is accessible to the caller)
// before its secrets are touched, else an account-A member turns workspace B's stored Confluence/
// Notion/GitHub token into a cross-tenant fetch oracle. These tests drive the real controller with
// a faked container (the auth-enabled path the dev-open integration suites can't reach).

/** One workspace's identity + access facts, keyed by id in the fake container below. */
interface WsFacts {
  accountId: string | null
  accessMode: 'account' | 'restricted'
  /** The caller's explicit member row on this board (null = none). */
  memberRole?: WorkspaceRole | null
}

interface Scenario {
  /** The caller's account roles, keyed by account id (drives the escape hatch + account mode). */
  accountRoles?: Record<string, AccountRole[]>
  workspaces: Record<string, WsFacts>
}

const CALLER = 'usr_1'

function mountAccountLibrary(scenario: Scenario) {
  const createFromDocument = vi.fn(
    async (_ownerKind: string, _ownerId: string, _input: unknown, _viaWorkspaceId: string) => ({
      id: 'frag',
      version: '1.0.0',
      title: 'T',
      category: '',
      summary: 's',
      body: 'b',
    }),
  )
  const refresh = vi.fn(async () => ({
    id: 'frag',
    version: '1.0.0',
    title: 'T',
    category: '',
    summary: 's',
    body: 'b',
  }))

  const container = {
    fragmentLibrary: { libraryService: { createFromDocument, refresh } },
    documents: {},
    accountService: {
      // The account guard on the PATH account — always a member in these tests.
      requireMember: async () => {},
      rolesFor: async (accountId: string) => scenario.accountRoles?.[accountId] ?? [],
    },
    workspaceService: {
      accountOf: async (id: string) => scenario.workspaces[id]?.accountId,
      accessRowOf: async (id: string): Promise<WorkspaceAccessRow | undefined> => {
        const ws = scenario.workspaces[id]
        if (!ws) return undefined
        return { accountId: ws.accountId, ownerUserId: null, accessMode: ws.accessMode }
      },
      memberRoleOf: async (id: string) => scenario.workspaces[id]?.memberRole ?? null,
    },
    // Pass-through cache slice (the Worker's isolate-safe shape): `get` just runs the loader.
    caches: {
      workspaceAccess: {
        get: async (_key: string, _group: string, load: () => Promise<unknown>) => load(),
        invalidate: async () => {},
        invalidateGroup: async () => {},
        invalidateAll: async () => {},
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    c.set('user', { id: CALLER } as never)
    await next()
  })
  app.route('/accounts/:accountId', fragmentLibraryController('account'))

  const call = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`https://t.test${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    )
  return { call, createFromDocument, refresh }
}

const docBody = (viaWorkspaceId: string) => ({
  source: 'confluence',
  ref: 'https://wiki.example/page/123',
  viaWorkspaceId,
})

describe('fragment library — account-tier viaWorkspaceId re-authorization (SEC-RBAC-0)', () => {
  it('rejects a viaWorkspaceId in ANOTHER account (404) and never touches its credentials', async () => {
    // Caller is a member of account A; the addressed path account is A. `viaWorkspaceId` points at
    // workspace B in a DIFFERENT account — the confused-deputy attack.
    const { call, createFromDocument } = mountAccountLibrary({
      accountRoles: { acc_A: ['developer'], acc_B: ['developer'] },
      workspaces: { ws_B: { accountId: 'acc_B', accessMode: 'account' } },
    })
    const res = await call('POST', '/accounts/acc_A/document-fragments', docBody('ws_B'))
    expect(res.status).toBe(404) // existence hidden, exactly as the gate hides a foreign board
    expect(createFromDocument).not.toHaveBeenCalled() // the credential fetch never ran
  })

  it('rejects a viaWorkspaceId the caller cannot access, even in the SAME account (404)', async () => {
    // The via workspace is in account A (the path account) but RESTRICTED, and the caller has no
    // member row and is not an account admin — so they can't access it, hence can't fetch through it.
    const { call, createFromDocument } = mountAccountLibrary({
      accountRoles: { acc_A: ['developer'] },
      workspaces: { ws_locked: { accountId: 'acc_A', accessMode: 'restricted', memberRole: null } },
    })
    const res = await call('POST', '/accounts/acc_A/document-fragments', docBody('ws_locked'))
    expect(res.status).toBe(404)
    expect(createFromDocument).not.toHaveBeenCalled()
  })

  it('allows a viaWorkspaceId in the same account the caller CAN access (201)', async () => {
    // Account-mode board in account A: every account member (the caller is a developer) may access
    // it, so fetching through its connection is authorized.
    const { call, createFromDocument } = mountAccountLibrary({
      accountRoles: { acc_A: ['developer'] },
      workspaces: { ws_ok: { accountId: 'acc_A', accessMode: 'account' } },
    })
    const res = await call('POST', '/accounts/acc_A/document-fragments', docBody('ws_ok'))
    expect(res.status).toBe(201)
    expect(createFromDocument).toHaveBeenCalledOnce()
    // The service is invoked with the re-authorized workspace id.
    expect(createFromDocument.mock.calls[0]?.[3]).toBe('ws_ok')
  })

  it('rejects a nonexistent viaWorkspaceId (404, accountOf undefined)', async () => {
    const { call, createFromDocument } = mountAccountLibrary({
      accountRoles: { acc_A: ['developer'] },
      workspaces: {},
    })
    const res = await call('POST', '/accounts/acc_A/document-fragments', docBody('ws_ghost'))
    expect(res.status).toBe(404)
    expect(createFromDocument).not.toHaveBeenCalled()
  })

  it('applies the same re-authorization to the account-tier refresh (query viaWorkspaceId)', async () => {
    const { call, refresh } = mountAccountLibrary({
      accountRoles: { acc_A: ['developer'], acc_B: ['developer'] },
      workspaces: { ws_B: { accountId: 'acc_B', accessMode: 'account' } },
    })
    const res = await call(
      'POST',
      '/accounts/acc_A/prompt-fragments/some-frag/refresh?viaWorkspaceId=ws_B',
    )
    expect(res.status).toBe(404)
    expect(refresh).not.toHaveBeenCalled()
  })
})
