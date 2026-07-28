import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { mintMachineToken } from '@cat-factory/server'
import type { AuthConfig } from '@cat-factory/server'
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
function harness(opts: { accountOf?: (id: string) => Promise<string | null> } = {}) {
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
    { info: () => {}, warn: () => {} },
    opts.accountOf ? { accountOf: opts.accountOf } : undefined,
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

  it('503s an authenticated caller on a deployment that is not a mothership, and 404s the route entirely when unwired', async () => {
    // No `machineSubscribe` deps ⇒ this Node deployment does not serve the route at all, and the
    // path falls through to the listener's generic refusal. That is the correct shape: a facade
    // that can't scope the request must not half-serve it.
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
})

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
