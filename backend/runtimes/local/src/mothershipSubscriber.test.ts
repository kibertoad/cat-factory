import type {
  LocalEventSink,
  RealtimeRoomListener,
  RealtimeRoomWatcher,
} from '@cat-factory/node-server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MothershipEventSubscriber,
  type UpstreamConnect,
  type UpstreamSocket,
} from './mothershipSubscriber.js'

// The INBOUND half of mothership real-time (docs/initiatives/mothership-mode.md, PR 2). What
// matters here is the demand-driven lifecycle — one upstream socket per workspace someone is
// actually watching locally, opened/released off the local hub's room transitions — plus the three
// properties the whole design rests on: a relayed frame reaches the LOCAL sink verbatim, a dropped
// subscription heals itself rather than silently going dead for the rest of the session, and a
// subscription that is broken or merely SILENT says so instead of looking healthy forever.

class FakeSocket implements UpstreamSocket {
  readonly listeners = new Map<string, Array<(data?: unknown) => void>>()
  readonly sent: string[] = []
  closed = false

  on(event: string, listener: (data?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }
}

/** A hub stand-in: records broadcasts and lets a test drive room open/close transitions. */
function makeRooms() {
  const broadcasts: Array<{ workspaceId: string; payload: string; origin?: string | null }> = []
  let listener: RealtimeRoomListener | null = null
  const sink: LocalEventSink = {
    broadcast: (workspaceId, payload, origin) =>
      void broadcasts.push({ workspaceId, payload, origin }),
  }
  const rooms: RealtimeRoomWatcher = {
    watchRooms: (candidate) => {
      listener = candidate
      return () => {
        listener = null
      }
    },
  }
  return {
    sink,
    rooms,
    broadcasts,
    open: (workspaceId: string) => listener?.roomOpened(workspaceId),
    close: (workspaceId: string) => listener?.roomClosed(workspaceId),
  }
}

function makeSubscriber(opts: { token?: string | null } = {}) {
  const opened: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }> = []
  const connect: UpstreamConnect = (url, headers) => {
    const socket = new FakeSocket()
    opened.push({ url, headers, socket })
    return socket
  }
  const warnings: Array<Record<string, unknown>> = []
  let token: string | null = opts.token === undefined ? 'machine-token' : opts.token
  const subscriber = new MothershipEventSubscriber({
    baseUrl: 'https://mothership.example.com/',
    token: () => token,
    connectionId: 'mothership-node-abc',
    log: {
      info: () => {},
      warn: (fields: unknown) => void warnings.push(fields as Record<string, unknown>),
    },
    connect,
    // Pin the backoff jitter to the top of its window, so the delays below are the plain
    // `base * 2 ** attempt` schedule and the assertions stay exact.
    random: () => 1,
  })
  return { subscriber, opened, warnings, setToken: (next: string | null) => (token = next) }
}

