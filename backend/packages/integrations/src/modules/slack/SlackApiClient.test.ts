import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { SlackApiClient } from './SlackApiClient.js'

// The client speaks the real Slack Web API over the global `fetch`, so we intercept that real
// fetch with undici's MockAgent rather than a hand-stubbed `{ json, headers }` object — the
// previous fake omitted `ok`/`status`/`text`, so it could silently diverge from a real
// Response. MockAgent serves a real Response (real headers, real json()); `disableNetConnect`
// makes any un-mocked request fail loudly.
const SLACK = 'https://slack.com'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  // Node's built-in `fetch` binds to its OWN bundled undici (v7 on Node 24), which ignores a
  // dispatcher set on the userland `undici` package (v8) — so the MockAgent above would be
  // silently bypassed and the client would hit the REAL Slack API. Route the SUT's `fetch`
  // through the userland undici's fetch, which honours the dispatcher we set.
  vi.stubGlobal('fetch', undiciFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

/**
 * Queue one reply per page for POSTs to a Slack method (consumed FIFO), capturing each
 * request's JSON body so cursor/pagination flow can be asserted. Returns the captured bodies.
 */
function slackReplies(
  method: string,
  pages: { body: Record<string, unknown>; headers?: Record<string, string> }[],
): unknown[] {
  const bodies: unknown[] = []
  const pool = agent.get(SLACK)
  for (const page of pages) {
    pool.intercept({ path: `/api/${method}`, method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(opts.body ? JSON.parse(String(opts.body)) : null)
        return JSON.stringify(page.body)
      },
      { headers: page.headers },
    )
  }
  return bodies
}

describe('SlackApiClient', () => {
  it('authTest reads granted scopes from the x-oauth-scopes header', async () => {
    slackReplies('auth.test', [
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
    const info = await new SlackApiClient().authTest('tok')
    expect(info.teamId).toBe('T1')
    // Trimmed + empties dropped, in order.
    expect(info.scopes).toEqual(['chat:write', 'chat:write.public', 'channels:read'])
  })

  it('authTest returns empty scopes when the header is absent', async () => {
    slackReplies('auth.test', [{ body: { ok: true, team_id: 'T1', team: 'Acme' } }])
    expect((await new SlackApiClient().authTest('tok')).scopes).toEqual([])
  })

  it('conversationsList follows the next_cursor across pages', async () => {
    const bodies = slackReplies('conversations.list', [
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
    const channels = await new SlackApiClient().conversationsList('tok')
    expect(channels.map((c) => c.id)).toEqual(['C1', 'C2'])
    expect(channels[1]!.isPrivate).toBe(true)
    // Two requests: the second carried the cursor from the first page.
    expect(bodies).toHaveLength(2)
    expect((bodies[1] as { cursor?: string }).cursor).toBe('CURSOR2')
  })

  it('conversationsList stops after a single page when there is no cursor', async () => {
    const bodies = slackReplies('conversations.list', [
      { body: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false }] } },
    ])
    const channels = await new SlackApiClient().conversationsList('tok')
    expect(channels).toHaveLength(1)
    expect(bodies).toHaveLength(1)
  })
})
