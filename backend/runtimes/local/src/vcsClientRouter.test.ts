import { describe, expect, it } from 'vitest'
import type { GitHubClient } from '@cat-factory/kernel'
import { credentialRoutedGitHubClient } from './vcsClientRouter.js'

/** A stand-in client that records which one was called (only the members under test exist). */
function fakeClient(label: string): GitHubClient {
  return {
    getRepo: async () => ({ label }) as never,
    ...(label === 'github' ? { listReposForToken: async () => ({ items: [] }) as never } : {}),
  } as unknown as GitHubClient
}

describe('credentialRoutedGitHubClient', () => {
  it('forwards to whichever client is resolved AT CALL TIME', async () => {
    let current: GitHubClient | undefined = fakeClient('github')
    const client = credentialRoutedGitHubClient(() => current)
    await expect(client.getRepo(1, { owner: 'o', repo: 'r' })).resolves.toMatchObject({
      label: 'github',
    })
    // The provider a local deployment operates as is not fixed at build time: installing a GitLab
    // token has to re-point the client the engine already holds.
    current = fakeClient('gitlab')
    await expect(client.getRepo(1, { owner: 'o', repo: 'r' })).resolves.toMatchObject({
      label: 'gitlab',
    })
  })

  it('refuses with the actionable cause when the deployment holds no credential', async () => {
    const client = credentialRoutedGitHubClient(() => undefined)
    await expect(client.getRepo(1, { owner: 'o', repo: 'r' })).rejects.toThrow(
      /no source-control token yet/,
    )
  })

  it('is not a THENABLE when the deployment holds no credential', async () => {
    // An object whose `then` is callable is adopted by the promise machinery, so returning the
    // client from an async function would call `then(resolve, reject)` on a refusing function that
    // ignores both — leaving the caller's promise pending FOREVER plus an unhandled rejection,
    // which is strictly worse than the refusal it was raising. The refusal must reach the CALL.
    const client = credentialRoutedGitHubClient(() => undefined)
    await expect(Promise.resolve(client)).resolves.toBe(client)
    const viaAsync: GitHubClient = await (async () => client)()
    await expect(viaAsync.getRepo(1, { owner: 'o', repo: 'r' })).rejects.toThrow(
      /no source-control token yet/,
    )
    // Same shape for a serializing logger, and for any symbol key the language reads as protocol.
    expect((client as unknown as { toJSON?: unknown }).toJSON).toBeUndefined()
    expect((client as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined()
  })

  it("advertises the port's OPTIONAL members exactly as the resolved client does", () => {
    // `listReposForToken` is feature-tested by callers, and the GitLab adapter does not implement
    // it — reporting it present for a GitLab deployment would route a call to nothing.
    const github = credentialRoutedGitHubClient(() => fakeClient('github'))
    const gitlab = credentialRoutedGitHubClient(() => fakeClient('gitlab'))
    expect('listReposForToken' in github).toBe(true)
    expect('listReposForToken' in gitlab).toBe(false)
  })
})