describe('MothershipEventSubscriber', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens one machine-authed upstream socket per watched workspace, carrying the node cid', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)

    hub.open('ws_1')
    expect(opened).toHaveLength(1)
    // ws(s) scheme, the shared subscribe path, and the node's STABLE cid — the id the outbound
    // publish stamps as `originConnectionId` so our own events aren't fanned back down here.
    expect(opened[0]!.url).toBe(
      'wss://mothership.example.com/internal/events/subscribe/ws_1?cid=mothership-node-abc',
    )
    expect(opened[0]!.headers).toEqual({ authorization: 'Bearer machine-token' })

    // A second local subscriber for the SAME workspace does not open a second upstream socket
    // (the hub only reports the first/last transition, and re-entry is guarded anyway).
    hub.open('ws_1')
    expect(opened).toHaveLength(1)

    hub.open('ws_2')
    expect(opened).toHaveLength(2)
    expect(subscriber.subscribedWorkspaces).toEqual(['ws_1', 'ws_2'])
  })

  it('re-broadcasts a relayed frame into the local sink verbatim, with no origin suppression', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')

    const frame = '{"type":"board","reason":"teammate","at":1}'
    opened[0]!.socket.emit('message', frame)

    // Verbatim (never re-parsed), and with NO originConnectionId: the event came from elsewhere,
    // so every local socket must see it.
    expect(hub.broadcasts).toEqual([{ workspaceId: 'ws_1', payload: frame, origin: undefined }])

    // Keepalive text frames are not events.
    opened[0]!.socket.emit('message', 'pong')
    expect(hub.broadcasts).toHaveLength(1)
  })

  it('releases the upstream socket when the last local subscriber leaves', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')
    hub.close('ws_1')

    expect(opened[0]!.socket.closed).toBe(true)
    expect(subscriber.subscribedWorkspaces).toEqual([])
    // A released subscription must NOT resurrect itself through the reconnect path.
    vi.advanceTimersByTime(60_000)
    expect(opened).toHaveLength(1)
  })

  it('reconnects with backoff after a drop, and stops once released', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')

    // A mothership restart / laptop sleep drops the socket. Nothing reconnects it but us.
    opened[0]!.socket.emit('close')
    expect(opened).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(2)

    // Backoff grows, so a mothership that is down doesn't get hammered.
    opened[1]!.socket.emit('close')
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(2)
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(3)

    // A successful open resets it: the next drop retries at the base delay again.
    opened[2]!.socket.emit('open')
    opened[2]!.socket.emit('close')
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(4)

    subscriber.stop()
    opened[3]!.socket.emit('close')
    vi.advanceTimersByTime(60_000)
    expect(opened).toHaveLength(4)
  })

  it('does not open a guaranteed-403 handshake before the mothership login, and picks the token up after', () => {
    const hub = makeRooms()
    const { subscriber, opened, setToken } = makeSubscriber({ token: null })
    subscriber.bind(hub.sink, hub.rooms)

    hub.open('ws_1')
    expect(opened).toHaveLength(0)

    // The SPA completes `/local/mothership/connect` and the cached token appears — the pending
    // retry picks it up, so a node that booted before login becomes live without a restart.
    setToken('machine-token')
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(1)
  })

  it('survives a connect that throws and a sink that throws', () => {
    const hub = makeRooms()
    let fail = true
    const subscriber = new MothershipEventSubscriber({
      baseUrl: 'https://mothership.example.com',
      token: () => 'machine-token',
      connectionId: 'node',
      log: { info: () => {}, warn: () => {} },
      connect: () => {
        if (fail) throw new Error('dns exploded')
        return new FakeSocket()
      },
      random: () => 1,
    })
    subscriber.bind(
      {
        broadcast: () => {
          throw new Error('hub exploded')
        },
      },
      hub.rooms,
    )

    expect(() => hub.open('ws_1')).not.toThrow()
    fail = false
    // The failed connect still schedules a retry rather than leaving the workspace dark.
    vi.advanceTimersByTime(1_000)
    expect(subscriber.subscribedWorkspaces).toEqual(['ws_1'])
    subscriber.stop()
  })

  // A refused handshake reports ONLY through the socket's `error` event: `close` carries no reason
  // for an HTTP-level rejection. Swallowing it made a permanently broken subscription (revoked
  // token, board moved out of the token's accounts) look exactly like a healthy one — an unbounded
  // silent retry, which is the failure shape this whole leg exists to remove.
  it('reports a refused subscription, rate-limited so an endless retry is visible but not a flood', () => {
    const hub = makeRooms()
    const { subscriber, opened, warnings } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')

    opened[0]!.socket.emit('error', new Error('Unexpected server response: 403'))
    opened[0]!.socket.emit('close')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ workspaceId: 'ws_1', attempts: 1 })
    expect(String(warnings[0]!.err)).toContain('403')

    // The next four are still reported (the first failures are the ones a developer is watching
    // for), then it thins out to one line per five rather than one every 30s forever.
    for (let i = 1; i < 12; i++) {
      vi.advanceTimersByTime(60_000)
      const socket = opened[i]!.socket
      socket.emit('error', new Error('Unexpected server response: 403'))
      socket.emit('close')
    }
    expect(opened).toHaveLength(12)
    expect(warnings.map((w) => w.attempts)).toEqual([1, 2, 3, 4, 5, 10])

    // A successful open clears the counter, so a later outage reports from the top again.
    vi.advanceTimersByTime(60_000)
    opened[12]!.socket.emit('open')
    opened[12]!.socket.emit('error', new Error('later blip'))
    expect(warnings.at(-1)).toMatchObject({ attempts: 1 })
    subscriber.stop()
  })

  // Liveness. A Cloudflare mothership holds its sockets through the hibernation API and never
  // pings, so a half-open socket NEVER fires `close` — without a client-side deadline the
  // workspace goes dark forever while `subscribedWorkspaces` still reports it subscribed.
  it('probes an idle subscription, and reconnects one that has gone silent', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')
    const socket = opened[0]!.socket
    socket.emit('open')

    // The app-level "ping" is what a Cloudflare mothership auto-answers at the edge; a Node
    // mothership ignores it and proves liveness with its own protocol ping instead.
    vi.advanceTimersByTime(30_000)
    expect(socket.sent).toEqual(['ping'])

    // Any inbound frame counts as proof of life — including the answering "pong", which is a
    // keepalive and must NOT reach the sink as an event.
    socket.emit('message', 'pong')
    vi.advanceTimersByTime(60_000)
    expect(hub.broadcasts).toHaveLength(0)
    expect(socket.closed).toBe(false)

    // Now nothing answers. Past the deadline the socket is declared dead and dropped, and the
    // close handler's backoff opens a fresh one.
    vi.advanceTimersByTime(60_000)
    expect(socket.closed).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(opened).toHaveLength(2)
    // The dead socket's probe must not outlive it, or a released subscription keeps pinging.
    const before = socket.sent.length
    vi.advanceTimersByTime(120_000)
    expect(socket.sent).toHaveLength(before)
    subscriber.stop()
  })

  it('detaches without retiring the subscriber, and refuses a second concurrent bind', () => {
    const hub = makeRooms()
    const { subscriber, opened } = makeSubscriber()
    const detach = subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')

    // Binding twice would silently orphan the first room watcher; fail fast instead.
    expect(() => subscriber.bind(hub.sink, hub.rooms)).toThrow(/already bound/)

    detach()
    expect(opened[0]!.socket.closed).toBe(true)
    expect(subscriber.subscribedWorkspaces).toEqual([])

    // Unlike `stop()`, a detach leaves the subscriber usable — a re-bind reconnects.
    subscriber.bind(hub.sink, hub.rooms)
    hub.open('ws_1')
    expect(opened).toHaveLength(2)
    subscriber.stop()
  })
})
