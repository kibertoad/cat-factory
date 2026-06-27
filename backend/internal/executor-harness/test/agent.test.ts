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

  it('carries failOnUnusableFinal through (document producers fail loudly on a cut-off reply)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', shapeHint: '{"service":string}', failOnUnusableFinal: true },
    })
    // The handler gates on `output.failOnUnusableFinal` BEFORE the structured repair, so a
    // truncated final answer fails the run instead of being laundered into a half-baked doc.
    expect(job.output).toEqual({
      kind: 'structured',
      shapeHint: '{"service":string}',
      failOnUnusableFinal: true,
    })
  })

  it('carries the explore-mode infra stand-up spec through (the tester)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured' },
      infra: { environment: 'local', composePath: 'docker-compose.yml' },
    })
    expect(job.infra).toEqual({ environment: 'local', composePath: 'docker-compose.yml' })
  })

  it('drops an infra spec with no recognised environment', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: { composePath: 'docker-compose.yml' },
    })
    expect(job.infra).toBeUndefined()
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

  it('carries per-knob progress-guard overrides through, clamping each knob', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      guardLimits: {
        maxConsecutiveErrors: 20, // valid → kept
        maxConsecutiveWebCalls: 40.7, // floored to 40
        maxToolCallsWithoutEdit: -5, // invalid → dropped (keeps env/default)
      },
    })
    expect(job.guardLimits).toEqual({ maxConsecutiveErrors: 20, maxConsecutiveWebCalls: 40 })
  })

  it('drops a guardLimits object with no usable knobs', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      guardLimits: { maxConsecutiveErrors: 'nope', maxConsecutiveWebCalls: 0 },
    })
    expect(job.guardLimits).toBeUndefined()
  })

  it('carries the conflict-resolver merge base through (coding mode)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      branch: 'cat-factory/blk_1',
      full: true,
      mergeBase: 'main',
      noChangesIsError: false,
    })
    // The handler keys off `mergeBase` to run the conflict-resolution flow (merge the base
    // in, resolve, complete the merge commit + push) instead of the ordinary coding flow.
    expect(job.mergeBase).toBe('main')
  })

  it('drops an empty mergeBase', () => {
    const job = parseAgentJob({ ...base, mode: 'coding', mergeBase: '' })
    expect(job.mergeBase).toBeUndefined()
  })

  it('carries the bootstrap spec through (clone + adapt a reference)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      bootstrap: {
        target: {
          owner: 'acme',
          name: 'new-svc',
          cloneUrl: 'https://github.com/acme/new-svc.git',
          defaultBranch: 'main',
        },
      },
    })
    // The handler keys off `bootstrap` to force-push a fresh history to the target repo.
    expect(job.bootstrap).toEqual({
      target: {
        owner: 'acme',
        name: 'new-svc',
        cloneUrl: 'https://github.com/acme/new-svc.git',
        defaultBranch: 'main',
      },
    })
  })

  it('carries the from-scratch bootstrap flag through', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      bootstrap: {
        target: {
          owner: 'acme',
          name: 'new-svc',
          cloneUrl: 'https://github.com/acme/new-svc.git',
          defaultBranch: 'main',
        },
        fromScratch: true,
      },
    })
    expect(job.bootstrap?.fromScratch).toBe(true)
  })

  it('rejects a bootstrap target clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'coding',
        bootstrap: {
          target: {
            owner: 'acme',
            name: 'new-svc',
            cloneUrl: 'https://evil.example/acme/new-svc.git',
            defaultBranch: 'main',
          },
        },
      }),
    ).toThrow(/not an allowed GitHub host/)
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

  it('omits a monorepo serviceDirectory when absent (whole-repo run)', () => {
    expect(parseAgentJob({ ...base, mode: 'explore' }).repo.serviceDirectory).toBeUndefined()
  })

  it('normalises a monorepo serviceDirectory to a clean relative path', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      repo: { ...base.repo, serviceDirectory: '/packages/api/' },
    })
    expect(job.repo.serviceDirectory).toBe('packages/api')
  })

  it('rejects a serviceDirectory that escapes the checkout', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'coding',
        repo: { ...base.repo, serviceDirectory: '../secrets' },
      }),
    ).toThrow(/serviceDirectory/)
  })
})
