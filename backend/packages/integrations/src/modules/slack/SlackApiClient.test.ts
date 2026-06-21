import { describe, expect, it } from 'vitest'
import { SlackApiClient } from './SlackApiClient.js'

// Build a fetch stub that returns a JSON Slack response, optionally with headers,
// and records every request URL + body so pagination/cursor flow can be asserted.
function stubFetch(
  responses: { body: Record<string, unknown>; headers?: Record<string, string> }[],
) {
  const calls: { url: string; body: unknown }[] = []
  let i = 0
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    const next = responses[Math.min(i, responses.length - 1)]!
    i++
    return {
      json: async () => next.body,
      headers: new Headers(next.headers ?? {}),
    } as Response
  }) as unknown as typeof fetch
  return { client: new SlackApiClient({ fetchImpl }), calls }
}

describe('SlackApiClient', () => {
  it('authTest reads granted scopes from the x-oauth-scopes header', async () => {
    const { client } = stubFetch([
      {
        body: {
          ok: true,
          team_id: 'T1',
          team: 'Acme',
          user_id: 'B1',
          url: 'https://acme.slack.com',
        },
        headers: { 'x-oauth-scopes': 'chat:write, chat:write.public ,channels:read' },
      },
    ])
    const info = await client.authTest('tok')
    expect(info.teamId).toBe('T1')
    // Trimmed + empties dropped, in order.
    expect(info.scopes).toEqual(['chat:write', 'chat:write.public', 'channels:read'])
  })

  it('authTest returns empty scopes when the header is absent', async () => {
    const { client } = stubFetch([{ body: { ok: true, team_id: 'T1', team: 'Acme' } }])
    expect((await client.authTest('tok')).scopes).toEqual([])
  })

  it('conversationsList follows the next_cursor across pages', async () => {
    const { client, calls } = stubFetch([
      {
        body: {
          ok: true,
          channels: [{ id: 'C1', name: 'general', is_private: false }],
          response_metadata: { next_cursor: 'CURSOR2' },
        },
      },
      {
        body: {
          ok: true,
          channels: [{ id: 'C2', name: 'private', is_private: true }],
          response_metadata: { next_cursor: '' }, // empty cursor → stop
        },
      },
    ])
    const channels = await client.conversationsList('tok')
    expect(channels.map((c) => c.id)).toEqual(['C1', 'C2'])
    expect(channels[1]!.isPrivate).toBe(true)
    // Two requests: the second carried the cursor from the first page.
    expect(calls).toHaveLength(2)
    expect((calls[1]!.body as { cursor?: string }).cursor).toBe('CURSOR2')
  })

  it('conversationsList stops after a single page when there is no cursor', async () => {
    const { client, calls } = stubFetch([
      { body: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }] } },
    ])
    const channels = await client.conversationsList('tok')
    expect(channels).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})
