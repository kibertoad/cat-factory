import { describe, expect, it } from 'vitest'
import { createGitHubIssueViaToken } from './github.create.logic.js'
import type { FetchLike } from './TicketTrackerService.js'

describe('createGitHubIssueViaToken', () => {
  it('POSTs to the repo issues endpoint with bearer auth and returns number + url', async () => {
    let captured: { url: string; init: { headers: Record<string, string>; body: string } } | null =
      null
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, init }
      return {
        ok: true,
        status: 201,
        text: async () => '',
        json: async () => ({ number: 12, html_url: 'https://github.com/a/b/issues/12' }),
      }
    }

    const result = await createGitHubIssueViaToken({
      fetchImpl,
      token: 'ghp_x',
      owner: 'a',
      repo: 'b',
      title: 'T',
      body: 'B',
    })

    expect(result).toEqual({ number: 12, url: 'https://github.com/a/b/issues/12' })
    expect(captured!.url).toBe('https://api.github.com/repos/a/b/issues')
    expect(captured!.init.headers.authorization).toBe('Bearer ghp_x')
    expect(JSON.parse(captured!.init.body)).toEqual({ title: 'T', body: 'B' })
  })

  it('honours a custom apiBase (GitHub Enterprise)', async () => {
    let url = ''
    const fetchImpl: FetchLike = async (u) => {
      url = u
      return { ok: true, status: 201, text: async () => '', json: async () => ({ number: 1 }) }
    }
    await createGitHubIssueViaToken({
      fetchImpl,
      token: 't',
      owner: 'a',
      repo: 'b',
      title: 'T',
      body: 'B',
      apiBase: 'https://ghe.example.com/api/v3/',
    })
    expect(url).toBe('https://ghe.example.com/api/v3/repos/a/b/issues')
  })

  it('throws a clear error on a non-ok response', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 422,
      text: async () => 'validation failed',
      json: async () => null,
    })
    await expect(
      createGitHubIssueViaToken({ fetchImpl, token: 't', owner: 'a', repo: 'b', title: 'T', body: 'B' }),
    ).rejects.toThrow(/422/)
  })
})
