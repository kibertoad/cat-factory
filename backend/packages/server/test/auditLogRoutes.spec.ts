import { listAuditEventsContract, revokeMemberSessionsContract } from '@cat-factory/contracts'
import type { AuditEventPage, AuditEventView } from '@cat-factory/kernel'
import { requestByContract } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { accountController } from '../src/modules/accounts/AccountController.js'

// The audit log's HTTP surface. What is worth pinning here is everything the CONTROLLER decides,
// as opposed to what the store or the service decides: that an unwired store refuses instead of
// answering "nothing happened", that the page is enriched with display names in ONE batched read,
// that a name which cannot be resolved renders as null rather than a placeholder, and that the
// cursor round-trips untouched.

const EVENT: AuditEventView = {
  id: 'aud_1',
  accountId: 'acc_1',
  workspaceId: null,
  actor: { kind: 'user', userId: 'usr_actor' },
  action: 'account.member_added',
  targetType: 'user',
  targetId: 'usr_target',
  details: { roles: 'developer' },
  at: 1_700_000_000_000,
}

function makeApp(
  options: {
    page?: AuditEventPage
    /** Omit the reader entirely, as a facade with no audit store would. */
    noReader?: boolean
    listByAccount?: (
      accountId: string,
      opts?: { cursor?: string | null; limit?: number },
    ) => unknown
    users?: { id: string; name: string | null; email: string | null }[]
    listByIds?: ReturnType<typeof vi.fn>
    requireAdmin?: () => Promise<unknown>
    revokeMemberSessions?: ReturnType<typeof vi.fn>
  } = {},
) {
  const listByIds =
    options.listByIds ??
    vi.fn((ids: string[]) =>
      Promise.resolve(
        (options.users ?? [{ id: 'usr_actor', name: 'Ada', email: null }]).filter((u) =>
          ids.includes(u.id),
        ),
      ),
    )
  const container = {
    accountService: {
      requireAdmin: options.requireAdmin ?? (() => Promise.resolve({})),
      requireMember: () => Promise.resolve({}),
      revokeMemberSessions: options.revokeMemberSessions ?? vi.fn(() => Promise.resolve()),
    },
    userService: { listByIds },
    ...(options.noReader
      ? {}
      : {
          auditLogReader: {
            listByAccount:
              options.listByAccount ??
              (() => Promise.resolve(options.page ?? { events: [EVENT], nextCursor: null })),
          },
        }),
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    c.set('user', {
      id: 'usr_admin',
      login: 'admin',
      name: null,
      avatarUrl: null,
      aud: 'session',
      exp: 0,
      gen: 0,
    })
    await next()
  })
  app.route('/', accountController())
  app.onError(handleError)
  return { app, container, listByIds }
}

describe('GET /accounts/:accountId/audit-events', () => {
  it('serves a page, enriching the actor and target from ONE batched read', async () => {
    const { app, listByIds } = makeApp({
      users: [
        { id: 'usr_actor', name: 'Ada Lovelace', email: null },
        { id: 'usr_target', name: null, email: 'grace@acme.com' },
      ],
    })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Record<string, unknown>[]; nextCursor: null }
    expect(body.events[0]).toMatchObject({
      id: 'aud_1',
      action: 'account.member_added',
      actorName: 'Ada Lovelace',
      // Falls back to the email when a user carries no display name, so a row never renders a
      // bare id for somebody the roster can still identify.
      targetName: 'grace@acme.com',
    })
    // ONE query for the whole page, never a lookup per row: a 50-event page would otherwise be up
    // to 100 point reads.
    expect(listByIds).toHaveBeenCalledTimes(1)
    expect([...(listByIds.mock.calls[0]![0] as string[])].sort()).toEqual([
      'usr_actor',
      'usr_target',
    ])
  })

  it('renders an unresolvable name as null rather than a placeholder', async () => {
    // The case an audit log most needs to survive: the person is gone, and their having been here
    // is exactly what the row records. The viewer shows the id; it must not show an empty space,
    // and the row must not be dropped.
    const { app } = makeApp({ users: [] })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    const body = (await res.json()) as { events: { actorName: null; targetName: null }[] }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ actorName: null, targetName: null })
  })

  it('resolves no name for a system actor, and asks the roster for nobody', async () => {
    // `system` asserts the engine acted. It has no id to resolve, and querying for one would be
    // the first step towards rendering it like a user whose name merely failed to load.
    const { app, listByIds } = makeApp({
      page: {
        events: [{ ...EVENT, actor: { kind: 'system' }, targetType: 'account', targetId: 'acc_1' }],
        nextCursor: null,
      },
    })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    const body = (await res.json()) as { events: { actorName: null }[] }
    expect(body.events[0]!.actorName).toBeNull()
    expect(listByIds).not.toHaveBeenCalled()
  })

  it('passes the cursor through untouched and hands the next one back', async () => {
    // The cursor is opaque and round-trips through a URL; the controller must not parse, clamp or
    // re-encode it, or the keyset silently starts a page somewhere else.
    const seen: (string | null | undefined)[] = []
    const { app } = makeApp({
      listByAccount: (_id, opts) => {
        seen.push(opts?.cursor)
        return Promise.resolve({ events: [], nextCursor: '1700000000000:aud_9' })
      },
    })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: { cursor: '1699999999999:aud_5' },
    })

    expect(seen).toEqual(['1699999999999:aud_5'])
    expect(await res.json()).toMatchObject({ nextCursor: '1700000000000:aud_9' })
  })

  it('REFUSES with a 503 when no audit store is wired, never an empty page', async () => {
    // "Nothing has happened in this account" and "this deployment records nothing" are opposite
    // facts, and the first is the assurance the log exists to give.
    const { app } = makeApp({ noReader: true })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    expect(res.status).toBe(503)
  })

  it('PROPAGATES a store failure instead of serving an empty log', async () => {
    // The read has the opposite disposition from the write: an admin shown an empty page because
    // the store was unreachable has been told the reverse of the truth.
    const { app } = makeApp({
      listByAccount: () => Promise.reject(new Error('store down')),
    })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    expect(res.status).toBe(500)
  })

  it('refuses a non-admin, and reads nothing on the way out', async () => {
    const listByAccount = vi.fn(() => Promise.resolve({ events: [], nextCursor: null }))
    const { app } = makeApp({
      listByAccount,
      requireAdmin: () => Promise.reject(Object.assign(new Error('nope'), { status: 403 })),
    })

    const res = await requestByContract(app, listAuditEventsContract, {
      pathParams: { accountId: 'acc_1' },
      queryParams: {},
    })

    expect(res.status).toBe(500)
    expect(listByAccount).not.toHaveBeenCalled()
  })
})

describe('POST /accounts/:accountId/members/:userId/revoke-sessions', () => {
  it('delegates to the service (which owns the gate and the audit row) and answers 204', async () => {
    const revokeMemberSessions = vi.fn(() => Promise.resolve())
    const { app } = makeApp({ revokeMemberSessions })

    const res = await requestByContract(app, revokeMemberSessionsContract, {
      pathParams: { accountId: 'acc_1', userId: 'usr_target' },
    })

    expect(res.status).toBe(204)
    // Actor first, target second — reversing them would revoke the admin's own sessions on every
    // offboarding, which no status code would reveal.
    expect(revokeMemberSessions).toHaveBeenCalledWith('acc_1', 'usr_admin', 'usr_target')
  })
})
