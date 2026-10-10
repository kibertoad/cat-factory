import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskWritebackContext } from '@cat-factory/kernel'
import { jiraWriteback } from './jira.writeback.js'

// The Jira writeback transport, exercised through a stubbed global `fetch` (the same shape
// `JiraProvider`'s reads use). What matters here is what reaches the wire: the ADF comment
// payload, the category the transition lands in, and a request that a real `fetch` would accept.

const CREDENTIALS = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'a@b.c',
  apiToken: 'tok',
}
const CTX = createTaskWritebackContext({ workspaceId: 'ws_1', credentials: CREDENTIALS })

interface Call {
  url: string
  method: string
  body: string | undefined
}

/** Stub the global `fetch`, recording every call and answering the transition list. */
function stubFetch(over: { ok?: boolean; status?: number } = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
    // Mirror the real `fetch`: a GET/HEAD with ANY non-null body throws. That is what makes an
    // empty-string body a production failure but a no-op against a permissive fake.
    if ((init.method === 'GET' || init.method === 'HEAD') && init.body != null) {
      throw new TypeError('Request with GET/HEAD method cannot have body.')
    }
    calls.push({ url, method: init.method, body: init.body })
    if (url.endsWith('/transitions') && init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          transitions: [
            { id: '11', to: { statusCategory: { key: 'indeterminate' } } },
            { id: '31', to: { statusCategory: { key: 'done' } } },
          ],
        }),
      }
    }
    return {
      ok: over.ok ?? true,
      status: over.status ?? 204,
      text: async () => 'nope',
      json: async () => null,
    }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('jiraWriteback', () => {
  it('posts the comment as ADF against the connection site', async () => {
    const calls = stubFetch()
    await jiraWriteback.comment(CTX, 'PROJ-1', 'A pull request was opened')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment')
    // ADF, not the raw Markdown string: a v3 comment body is a document.
    expect(calls[0]!.body).toContain('"type":"doc"')
    expect(calls[0]!.body).toContain('A pull request was opened')
  })

  it('resolves through the DONE-category transition, listing them with no body', async () => {
    const calls = stubFetch()
    await jiraWriteback.resolve!(CTX, 'PROJ-1')
    const list = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'GET')
    const fire = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')
    expect(list!.body).toBeUndefined()
    expect(fire!.body).toContain('"id":"31"')
  })

  it('claims through the IN PROGRESS (indeterminate) transition, not the resolve one', async () => {
    const calls = stubFetch()
    await jiraWriteback.markInProgress!(CTX, 'PROJ-1', {})
    const fire = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')
    expect(fire!.body).toContain('"id":"11"')
  })

  it('REFUSES a workspace with no stored Jira credentials', async () => {
    // The writeback this replaced returned quietly here, so the parked-review echo recorded its
    // marker for a comment Jira never saw and the questions were swallowed silently.
    const calls = stubFetch()
    await expect(
      jiraWriteback.comment(
        createTaskWritebackContext({ workspaceId: 'ws_1', credentials: {} }),
        'PROJ-1',
        'hi',
      ),
    ).rejects.toThrow(/no Jira connection/i)
    expect(calls).toEqual([])
  })

  it('throws on a non-OK response so the caller never records it as delivered', async () => {
    stubFetch({ ok: false, status: 403 })
    await expect(jiraWriteback.comment(CTX, 'PROJ-1', 'hi')).rejects.toThrow(/403/)
  })

  it('re-validates the stored base URL before authenticating against it', async () => {
    // Defence in depth: a base that became unsafe since connect time must not be reached now,
    // with the workspace's credentials attached.
    const calls = stubFetch()
    await expect(
      jiraWriteback.comment(
        createTaskWritebackContext({
          workspaceId: 'ws_1',
          credentials: { ...CREDENTIALS, baseUrl: 'http://127.0.0.1' },
        }),
        'PROJ-1',
        'hi',
      ),
    ).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
