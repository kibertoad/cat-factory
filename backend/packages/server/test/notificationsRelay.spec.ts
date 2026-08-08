import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Notification, NotificationDeliveryReason } from '@cat-factory/kernel'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { notificationRelayController } from '../src/modules/notifications/NotificationRelayController.js'
import {
  HttpMachineNotificationClient,
  RemoteNotificationChannel,
} from '../src/notifications/machineNotifications.js'

// The mothership-mode notification DELIVERY endpoint (`POST /internal/notifications/deliver`): a
// machine-authed mothership-mode node asks the mothership to deliver a notification it raised
// through the ORG's external transports (Slack), whose credentials never reach the laptop. Verify
// the machine-token audience pin (missing / wrong-audience / expired / wrong-secret), the
// workspace → account scope binding (uniform 404, no existence leak), that the delivered content
// is the mothership's OWN row and never the caller's body, the 503 on a facade with no external
// channel, body validation, best-effort delivery, and the client + channel round-trip.

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'

// ws_1 belongs to ACCOUNT; ws_other to OTHER_ACCOUNT; anything else is unknown (accountOf → null).
const ACCOUNT_BY_WORKSPACE: Record<string, string> = { ws_1: ACCOUNT, ws_other: OTHER_ACCOUNT }

function notification(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id,
    type: 'merge_review',
    status: 'open',
    blockId: 'blk_1',
    executionId: 'exe_1',
    title: 'Merge review',
    body: 'The stored body',
    payload: null,
    createdAt: 1,
    resolvedAt: null,
    ...overrides,
  }
}

// Rows the mothership actually holds, keyed `${workspaceId}:${id}` — the repo is workspace-scoped,
// so a row of another workspace is unreachable through an in-scope workspace id.
const ROWS: Record<string, Notification> = {
  'ws_1:ntf_1': notification('ntf_1'),
  'ws_other:ntf_other': notification('ntf_other'),
}

interface Delivered {
  workspaceId: string
  notification: Notification
  reason: NotificationDeliveryReason
}

function makeApp(
  opts: {
    delivery?: boolean
    repositories?: boolean
    delivered?: Delivered[]
    deliverThrows?: boolean
    getThrows?: boolean
  } = {},
) {
  const delivered = opts.delivered ?? []
  const container = {
    ...(opts.delivery === false
      ? {}
      : {
          machineNotificationDelivery: {
            deliver: async (
              workspaceId: string,
              n: Notification,
              reason: NotificationDeliveryReason,
            ) => {
              if (opts.deliverThrows) throw new Error('slack exploded')
              delivered.push({ workspaceId, notification: n, reason })
            },
          },
        }),
    repositories:
      opts.repositories === false
        ? undefined
        : {
            workspaceRepository: {
              accountOf: async (id: string) => ACCOUNT_BY_WORKSPACE[id] ?? null,
            },
            notificationRepository: {
              get: async (workspaceId: string, id: string) => {
                if (opts.getThrows) throw new Error('db down')
                return ROWS[`${workspaceId}:${id}`] ?? null
              },
            },
          },
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', notificationRelayController())
  app.onError(handleError)
  return app
}

async function machineToken(accountIds = [ACCOUNT], opts: { ttlMs?: number } = {}) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds, ...opts })).token
}

