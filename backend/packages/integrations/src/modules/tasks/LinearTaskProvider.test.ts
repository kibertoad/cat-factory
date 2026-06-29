import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearTaskProvider } from './LinearTaskProvider.js'

// Provider-level tests for the two behaviours that live in the transport (not the pure
// logic): walking the children/comments pagination cursors, and surfacing an exact
// pasted ref first in search. The shared LinearGraphqlClient runs on the global
// `fetch`, so we stub it and route by the GraphQL operation name in the request body.

/** Build a GraphQL JSON Response the host-pinned client can read. */
function gql(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch stub that dispatches on the operation name embedded in the POST body. */
function stubFetch(routes: Record<string, () => unknown>) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string }
    for (const [op, make] of Object.entries(routes)) {
      if (body.query.includes(op)) return gql(make())
    }
    throw new Error(`unexpected Linear operation: ${body.query.slice(0, 40)}`)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const creds = { apiKey: 'lin_api_test' }

describe('LinearTaskProvider.fetchTask pagination', () => {
  it('walks the children + comments cursors and accumulates every page', async () => {
    let childrenCall = 0
    let commentsCall = 0
    vi.stubGlobal(
      'fetch',
      stubFetch({
        'query Issue(': () => ({
          issue: {
            identifier: 'ENG-1',
            title: 'Epic',
            children: {
              nodes: [{ identifier: 'ENG-2' }],
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
            },
            comments: {
              nodes: [{ user: { name: 'Ada' }, createdAt: '2026-01-01', body: 'first' }],
              pageInfo: { hasNextPage: true, endCursor: 'k1' },
            },
          },
        }),
        'query IssueChildren(': () => {
          childrenCall++
          return {
            issue: {
              children: {
                nodes: [{ identifier: 'ENG-3' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        },
        'query IssueComments(': () => {
          commentsCall++
          return {
            issue: {
              comments: {
                nodes: [{ user: { name: 'Bob' }, createdAt: '2026-01-02', body: 'second' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        },
      }),
    )

    const content = await new LinearTaskProvider().fetchTask(creds, 'ENG-1')

    expect(content.childExternalIds).toEqual(['ENG-2', 'ENG-3'])
    expect(content.comments.map((c) => c.body)).toEqual(['first', 'second'])
    expect(content.isEpic).toBe(true)
    expect(content.type).toBe('Epic')
    expect(childrenCall).toBe(1)
    expect(commentsCall).toBe(1)
  })

  it('does not page when the first page is the only page', async () => {
    const fetchMock = stubFetch({
      'query Issue(': () => ({
        issue: {
          identifier: 'ENG-5',
          title: 'Flat',
          children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const content = await new LinearTaskProvider().fetchTask(creds, 'ENG-5')

    expect(content.isEpic).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('LinearTaskProvider.search exact-ref match', () => {
  it('surfaces a pasted identifier first, de-duped against the term hits', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        'query Issue(': () => ({
          issue: { identifier: 'ENG-1', title: 'Exact', url: 'u1', state: { name: 'Todo' } },
        }),
        'query SearchIssues(': () => ({
          searchIssues: {
            nodes: [
              { identifier: 'ENG-1', title: 'Exact', url: 'u1', state: { name: 'Todo' } },
              { identifier: 'ENG-2', title: 'Other', url: 'u2', state: { name: 'Done' } },
            ],
          },
        }),
      }),
    )

    const results = await new LinearTaskProvider().search(creds, 'ENG-1')

    expect(results.map((r) => r.externalId)).toEqual(['ENG-1', 'ENG-2'])
  })

  it('falls through to the term search when the query is not an exact ref', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        'query SearchIssues(': () => ({
          searchIssues: { nodes: [{ identifier: 'ENG-7', title: 'Found', url: 'u7' }] },
        }),
      }),
    )

    const results = await new LinearTaskProvider().search(creds, 'login bug')

    expect(results.map((r) => r.externalId)).toEqual(['ENG-7'])
  })
})
