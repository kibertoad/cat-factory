import type { GitHubRepoRef, IdGenerator, RateLimitRepository } from '@cat-factory/kernel'
import { VcsBlobTooLargeError } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import { GitHubApiError } from '../src/github/githubHttpHelpers.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// The contents read answers three facts the endpoint's own status cannot separate, and getting any of
// them wrong is silent. GitHub reports an over-limit blob as a `403` (the status of a permission
// denial) or as a `200` carrying nothing, and a file whose bytes are not UTF-8 decodes to replacement
// characters that read exactly like odd text. What is pinned here is that each arrives as ITSELF: a
// caller told "your credential was rejected" replaces a working token, one told a 2 MB file is empty
// grades against nothing, and one handed mojibake compares bytes that were never in the repository.

const noopRateLimit: RateLimitRepository = {
  record: async () => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'acme', repo: 'api' }

const patRegistry: AppTokenSource = {
  defaultAppId: '',
  apps: () => [{ appId: '' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'token',
  installationPermissions: async () => ({}),
}

function makeClient(): FetchGitHubClient {
  return new FetchGitHubClient({
    registry: patRegistry,
    rateLimitRepository: noopRateLimit,
    idGenerator,
    clock,
    apiBase: 'https://api.github.com',
  })
}

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

/** GitHub's own over-limit body, which is the only place the cause is stated. */
const tooLargeBody = {
  message:
    'This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API, but you can use the Git Data API to request blobs up to 100 MB in size.',
  errors: [{ resource: 'Blob', field: 'data', code: 'too_large' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.getFileContent', () => {
  it('raises the OVER-LIMIT fact for a 403 that is about the blob, not about the credential', async () => {
    // The misattribution this prevents: every consumer keyed on the status alone read this as a
    // rejected token, and the public file read turned a 1.4 MB lockfile into a 503 telling an operator
    // to re-connect the workspace.
    stubFetch(403, tooLargeBody)
    await expect(makeClient().getFileContent(1, ref, 'pnpm-lock.yaml')).rejects.toBeInstanceOf(
      VcsBlobTooLargeError,
    )
  })

  it('leaves an ordinary 403 alone, so a real permission denial still reads as one', async () => {
    // The other half of the same rule: the size branch keys on what GitHub SAID, so a missing scope
    // must not be re-labelled as a file that is too big.
    stubFetch(403, { message: 'Resource not accessible by integration' })
    await expect(makeClient().getFileContent(1, ref, 'README.md')).rejects.toBeInstanceOf(
      GitHubApiError,
    )
  })

  it('raises the same fact for the 200 the API answers with an empty body', async () => {
    // Past the ceiling the contents API may answer `200` with `encoding: 'none'` and no content, which
    // is otherwise indistinguishable here from a file that is genuinely empty: a caller grading what a
    // run committed would compare against nothing and call it a mismatch in the agent's work.
    stubFetch(200, { type: 'file', content: '', encoding: 'none', sha: 'abc' })
    await expect(makeClient().getFileContent(1, ref, 'dump.sql')).rejects.toBeInstanceOf(
      VcsBlobTooLargeError,
    )
  })

  it('decodes text and says nothing about losing anything', async () => {
    stubFetch(200, { type: 'file', content: 'aGVsbG8=', encoding: 'base64', sha: 'abc' })
    await expect(makeClient().getFileContent(1, ref, 'README.md')).resolves.toEqual({
      content: 'hello',
      sha: 'abc',
    })
  })

  it('reports a LOSSY decode rather than passing replacement characters off as the file', async () => {
    // `//79` is `FF FE FD`: not valid UTF-8, so a non-fatal decode answers three U+FFFDs. Left
    // unreported, a caller hashing the string hashes the decoder's output and a caller diffing it sees
    // a mismatch it cannot attribute to anything.
    stubFetch(200, { type: 'file', content: '//79', encoding: 'base64', sha: 'def' })
    await expect(makeClient().getFileContent(1, ref, 'logo.png')).resolves.toMatchObject({
      lossy: true,
      sha: 'def',
    })
  })

  it('still answers null for an absent path', async () => {
    stubFetch(404, { message: 'Not Found' })
    await expect(makeClient().getFileContent(1, ref, 'missing.md')).resolves.toBeNull()
  })
})
