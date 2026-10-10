import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { mintMachineToken } from '@cat-factory/server'
import type { AuthConfig } from '@cat-factory/server'
import { noopLogger } from '@cat-factory/kernel'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { NodeRealtimeHub, attachRealtime } from '../src/realtime.js'

// The Node facade's mothership-side real-time INBOUND leg: a Node deployment acting as a
// MOTHERSHIP accepts a machine-authed per-workspace subscription so a mothership-mode laptop can
// receive org activity. `@hono/node-server` can't upgrade from a Hono `Response`, so the handshake
// is authorised in the HTTP-server `upgrade` listener rather than by the shared controller — this
// pins that the two authorise identically (token pin → capability → account scope → uniform 404),
// and that an accepted node lands in the SAME hub room a browser does.
//
// Also covers the hub's room-observation seam, which mothership mode uses on the CLIENT side to
// decide which upstream subscriptions to hold.

const SECRET = 'test-session-secret-0123456789'
const AUTH = { enabled: true, sessionSecret: SECRET, devOpen: false } as unknown as AuthConfig

/** A fake HTTP server + socket pair so the upgrade listener can be driven directly. */
function harness(
  opts: {
    accountOf?: (id: string) => Promise<string | null>
    isRevoked?: (nodeId: string) => Promise<boolean>
  } = {},
) {
  const hub = new NodeRealtimeHub()
  let listener: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined
  const server = {
    on: (_event: 'upgrade', fn: typeof listener) => {
      listener = fn
    },
  }
  const stop = attachRealtime(
    server as never,
    hub,
    AUTH,
    noopLogger,
    opts.accountOf
      ? {
          accountOf: opts.accountOf,
          ...(opts.isRevoked ? { isRevoked: opts.isRevoked } : {}),
        }
      : undefined,
  )
  const upgrade = async (path: string, token?: string) => {
    // The verdict resolves asynchronously inside the listener (an HMAC verify, then the account
    // lookup) and there is no promise to await from out here. A refusal ALWAYS ends with
    // `socket.destroy()`, so wait on that rather than polling for the status line — polling is
    // what makes a test like this pass alone and fail under parallel load.
    const written: string[] = []
    let refused: () => void = () => {}
    const rejected = new Promise<void>((resolve) => {
      refused = resolve
    })
    const socket = {
      write: (chunk: string) => void written.push(chunk),
      destroy: () => refused(),
      on: () => {},
      removeListener: () => {},
      end: () => {},
    } as unknown as Duplex
    const request = {
      url: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    } as unknown as IncomingMessage
    listener?.(request, socket, Buffer.alloc(0))
    await rejected
    return { written, socket }
  }
  return { hub, upgrade, stop }
}

const accountOf = async (id: string) =>
  id === 'ws_1' ? 'acc_1' : id === 'ws_other' ? 'acc_2' : null

async function token(accountIds = ['acc_1'], opts: { ttlMs?: number } = {}) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds, ...opts })).token
}

