import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

/**
 * The real-time event path: the per-workspace WorkspaceEventsHub Durable Object
 * fans published events out to connected sockets, and the `/events` route
 * upgrades a browser's WebSocket and forwards it to the hub.
 */
describe('WorkspaceEventsHub', () => {
  function hub(name: string) {
    const ns = env.WORKSPACE_EVENTS!
    return ns.get(ns.idFromName(name))
  }

  it('broadcasts a published event to a connected socket', async () => {
    const stub = hub('ws_events_broadcast')

    const upgrade = await stub.fetch('http://hub/connect', { headers: { Upgrade: 'websocket' } })
    expect(upgrade.status).toBe(101)
    const client = upgrade.webSocket!
    client.accept()

    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event received')), 5000)
      client.addEventListener('message', (e) => {
        clearTimeout(timer)
        resolve(typeof e.data === 'string' ? e.data : '')
      })
    })

    const event = { type: 'board', reason: 'test', at: 1 }
    const published = await stub.fetch('http://hub/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    expect(published.status).toBe(204)

    expect(JSON.parse(await received)).toEqual(event)
  })

  it('rejects a request that is neither an upgrade nor a publish', async () => {
    const res = await hub('ws_events_bad').fetch('http://hub/nope')
    expect(res.status).toBe(400)
  })
})

describe('events stream route', () => {
  // The Upgrade-header check runs before any workspace/DO lookup, so a plain GET
  // is rejected regardless of the id. Auth here is dev-open in tests (mirrors the
  // shared requireAuth path), so a real upgrade would forward to the hub.
  it('rejects a non-websocket request with 426', async () => {
    const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
    const res = await app.fetch(
      new Request('https://cat-factory.test/workspaces/ws_any/events'),
      env,
    )
    expect(res.status).toBe(426)
  })
})
