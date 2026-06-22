import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { LlmCallActivity } from '@cat-factory/contracts'
import { createApp } from '../../src/app'
import { DurableObjectEventPublisher } from '../../src/infrastructure/events/DurableObjectEventPublisher'
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

  // Covers the FACADE-SPECIFIC half of the live-activity path: the proxy-emit specs
  // (`llm-proxy.spec.ts`) inject a recording publisher to assert the shared controller's
  // event shape, but the real `DurableObjectEventPublisher.llmCallObserved` → hub publish
  // → socket broadcast is what actually ships an `llmCall` event to a browser on Cloudflare.
  it('fans an llmCallObserved activity out to a connected socket as an llmCall event', async () => {
    const workspaceId = 'ws_events_llmcall'
    const stub = hub(workspaceId)

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

    const activity = {
      id: 'llm_test',
      workspaceId,
      executionId: 'ex_1',
      agentKind: 'coder',
      provider: 'qwen',
      model: 'qwen3-max',
      createdAt: 1,
      streaming: false,
      messageCount: 2,
      toolCount: 1,
      requestMaxTokens: null,
      promptTokens: 10,
      cachedPromptTokens: 0,
      completionTokens: 5,
      totalTokens: 15,
      finishReason: 'stop',
      upstreamMs: 7,
      overheadMs: 3,
      totalMs: 10,
      ok: true,
      httpStatus: 200,
      errorMessage: null,
    } satisfies LlmCallActivity

    const publisher = new DurableObjectEventPublisher(env.WORKSPACE_EVENTS!)
    await publisher.llmCallObserved(workspaceId, activity)

    const event = JSON.parse(await received) as { type: string; call: LlmCallActivity; at: number }
    expect(event.type).toBe('llmCall')
    expect(event.call).toEqual(activity)
    expect(typeof event.at).toBe('number')
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
