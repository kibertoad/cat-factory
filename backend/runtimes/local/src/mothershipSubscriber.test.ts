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
// actually watching locally, opened/released off the local hub's room transitions — plus the two
// properties the whole design rests on: a relayed frame reaches the LOCAL sink verbatim, and a
// dropped subscription heals itself rather than silently going dead for the rest of the session.

class FakeSocket implements UpstreamSocket {
  readonly listeners = new Map<string, Array<(data?: unknown) => void>>()
  closed = false

  on(event: string, listener: (data?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data)
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
  let token: string | null = opts.token === undefined ? 'machine-token' : opts.token
  const subscriber = new MothershipEventSubscriber({
    baseUrl: 'https://mothership.example.com/',
    token: () => token,
    connectionId: 'mothership-node-abc',
    log: { info: () => {}, warn: () => {} },
    connect,
  })
  return { subscriber, opened, setToken: (next: string | null) => (token = next) }
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
})
