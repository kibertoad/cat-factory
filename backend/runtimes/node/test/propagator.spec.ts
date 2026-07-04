import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LayeredEventPropagator,
  NodeEventPublisher,
  NodeRealtimeHub,
  type RealtimeMessage,
  RedisWebSocketPropagator,
  type WebSocketPropagator,
  buildRealtimePropagator,
} from '../src/index.js'
import type { RedisClient } from '../src/redisPropagator.js'

// The cross-node real-time propagator. These tests exercise the LAYERED fan-out (local hub +
// adapters, no re-publish loop) with a recording fake adapter, and the Redis adapter's wire
// envelope + own-echo suppression against an in-memory bus — no Redis server needed.

const silentLog = { info: () => {}, warn: () => {} }

/** A fake cross-node adapter that records what it published and can inject a peer event. */
class RecordingPropagator implements WebSocketPropagator {
  readonly name = 'recording'
  readonly published: RealtimeMessage[] = []
  started = false
  stopped = false
  private deliver?: (message: RealtimeMessage) => void

  publish(message: RealtimeMessage): void {
    this.published.push(message)
  }
  async start(deliver: (message: RealtimeMessage) => void): Promise<void> {
    this.started = true
    this.deliver = deliver
  }
  async stop(): Promise<void> {
    this.stopped = true
  }
  /** Simulate an event arriving from a peer node. */
  injectPeer(message: RealtimeMessage): void {
    this.deliver?.(message)
  }
}

describe('LayeredEventPropagator', () => {
  it('fans a published event to the local hub AND to every adapter', () => {
    const hub = new NodeRealtimeHub()
    const adapterA = new RecordingPropagator()
    const adapterB = new RecordingPropagator()
    const propagator = new LayeredEventPropagator(hub, [adapterA, adapterB])

    const seen: string[] = []
    // Register a fake socket by reaching into the hub's public broadcast contract: subscribe a
    // stub WebSocket-shaped object.
    const socket = makeFakeSocket((data) => seen.push(data))
    hub.subscribe('ws_a', socket)

    propagator.broadcast('ws_a', '{"type":"board"}', 'cid-1')

    expect(seen).toEqual(['{"type":"board"}'])
    for (const adapter of [adapterA, adapterB]) {
      expect(adapter.published).toEqual([
        { workspaceId: 'ws_a', payload: '{"type":"board"}', originConnectionId: 'cid-1' },
      ])
    }
  })

  it('applies a peer event to the local hub WITHOUT re-publishing it (no loop)', async () => {
    const hub = new NodeRealtimeHub()
    const adapter = new RecordingPropagator()
    const propagator = new LayeredEventPropagator(hub, [adapter])
    await propagator.start(silentLog)

    const seen: string[] = []
    hub.subscribe(
      'ws_a',
      makeFakeSocket((data) => seen.push(data)),
    )

    adapter.injectPeer({ workspaceId: 'ws_a', payload: '{"type":"execution"}' })

    // Delivered locally...
    expect(seen).toEqual(['{"type":"execution"}'])
    // ...but NOT bounced back onto the bus (that would loop / double-deliver forever).
    expect(adapter.published).toEqual([])
  })

  it('start/stop drive every adapter and report whether remotes are wired', async () => {
    const hub = new NodeRealtimeHub()
    const adapter = new RecordingPropagator()
    const withRemote = new LayeredEventPropagator(hub, [adapter])
    const bare = new LayeredEventPropagator(hub, [])

    expect(withRemote.hasRemote).toBe(true)
    expect(bare.hasRemote).toBe(false)

    await withRemote.start(silentLog)
    await withRemote.stop()
    expect(adapter.started).toBe(true)
    expect(adapter.stopped).toBe(true)
  })

  it('a NodeEventPublisher over the layer pushes serialised events through it', () => {
    const hub = new NodeRealtimeHub()
    const adapter = new RecordingPropagator()
    const publisher = new NodeEventPublisher(new LayeredEventPropagator(hub, [adapter]))

    void publisher.boardChanged('ws_a', 'block-moved', 'blk_1', 'cid-1')

    expect(adapter.published).toHaveLength(1)
    const event = JSON.parse(adapter.published[0]!.payload)
    expect(event).toMatchObject({ type: 'board', reason: 'block-moved' })
    expect(adapter.published[0]!.originConnectionId).toBe('cid-1')
  })
})

describe('buildRealtimePropagator', () => {
  it('wires no adapter when REDIS_URL is unset (local / single-node default)', () => {
    const propagator = buildRealtimePropagator(new NodeRealtimeHub(), {}, silentLog)
    expect(propagator.hasRemote).toBe(false)
  })

  it('wires the Redis adapter when REDIS_URL is set', () => {
    const propagator = buildRealtimePropagator(
      new NodeRealtimeHub(),
      { REDIS_URL: 'redis://localhost:6379' },
      silentLog,
    )
    expect(propagator.hasRemote).toBe(true)
  })
})

// ---- Redis adapter against an in-memory bus -------------------------------------------------

/** A shared in-memory pub/sub bus standing in for a Redis server across "nodes". */
class FakeBus extends EventEmitter {
  publishToBus(channel: string, message: string): void {
    this.emit(channel, message)
  }
}

