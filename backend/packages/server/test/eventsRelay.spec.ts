import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import { HttpMachineEventClient, type RelayedRealtimeEvent } from '../src/events/machineEvents.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { eventsRelayController } from '../src/modules/events/EventsRelayController.js'

// The mothership-mode real-time UPSTREAM endpoint (`POST /internal/events/publish`): a
// machine-authed mothership-mode node forwards its engine events so the mothership's own realtime
// fan-out (hosted teammates on the shared board) sees the local node's activity live. Verify the
// machine-token audience pin (missing / wrong-audience / expired / wrong-secret), the workspace →
// account scope binding (uniform 404, no existence leak), the 503 on a non-mothership facade, the
// body validation, that a delivered event reaches the relay verbatim, and the client-side
// HttpMachineEventClient round-trip (incl. the token-less skip).

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'

// WS_1 belongs to ACCOUNT; WS_OTHER to OTHER_ACCOUNT; anything else is unknown (accountOf → null).
const ACCOUNT_BY_WORKSPACE: Record<string, string> = { ws_1: ACCOUNT, ws_other: OTHER_ACCOUNT }

function makeApp(
  opts: { relay?: boolean; repositories?: boolean; ingested?: RelayedRealtimeEvent[] } = {},
) {
  const ingested = opts.ingested ?? []
  const container = {
    ...(opts.relay === false
      ? {}
      : { machineEventRelay: { ingest: (event: RelayedRealtimeEvent) => void ingested.push(event) } }),
    repositories:
      opts.repositories === false
        ? undefined
        : { workspaceRepository: { accountOf: async (id: string) => ACCOUNT_BY_WORKSPACE[id] ?? null } },
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', eventsRelayController())
  app.onError(handleError)
  return app
}

async function machineToken(accountIds = [ACCOUNT], opts: { ttlMs?: number } = {}) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds, ...opts })).token
}

function publish(app: Hono<AppEnv>, token: string | undefined, body: unknown) {
  return app.fetch(
    new Request('http://x/internal/events/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

const EVENT = { workspaceId: 'ws_1', payload: '{"type":"board","reason":"x","at":1}' }

describe('POST /internal/events/publish', () => {
  it('delivers an in-scope event to the relay verbatim (payload + originConnectionId)', async () => {
    const ingested: RelayedRealtimeEvent[] = []
    const res = await publish(makeApp({ ingested }), await machineToken(), {
      ...EVENT,
      originConnectionId: 'cid_7',
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(ingested).toEqual([
      { workspaceId: 'ws_1', payload: EVENT.payload, originConnectionId: 'cid_7' },
    ])
  })

  it('normalises a missing originConnectionId to null', async () => {
    const ingested: RelayedRealtimeEvent[] = []
    await publish(makeApp({ ingested }), await machineToken(), EVENT)
    expect(ingested[0]!.originConnectionId).toBeNull()
  })

  it('refuses a workspace owned by an out-of-scope account (404, no leak, no delivery)', async () => {
    const ingested: RelayedRealtimeEvent[] = []
    const res = await publish(makeApp({ ingested }), await machineToken(), {
      ...EVENT,
      workspaceId: 'ws_other',
    })
    expect(res.status).toBe(404)
    expect(ingested).toHaveLength(0)
  })

  it('refuses an unknown workspace (404, no leak)', async () => {
    const res = await publish(makeApp(), await machineToken(), { ...EVENT, workspaceId: 'ws_nope' })
    expect(res.status).toBe(404)
  })

  it('rejects a missing/invalid machine token (403) before any availability probe', async () => {
    expect((await publish(makeApp(), undefined, EVENT)).status).toBe(403)
    // Even a facade with NO relay wired must 403 first — availability is not probeable
    // without a valid token (this is what the shared symmetry assertion pins).
    const bare = makeApp({ relay: false, repositories: false })
    expect((await publish(bare, undefined, EVENT)).status).toBe(403)
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
    expect((await publish(makeApp(), session, EVENT)).status).toBe(403)
  })

  it('rejects an EXPIRED machine token (403)', async () => {
    const expired = await machineToken([ACCOUNT], { ttlMs: -60_000 })
    expect((await publish(makeApp(), expired, EVENT)).status).toBe(403)
  })

  it('rejects a machine token signed under a DIFFERENT secret (403 — bad MAC)', async () => {
    const forged = (
      await mintMachineToken('another-secret-9876543210', { userId: 'usr_1', accountIds: [ACCOUNT] })
    ).token
    expect((await publish(makeApp(), forged, EVENT)).status).toBe(403)
  })

  it('503s on a facade that is not a mothership (no relay or no repositories to scope)', async () => {
    const token = await machineToken()
    expect((await publish(makeApp({ relay: false }), token, EVENT)).status).toBe(503)
    expect((await publish(makeApp({ repositories: false }), token, EVENT)).status).toBe(503)
  })

  it('422s a missing workspaceId or payload', async () => {
    const token = await machineToken()
    expect((await publish(makeApp(), token, { payload: 'x' })).status).toBe(422)
    expect((await publish(makeApp(), token, { workspaceId: 'ws_1' })).status).toBe(422)
    expect((await publish(makeApp(), token, { workspaceId: 1, payload: 'x' })).status).toBe(422)
  })
})

describe('HttpMachineEventClient (client side)', () => {
  it('posts a relayed event that the mothership delivers to its relay', async () => {
    const ingested: RelayedRealtimeEvent[] = []
    const app = makeApp({ ingested })
    const token = await machineToken()
    const fetchImpl: typeof fetch = async (input, init) =>
      app.fetch(new Request(input as RequestInfo, init))
    const client = new HttpMachineEventClient({
      baseUrl: 'http://mothership.test',
      token: () => token,
      fetchImpl,
    })
    client.publish({ workspaceId: 'ws_1', payload: EVENT.payload, originConnectionId: 'cid_9' })
    // publish is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(ingested).toEqual([
      { workspaceId: 'ws_1', payload: EVENT.payload, originConnectionId: 'cid_9' },
    ])
  })

  it('skips the round-trip entirely when no token is available yet (no fetch)', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      calls++
      return new Response('{}')
    }
    const client = new HttpMachineEventClient({
      baseUrl: 'http://mothership.test',
      token: () => null,
      fetchImpl,
    })
    client.publish({ workspaceId: 'ws_1', payload: EVENT.payload })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
  })

  it('swallows a transport failure (never throws)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down')
    }
    const client = new HttpMachineEventClient({
      baseUrl: 'http://mothership.test',
      token: () => 'tok',
      fetchImpl,
    })
    expect(() => client.publish({ workspaceId: 'ws_1', payload: EVENT.payload })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