describe('machine event subscription (Node upgrade listener)', () => {
  it('rejects a missing / non-machine / out-of-scope subscription without leaking existence', async () => {
    const { upgrade, stop } = harness({ accountOf })

    const noToken = await upgrade('/internal/events/subscribe/ws_1')
    expect(noToken.written[0]).toContain('403')

    // An in-scope token for the WRONG account's board is a 404, not a 403 — indistinguishable
    // from a board that doesn't exist.
    const outOfScope = await upgrade('/internal/events/subscribe/ws_other', await token())
    expect(outOfScope.written[0]).toContain('404')

    const unknown = await upgrade('/internal/events/subscribe/ws_nope', await token())
    expect(unknown.written[0]).toContain('404')

    const expired = await upgrade(
      '/internal/events/subscribe/ws_1',
      await token(['acc_1'], { ttlMs: -60_000 }),
    )
    expect(expired.written[0]).toContain('403')
    stop()
  })

  it('404s the route entirely on a deployment that is not a mothership, and on a resolver failure', async () => {
    // No `machineSubscribe` deps ⇒ this Node deployment does not serve the route at all, and the
    // path falls through to the listener's generic refusal. That is the correct shape: a facade
    // that can't scope the request must not half-serve it. (The shared controller — which is how a
    // CLOUDFLARE mothership reaches the same handshake — answers 503 here instead, because it is
    // mounted unconditionally and must distinguish "no route" from "cannot scope you";
    // `packages/server/test/eventsRelay.spec.ts` pins that half.)
    const unwired = harness()
    const res = await unwired.upgrade('/internal/events/subscribe/ws_1', await token())
    expect(res.written[0]).toContain('404')
    unwired.stop()

    // Wired but unable to resolve the workspace ⇒ the same uniform 404 (fail closed).
    const broken = harness({
      accountOf: async () => {
        throw new Error('db down')
      },
    })
    const failed = await broken.upgrade('/internal/events/subscribe/ws_1', await token())
    expect(failed.written[0]).toContain('404')
    broken.stop()
  })

  it('refuses a REVOKED node with the same 403 as an invalid token (SEC-5)', async () => {
    // The tombstone has to bind on the ONE long-lived machine surface too, not just the
    // request-shaped `/internal/*` calls, or a leaked token keeps streaming a workspace's
    // events for the rest of its 30-day life.
    const { upgrade, stop } = harness({ accountOf, isRevoked: async () => true })
    const revoked = await upgrade('/internal/events/subscribe/ws_1', await token())
    expect(revoked.written[0]).toContain('403')
    stop()
  })

  it('fails CLOSED with a 503 when the roster read throws, instead of crashing the process', async () => {
    // An unreadable roster is not consent to serve a possibly-revoked node. It must also not
    // reject the handshake promise: this runs on an HTTP `upgrade`, where there is no error
    // handler above us, so an unhandled rejection would take the process down (Node's default)
    // and leave the socket open. 503 rather than 403 because the node should RETRY, not
    // reconnect for a fresh id.
    const { upgrade, stop } = harness({
      accountOf,
      isRevoked: async () => {
        throw new Error('roster down')
      },
    })
    const res = await upgrade('/internal/events/subscribe/ws_1', await token())
    expect(res.written[0]).toContain('503')
    stop()
  })

  it('accepts a live (non-revoked) node when the roster answers', async () => {
    const seen: string[] = []
    const { upgrade, stop } = harness({
      accountOf,
      isRevoked: async (nodeId) => {
        seen.push(nodeId)
        return false
      },
    })
    // A live node passes the tombstone check and is refused by nothing here (the accept half is
    // covered below over a real socket); assert the roster was consulted with the signed node id.
    await upgrade('/internal/events/subscribe/ws_other', await token())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^node_/)
    stop()
  })

  // The ACCEPT half, over a real listener and a real `ws` client. It cannot be driven through the
  // stub-socket harness above (that one resolves on `socket.destroy()`, which only a REFUSAL
  // reaches), and it is the half that carries the load-bearing detail: the accepted node has to
  // land in the same hub room a browser does, WITH its `?cid=` recorded, or the mothership fans a
  // node's own relayed events straight back at it and the laptop's browsers see them twice.
  it('accepts an in-scope handshake into the workspace room, honouring the node cid', async () => {
    const hub = new NodeRealtimeHub()
    const rooms: string[] = []
    hub.watchRooms({ roomOpened: (id) => rooms.push(id), roomClosed: () => {} })
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const stop = attachRealtime(server as never, hub, AUTH, noopLogger, {
      accountOf,
    })
    const port = (server.address() as AddressInfo).port

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/internal/events/subscribe/ws_1?cid=mothership-node-abc`,
      { headers: { authorization: `Bearer ${await token()}` } },
    )
    const frames: string[] = []
    client.on('message', (data) => void frames.push(String(data)))
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve)
      client.on('error', reject)
    })

    // Same room as a browser: the machine handshake fires the same first-subscriber transition.
    expect(rooms).toEqual(['ws_1'])

    // An event this node did NOT originate reaches it; one stamped with its own cid does not.
    // Ordering on a single socket makes the negative deterministic — the sentinel proves the
    // suppressed frame was skipped rather than merely slow.
    hub.broadcast('ws_1', '{"type":"board","reason":"teammate"}')
    hub.broadcast('ws_1', '{"type":"board","reason":"our-own-echo"}', 'mothership-node-abc')
    hub.broadcast('ws_1', '{"type":"board","reason":"sentinel"}')
    await expect.poll(() => frames.length).toBe(2)
    expect(frames).toEqual([
      '{"type":"board","reason":"teammate"}',
      '{"type":"board","reason":"sentinel"}',
    ])

    client.close()
    stop()
    await closeServer(server)
  })
})

/** Release the test listener, so a spec file can't leave a port bound behind it. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('NodeRealtimeHub room observation', () => {
  it('reports only the FIRST-subscriber / LAST-unsubscriber transitions', () => {
    const hub = new NodeRealtimeHub()
    const events: string[] = []
    hub.watchRooms({
      roomOpened: (id) => events.push(`open:${id}`),
      roomClosed: (id) => events.push(`close:${id}`),
    })

    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()]
    hub.subscribe('ws_1', sockets[0]! as never, 'cid_a')
    hub.subscribe('ws_1', sockets[1]! as never, 'cid_b')
    hub.subscribe('ws_2', sockets[2]! as never, null)
    expect(events).toEqual(['open:ws_1', 'open:ws_2'])

    sockets[0]!.fire('close')
    expect(events).toEqual(['open:ws_1', 'open:ws_2'])
    sockets[1]!.fire('close')
    expect(events).toEqual(['open:ws_1', 'open:ws_2', 'close:ws_1'])

    // Re-subscribing after the room emptied opens it again — this is what lets a mothership-mode
    // node drop its upstream stream while nobody is watching and re-open it on the next visit.
    hub.subscribe('ws_1', fakeSocket() as never, null)
    expect(events).toEqual(['open:ws_1', 'open:ws_2', 'close:ws_1', 'open:ws_1'])
  })

  it('never lets a throwing listener break the socket lifecycle', () => {
    const hub = new NodeRealtimeHub()
    hub.watchRooms({
      roomOpened: () => {
        throw new Error('subscriber exploded')
      },
      roomClosed: () => {
        throw new Error('subscriber exploded')
      },
    })
    const socket = fakeSocket()
    expect(() => hub.subscribe('ws_1', socket as never, null)).not.toThrow()
    expect(() => socket.fire('close')).not.toThrow()
    // The transport still works: a broadcast reaches the socket that is genuinely there.
    const other = fakeSocket()
    hub.subscribe('ws_2', other as never, null)
    hub.broadcast('ws_2', '{"type":"board"}')
    expect(other.sent).toEqual(['{"type":"board"}'])
  })

  it('detaches a listener when the returned function is called', () => {
    const hub = new NodeRealtimeHub()
    const events: string[] = []
    const detach = hub.watchRooms({
      roomOpened: (id) => events.push(id),
      roomClosed: () => {},
    })
    detach()
    hub.subscribe('ws_1', fakeSocket() as never, null)
    expect(events).toEqual([])
  })
})

/** A `ws`-shaped stub: OPEN, records sends, and can fire its close handler. */
function fakeSocket() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    readyState: 1,
    sent: [] as string[],
    on(event: string, fn: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    },
    send(payload: string) {
      this.sent.push(payload)
    },
    fire(event: string) {
      for (const fn of handlers.get(event) ?? []) fn()
    },
  }
}
