import type { SecretResolver } from '@cat-factory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HttpRunnerPoolProvider,
  RunnerPoolApiError,
} from '../../src/infrastructure/runners/HttpRunnerPoolProvider'
import { recordingFetch } from './environment.fixtures'
import { bearerRunnerManifest, RUNNER_API_TOKEN, sampleJobSpec } from './runner-pool.fixtures'

// The generic manifest interpreter: it must dispatch/poll/release against the
// org's pool scheduler with the declared auth, map the scheduler's arbitrary
// response onto the canonical harness job view, and guard every URL (SSRF) — all
// without leaking secrets into errors.

const resolveSecret: SecretResolver = (key) => (key === 'API_TOKEN' ? RUNNER_API_TOKEN : undefined)

describe('HttpRunnerPoolProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('dispatches the job with bearer auth and forwards the spec verbatim', async () => {
    const { fn, calls } = recordingFetch(() => ({ status: 202, body: { id: 'ex-1' } }))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    const spec = sampleJobSpec()
    await provider.dispatch({
      manifest: bearerRunnerManifest(),
      jobId: 'ex-1',
      spec,
      resolveSecret,
    })

    expect(calls).toHaveLength(1)
    const req = calls[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://pool.test/api/jobs')
    expect(req.headers.authorization).toBe(`Bearer ${RUNNER_API_TOKEN}`)
    // The full harness spec is forwarded under `job`, keyed on the job id.
    const sent = JSON.parse(req.body!) as { id: string; job: Record<string, unknown> }
    expect(sent.id).toBe('ex-1')
    expect(sent.job).toMatchObject({ ghToken: 'gh-tok', model: 'qwen3-max' })
  })

  it('maps a running poll with subtask progress', async () => {
    const { fn } = recordingFetch(() => ({
      body: { state: 'in_progress', progress: { completed: 3, inProgress: 1, total: 8 } },
    }))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({
      manifest: bearerRunnerManifest(),
      jobId: 'ex-1',
      resolveSecret,
    })
    expect(view).toEqual({ state: 'running', progress: { completed: 3, inProgress: 1, total: 8 } })
  })

  it('maps a finished poll onto the result (PR url, branch, summary)', async () => {
    const { fn, calls } = recordingFetch(() => ({
      body: {
        state: 'succeeded',
        result: {
          pr_url: 'https://github.com/octo/app/pull/42',
          branch: 'cat-factory/blk-1-abcd1234',
          summary: 'Added limiter',
        },
      },
    }))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({
      manifest: bearerRunnerManifest(),
      jobId: 'ex-1',
      resolveSecret,
    })
    expect(calls[0]!.url).toBe('https://pool.test/api/jobs/ex-1')
    expect(view.state).toBe('done')
    expect(view.result).toEqual({
      prUrl: 'https://github.com/octo/app/pull/42',
      branch: 'cat-factory/blk-1-abcd1234',
      summary: 'Added limiter',
    })
  })

  it('maps a failed poll onto an error', async () => {
    const { fn } = recordingFetch(() => ({ body: { state: 'errored', error: 'runner OOM' } }))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({
      manifest: bearerRunnerManifest(),
      jobId: 'ex-1',
      resolveSecret,
    })
    expect(view).toEqual({ state: 'failed', error: 'runner OOM' })
  })

  it('releases the job when the manifest declares a release template', async () => {
    const { fn, calls } = recordingFetch(() => ({ status: 200 }))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    await provider.release({ manifest: bearerRunnerManifest(), jobId: 'ex-1', resolveSecret })
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://pool.test/api/jobs/ex-1' })
  })

  it('rejects an internal base URL (SSRF guard) before fetching', async () => {
    const { fn, calls } = recordingFetch(() => ({}))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    await expect(
      provider.poll({
        manifest: bearerRunnerManifest({ baseUrl: 'https://169.254.169.254/api' }),
        jobId: 'ex-1',
        resolveSecret,
      }),
    ).rejects.toThrow(/public host/)
    expect(calls).toHaveLength(0)
  })

  it('fails with a clear (redacted) error when a referenced secret is missing', async () => {
    const { fn } = recordingFetch(() => ({}))
    vi.stubGlobal('fetch', fn)

    const provider = new HttpRunnerPoolProvider()
    await expect(
      provider.poll({
        manifest: bearerRunnerManifest(),
        jobId: 'ex-1',
        resolveSecret: () => undefined,
      }),
    ).rejects.toBeInstanceOf(RunnerPoolApiError)
  })
})
