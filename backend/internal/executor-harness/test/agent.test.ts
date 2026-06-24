import { describe, expect, it } from 'vitest'
import { parseAgentJob } from '../src/job.js'

// The generic, manifest-driven agent kind's body validator. The handler itself
// (handleAgent) spawns Pi + git, so it is covered by the acceptance suite; here we
// lock the parse/validation surface like the other parse*Job tests.

const base = {
  jobId: 'job_123',
  systemPrompt: 'You are an agent.',
  userPrompt: 'Do the thing.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  repo: {
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
    cloneUrl: 'https://github.com/acme/widgets.git',
  },
  branch: 'main',
}

describe('parseAgentJob', () => {
  it('accepts a structured explore job', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', shapeHint: '{"x":number}', repair: true },
    })
    expect(job.mode).toBe('explore')
    expect(job.output).toEqual({ kind: 'structured', shapeHint: '{"x":number}', repair: true })
    expect(job.branch).toBe('main')
  })

  it('carries an explicit repair:false through (so the handler skips the repair call)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', repair: false },
    })
    // The handler keys off `output.repair === false`; dropping it would silently re-enable
    // the one-shot repair call for a kind that opted out.
    expect(job.output).toEqual({ kind: 'structured', repair: false })
  })

  it('accepts a coding job with a fresh branch + PR', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      newBranch: 'cat-factory/blk_1',
      pushBranch: 'cat-factory/blk_1',
      commitMessage: 'Implement the thing',
      pr: { title: 'Implement', body: 'body' },
    })
    expect(job.mode).toBe('coding')
    expect(job.newBranch).toBe('cat-factory/blk_1')
    expect(job.pr).toEqual({ title: 'Implement', body: 'body' })
  })

  it('treats a non-structured output as prose (no output spec) and defaults flags', () => {
    const job = parseAgentJob({ ...base, mode: 'coding' })
    expect(job.output).toBeUndefined()
    expect(job.noChangesIsError).toBeUndefined() // default behaviour = error
    expect(job.full).toBeUndefined()
  })

  it('carries the non-fatal no-op + full-history flags through', () => {
    const job = parseAgentJob({ ...base, mode: 'coding', noChangesIsError: false, full: true })
    expect(job.noChangesIsError).toBe(false)
    expect(job.full).toBe(true)
  })

  it('rejects a missing / invalid mode', () => {
    expect(() => parseAgentJob({ ...base })).toThrow(/mode/)
    expect(() => parseAgentJob({ ...base, mode: 'nonsense' })).toThrow(/mode/)
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'explore',
        repo: { ...base.repo, cloneUrl: 'https://evil.example/acme/widgets.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing branch', () => {
    const { branch: _branch, ...rest } = base
    expect(() => parseAgentJob({ ...rest, mode: 'explore' })).toThrow(/branch/)
  })
})