/** A fake ioredis-shaped client bound to a {@link FakeBus}. */
function fakeRedisClient(bus: FakeBus): RedisClient {
  let listener: ((channel: string, message: string) => void) | undefined
  let subscribed: string | undefined
  const onBus = (channel: string) => (message: string) => listener?.(channel, message)
  const handlers = new Map<string, (message: string) => void>()
  return {
    async publish(channel, message) {
      bus.publishToBus(channel, message)
      return 1
    },
    async subscribe(channel) {
      subscribed = channel
      const h = onBus(channel)
      handlers.set(channel, h)
      bus.on(channel, h)
      return 1
    },
    on(event, cb) {
      if (event === 'message') listener = cb as (channel: string, message: string) => void
    },
    async quit() {
      if (subscribed) bus.off(subscribed, handlers.get(subscribed)!)
      return 'OK'
    },
    disconnect() {
      if (subscribed) bus.off(subscribed, handlers.get(subscribed)!)
    },
  }
}

describe('RedisWebSocketPropagator', () => {
  const nodes: RedisWebSocketPropagator[] = []
  afterEach(async () => {
    for (const n of nodes.splice(0)) await n.stop()
  })

  function makeNode(bus: FakeBus, nodeId: string): RedisWebSocketPropagator {
    const node = new RedisWebSocketPropagator({
      url: 'redis://fake',
      nodeId,
      log: silentLog,
      connect: async () => fakeRedisClient(bus),
    })
    nodes.push(node)
    return node
  }

  it('delivers an event published on one node to a peer node, but not back to itself', async () => {
    const bus = new FakeBus()
    const nodeA = makeNode(bus, 'node-a')
    const nodeB = makeNode(bus, 'node-b')

    const onA: RealtimeMessage[] = []
    const onB: RealtimeMessage[] = []
    await nodeA.start((m) => onA.push(m))
    await nodeB.start((m) => onB.push(m))

    nodeA.publish({ workspaceId: 'ws_a', payload: '{"type":"board"}', originConnectionId: 'cid-1' })
    // Let the fire-and-forget publish flush.
    await new Promise((r) => setTimeout(r, 5))

    // Peer node B receives it with the fields preserved...
    expect(onB).toEqual([
      { workspaceId: 'ws_a', payload: '{"type":"board"}', originConnectionId: 'cid-1' },
    ])
    // ...while the origin node A drops its OWN echo (the local hub already delivered it).
    expect(onA).toEqual([])
  })

  it('ignores malformed and foreign frames on the channel', async () => {
    const bus = new FakeBus()
    const node = makeNode(bus, 'node-a')
    const received: RealtimeMessage[] = []
    await node.start((m) => received.push(m))

    bus.publishToBus('cat-factory:realtime', 'not json')
    bus.publishToBus('cat-factory:realtime', JSON.stringify({ v: 2, hello: 'world' }))
    await new Promise((r) => setTimeout(r, 5))

    expect(received).toEqual([])
  })

  it('still propagates across replicas that share the same REALTIME_NODE_ID', async () => {
    // A per-process random suffix is appended to the configured id, so two replicas given the
    // SAME REALTIME_NODE_ID still get distinct effective ids — cross-node delivery keeps working
    // and each node still drops only its OWN echo (the shared-id footgun is neutralised).
    const bus = new FakeBus()
    const nodeA = makeNode(bus, 'shared')
    const nodeB = makeNode(bus, 'shared')

    const onA: RealtimeMessage[] = []
    const onB: RealtimeMessage[] = []
    await nodeA.start((m) => onA.push(m))
    await nodeB.start((m) => onB.push(m))

    nodeA.publish({ workspaceId: 'ws_a', payload: '{"type":"board"}' })
    await new Promise((r) => setTimeout(r, 5))

    expect(onB).toEqual([
      { workspaceId: 'ws_a', payload: '{"type":"board"}', originConnectionId: undefined },
    ])
    expect(onA).toEqual([])
  })

  it('does not reject or hang when the subscribe fails (bus down at boot)', async () => {
    // A down bus must never wedge boot: start() fires the subscribe without awaiting it, so a
    // rejection is logged, not thrown or hung on.
    const node = new RedisWebSocketPropagator({
      url: 'redis://fake',
      log: silentLog,
      connect: async () => ({
        publish: async () => 1,
        subscribe: async () => {
          throw new Error('bus down')
        },
        on: () => {},
        quit: async () => 'OK',
        disconnect: () => {},
      }),
    })
    nodes.push(node)
    await expect(node.start(() => {})).resolves.toBeUndefined()
  })

  it('closes an already-opened client when a later connect fails during start', async () => {
    // The publisher opens first; if the subscriber connect throws, start() must release the
    // publisher before rethrowing (else its reconnect timer leaks and keeps the process alive).
    let quitCalls = 0
    const node = new RedisWebSocketPropagator({
      url: 'redis://fake',
      log: silentLog,
      connect: async (_url, role) => {
        if (role === 'subscriber') throw new Error('connect failed')
        return {
          publish: async () => 1,
          subscribe: async () => 1,
          on: () => {},
          quit: async () => {
            quitCalls++
            return 'OK'
          },
          disconnect: () => {},
        }
      },
    })
    await expect(node.start(() => {})).rejects.toThrow('connect failed')
    expect(quitCalls).toBe(1)
  })
})

/** A minimal `ws`-shaped stub the hub can register + send to. */
function makeFakeSocket(onSend: (data: string) => void): never {
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => onSend(data),
    on: () => {},
  } as never
}
