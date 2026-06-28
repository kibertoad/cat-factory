import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AuthConfig } from '@cat-factory/server'
import { mintWsTicket } from '@cat-factory/server'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { NodeEventPublisher, NodeRealtimeHub, attachRealtime } from '../src/realtime.js'

// The Node real-time transport: the SAME raw WebSocket + ticket protocol the Worker
// serves, so the browser SPA's stream handling is runtime-agnostic. These tests stand
// up a plain HTTP server + the `ws`-backed transport (no DB) and exercise the three
// behaviours that matter: ticket authorisation, per-workspace fan-out, and isolation.

const silentLog = { info: () => {}, warn: () => {} }

/** A minimal AuthConfig — `authorizeWsUpgrade` only reads enabled/devOpen/sessionSecret. */
function authConfig(over: Partial<AuthConfig>): AuthConfig {
  return {
    enabled: false,
    devOpen: true,
    sessionSecret: 'test-secret-please',
    ...over,
  } as AuthConfig
}

/** A throwaway instance object — the publisher only serialises it onto the wire. */
const fakeInstance = { id: 'ex_1', blockId: 'blk_1', steps: [] } as never

interface Harness {
  port: number
  hub: NodeRealtimeHub
  publisher: NodeEventPublisher
  stop: () => void
  server: Server
}

const harnesses: Harness[] = []

async function startHarness(auth: AuthConfig): Promise<Harness> {
  const hub = new NodeRealtimeHub()
  const publisher = new NodeEventPublisher(hub)
  const server = createServer()
  const stop = attachRealtime(server, hub, auth, silentLog)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const h = { port, hub, publisher, stop, server }
  harnesses.push(h)
  return h
}

function open(port: number, path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`)
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.stop()
    await new Promise<void>((resolve) => h.server.close(() => resolve()))
  }
})

describe('Node real-time WebSocket transport', () => {
  it('delivers a published execution event to a subscribed browser', async () => {
    const { port, publisher } = await startHarness(authConfig({}))
    const client = open(port, '/workspaces/ws_a/events')
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    const received = new Promise<string>((resolve) =>
      client.once('message', (d) => resolve(String(d))),
    )
    // Poll-publish to defeat the subscribe-vs-handshake race: the server registers the
    // socket in the hub a beat after the client sees `open`, so publish until it lands.
    const pump = setInterval(() => void publisher.executionChanged('ws_a', fakeInstance, null), 15)
    const raw = await received
    clearInterval(pump)
    client.close()

    const event = JSON.parse(raw)
    expect(event.type).toBe('execution')
    expect(event.instance.id).toBe('ex_1')
  })

  it('does not deliver another workspace’s events (per-workspace isolation)', async () => {
    const { port, publisher } = await startHarness(authConfig({}))
    const client = open(port, '/workspaces/ws_a/events')
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    let got = false
    client.on('message', () => {
      got = true
    })
    // Publish only to a different workspace for a window; the ws_a socket must stay silent.
    const pump = setInterval(() => void publisher.boardChanged('ws_b', 'noise'), 15)
    await new Promise((r) => setTimeout(r, 120))
    clearInterval(pump)
    client.close()
    expect(got).toBe(false)
  })

  it('suppresses a board echo to the connection that caused it, but not to others', async () => {
    const { port, publisher } = await startHarness(authConfig({}))
    // Two browsers on the same workspace, distinguished by their `?cid=` (the SPA's
    // per-tab connection id). A board mutation attributed to `cid-origin` must reach the
    // OTHER tab but skip the one that made the move (it already has the REST result).
    const origin = open(port, '/workspaces/ws_a/events?cid=cid-origin')
    const other = open(port, '/workspaces/ws_a/events?cid=cid-other')
    await Promise.all([
      new Promise<void>((res, rej) => {
        origin.once('open', res)
        origin.once('error', rej)
      }),
      new Promise<void>((res, rej) => {
        other.once('open', res)
        other.once('error', rej)
      }),
    ])

    let originGot = 0
    origin.on('message', () => {
      originGot++
    })
    const otherReceived = new Promise<void>((resolve) => other.once('message', () => resolve()))

    const pump = setInterval(
      () => void publisher.boardChanged('ws_a', 'block-moved', 'blk_1', 'cid-origin'),
      15,
    )
    await otherReceived
    // Keep pumping briefly so a missed suppression on the origin socket would surface.
    await new Promise((r) => setTimeout(r, 80))
    clearInterval(pump)
    origin.close()
    other.close()

    expect(originGot).toBe(0)
  })

  it('rejects an upgrade with no ticket when auth is enabled', async () => {
    const { port } = await startHarness(authConfig({ enabled: true, devOpen: false }))
    const client = open(port, '/workspaces/ws_a/events')
    const outcome = await new Promise<string>((resolve) => {
      client.once('open', () => resolve('open'))
      client.once('unexpected-response', () => resolve('rejected'))
      client.once('error', () => resolve('rejected'))
    })
    client.close()
    expect(outcome).toBe('rejected')
  })

  it('accepts an upgrade with a valid ticket when auth is enabled', async () => {
    const auth = authConfig({ enabled: true, devOpen: false })
    const { port } = await startHarness(auth)
    const ticket = await mintWsTicket(auth, 'ws_a')
    const client = open(port, `/workspaces/ws_a/events?ticket=${encodeURIComponent(ticket)}`)
    const outcome = await new Promise<string>((resolve) => {
      client.once('open', () => resolve('open'))
      client.once('unexpected-response', () => resolve('rejected'))
      client.once('error', () => resolve('rejected'))
    })
    client.close()
    expect(outcome).toBe('open')
  })

  it('rejects a ticket minted for a different workspace', async () => {
    const auth = authConfig({ enabled: true, devOpen: false })
    const { port } = await startHarness(auth)
    const ticket = await mintWsTicket(auth, 'ws_other')
    const client = open(port, `/workspaces/ws_a/events?ticket=${encodeURIComponent(ticket)}`)
    const outcome = await new Promise<string>((resolve) => {
      client.once('open', () => resolve('open'))
      client.once('unexpected-response', () => resolve('rejected'))
      client.once('error', () => resolve('rejected'))
    })
    client.close()
    expect(outcome).toBe('rejected')
  })
})