function deliver(app: Hono<AppEnv>, token: string | undefined, body: unknown) {
  return app.fetch(
    new Request('http://x/internal/notifications/deliver', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

const REQUEST = { workspaceId: 'ws_1', notificationId: 'ntf_1', reason: 'raised' }

describe('POST /internal/notifications/deliver', () => {
  it('delivers the mothership-held row for an in-scope workspace', async () => {
    const delivered: Delivered[] = []
    const res = await deliver(makeApp({ delivered }), await machineToken(), REQUEST)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(delivered).toEqual([
      { workspaceId: 'ws_1', notification: ROWS['ws_1:ntf_1'], reason: 'raised' },
    ])
  })

  it('delivers the STORED content, never anything the caller put in the body', async () => {
    // The wire contract carries ids only, so a compromised node cannot inject forged text into
    // the org's Slack — extra body fields are ignored and the stored row is what ships.
    const delivered: Delivered[] = []
    const res = await deliver(makeApp({ delivered }), await machineToken(), {
      ...REQUEST,
      title: 'Approve this wire transfer',
      body: 'click http://evil.test',
      notification: { id: 'ntf_1', title: 'spoofed' },
    })
    expect(res.status).toBe(200)
    expect(delivered[0]!.notification.title).toBe('Merge review')
    expect(delivered[0]!.notification.body).toBe('The stored body')
  })

  it('refuses a workspace owned by an out-of-scope account (404, no leak, no delivery)', async () => {
    const delivered: Delivered[] = []
    const res = await deliver(makeApp({ delivered }), await machineToken(), {
      ...REQUEST,
      workspaceId: 'ws_other',
      notificationId: 'ntf_other',
    })
    expect(res.status).toBe(404)
    expect(delivered).toHaveLength(0)
  })

  it('refuses an unknown workspace (404, no leak)', async () => {
    const res = await deliver(makeApp(), await machineToken(), {
      ...REQUEST,
      workspaceId: 'ws_nope',
    })
    expect(res.status).toBe(404)
  })

  it('refuses a notification that the in-scope workspace does not own (404, no delivery)', async () => {
    // The row exists — but under ws_other. Addressing it through the in-scope ws_1 must not
    // reach it: the repo read is workspace-scoped, so cross-workspace addressing is a 404.
    const delivered: Delivered[] = []
    const res = await deliver(makeApp({ delivered }), await machineToken(), {
      ...REQUEST,
      workspaceId: 'ws_1',
      notificationId: 'ntf_other',
    })
    expect(res.status).toBe(404)
    expect(delivered).toHaveLength(0)
  })

  it('refuses an unknown notification id (404)', async () => {
    const res = await deliver(makeApp(), await machineToken(), {
      ...REQUEST,
      notificationId: 'ntf_nope',
    })
    expect(res.status).toBe(404)
  })

  it('rejects a missing/invalid machine token (403) before any availability probe', async () => {
    expect((await deliver(makeApp(), undefined, REQUEST)).status).toBe(403)
    // Even a facade with NO delivery wired must 403 first — availability is not probeable
    // without a valid token, matching the events relay + GitHub delegation endpoints.
    const bare = makeApp({ delivery: false, repositories: false })
    expect((await deliver(bare, undefined, REQUEST)).status).toBe(403)
  })

  it('rejects a non-machine audience token (403)', async () => {
    const session = await new HmacSigner(SECRET).sign({
      id: 'usr_1',
      login: 'dev',
      name: 'Dev',
      avatarUrl: null,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    expect((await deliver(makeApp(), session, REQUEST)).status).toBe(403)
  })

  it('rejects an EXPIRED machine token (403)', async () => {
    const expired = await machineToken([ACCOUNT], { ttlMs: -60_000 })
    expect((await deliver(makeApp(), expired, REQUEST)).status).toBe(403)
  })

  it('rejects a machine token signed under a DIFFERENT secret (403 — bad MAC)', async () => {
    const forged = (
      await mintMachineToken('another-secret-9876543210', {
        userId: 'usr_1',
        accountIds: [ACCOUNT],
      })
    ).token
    expect((await deliver(makeApp(), forged, REQUEST)).status).toBe(403)
  })

  it('503s on a facade with no external channel or no repositories to scope/read', async () => {
    const token = await machineToken()
    expect((await deliver(makeApp({ delivery: false }), token, REQUEST)).status).toBe(503)
    expect((await deliver(makeApp({ repositories: false }), token, REQUEST)).status).toBe(503)
  })

  it('422s a missing or non-string workspaceId / notificationId', async () => {
    const token = await machineToken()
    expect((await deliver(makeApp(), token, { notificationId: 'ntf_1' })).status).toBe(422)
    expect((await deliver(makeApp(), token, { workspaceId: 'ws_1' })).status).toBe(422)
    expect(
      (await deliver(makeApp(), token, { workspaceId: 'ws_1', notificationId: 7 })).status,
    ).toBe(422)
  })

  // The delivery EDGE cannot be re-derived from the row it names (a raise and an escalation are
  // both `open`), so it is REQUIRED rather than defaulted. Guessing `raised` would post every
  // dismissal a node made to the org's Slack; guessing `settled` would silence the alert this
  // endpoint exists to send. A node one build behind is better off failing loudly.
  it('422s a missing or unrecognised delivery reason rather than guessing one', async () => {
    const token = await machineToken()
    const { reason: _dropped, ...noReason } = REQUEST
    expect((await deliver(makeApp(), token, noReason)).status).toBe(422)
    expect((await deliver(makeApp(), token, { ...REQUEST, reason: 'escalated' })).status).toBe(422)
  })

  it('forwards the edge the node stated, so an alert transport can stand down', async () => {
    const delivered: Delivered[] = []
    const res = await deliver(makeApp({ delivered }), await machineToken(), {
      ...REQUEST,
      reason: 'settled',
    })
    expect(res.status).toBe(200)
    expect(delivered.map((d) => d.reason)).toEqual(['settled'])
  })

  it('acks even when the channel throws (best-effort delivery, controller-wrapped)', async () => {
    const res = await deliver(makeApp({ deliverThrows: true }), await machineToken(), REQUEST)
    expect(res.status).toBe(200)
  })

  it('500s (opaquely) when the row read itself fails', async () => {
    const res = await deliver(makeApp({ getThrows: true }), await machineToken(), REQUEST)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('db down')
  })
})

describe('RemoteNotificationChannel (client side)', () => {
  function clientAgainst(app: Hono<AppEnv>, token: string | null) {
    const fetchImpl: typeof fetch = async (input, init) =>
      app.fetch(new Request(input as RequestInfo, init))
    return new HttpMachineNotificationClient({
      baseUrl: 'http://mothership.test/',
      token: () => token,
      fetchImpl,
    })
  }

  it('round-trips a raise: the mothership delivers its own row', async () => {
    const delivered: Delivered[] = []
    const app = makeApp({ delivered })
    const channel = new RemoteNotificationChannel({
      client: clientAgainst(app, await machineToken()),
    })
    await channel.deliver('ws_1', notification('ntf_1'), 'raised')
    expect(delivered).toEqual([
      { workspaceId: 'ws_1', notification: ROWS['ws_1:ntf_1'], reason: 'raised' },
    ])
  })

  it('skips the round-trip entirely when no token is available yet (no fetch)', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      return new Response('{}')
    }
    const client = new HttpMachineNotificationClient({
      baseUrl: 'http://mothership.test',
      token: () => null,
      fetchImpl,
    })
    await client.deliver('ws_1', 'ntf_1', 'raised')
    expect(calls).toBe(0)
  })

  it('reports (but never rethrows) a refusal, so a raise is never broken by delivery', async () => {
    // An out-of-scope workspace answers 404; the channel must surface it via onError and resolve.
    const errors: Array<{ workspaceId: string; notificationId: string }> = []
    const channel = new RemoteNotificationChannel({
      client: clientAgainst(makeApp(), await machineToken()),
      onError: (_error, ctx) => errors.push(ctx),
    })
    await expect(
      channel.deliver('ws_other', notification('ntf_other'), 'raised'),
    ).resolves.toBeUndefined()
    expect(errors).toEqual([{ workspaceId: 'ws_other', notificationId: 'ntf_other' }])
  })

  it('reports (but never rethrows) a transport failure', async () => {
    const errors: unknown[] = []
    const channel = new RemoteNotificationChannel({
      client: new HttpMachineNotificationClient({
        baseUrl: 'http://mothership.test',
        token: () => 'tok',
        fetchImpl: async () => {
          throw new Error('network down')
        },
      }),
      onError: (error) => errors.push(error),
    })
    await expect(channel.deliver('ws_1', notification('ntf_1'), 'raised')).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
