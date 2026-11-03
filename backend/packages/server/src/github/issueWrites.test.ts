import { describe, expect, it } from 'vitest'
import { replaceIssueBody } from './issueWrites.js'
import type { GitHubRequestFn } from './reviewPosting.js'

const REF = { owner: 'acme', repo: 'web' }

function fakeRequest(storedBody: string | null) {
  const calls: { path: string; method?: string; body?: unknown }[] = []
  const request: GitHubRequestFn = async (path, opts) => {
    calls.push({ path, method: opts.method, body: opts.body })
    return { json: opts.method ? null : { body: storedBody } }
  }
  return { request, calls }
}

describe('replaceIssueBody', () => {
  it('PATCHes the body when it differs from the stored one', async () => {
    const { request, calls } = fakeRequest('old')
    expect(await replaceIssueBody(request, 1, REF, 7, 'new')).toBe('updated')
    expect(calls).toEqual([
      { path: '/repos/acme/web/issues/7', method: undefined, body: undefined },
      { path: '/repos/acme/web/issues/7', method: 'PATCH', body: { body: 'new' } },
    ])
  })

  it('leaves a body that already holds the text alone, line endings aside', async () => {
    const { request, calls } = fakeRequest('same\r\n')
    expect(await replaceIssueBody(request, 1, REF, 7, 'same')).toBe('unchanged')
    expect(calls).toHaveLength(1)
  })
})
