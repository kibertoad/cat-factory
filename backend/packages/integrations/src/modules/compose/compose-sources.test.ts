import type { RunRepoContext } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { planComposeLayers } from './compose-sources.js'

// A checkout-free repo context whose `getFile` serves a fixed path→content map (and reports the
// ref it was asked for), so the tests below can assert both WHAT was read and AT WHICH ref.
function fakeRepoContext(files: Record<string, string>, baseBranch = 'main') {
  const reads: { path: string; ref: string }[] = []
  const ctx = {
    baseBranch,
    repo: {
      getFile: vi.fn((path: string, ref: string) => {
        reads.push({ path, ref })
        const content = files[path]
        return Promise.resolve(content === undefined ? null : { content })
      }),
    },
  } as unknown as RunRepoContext
  return { ctx, reads }
}

describe('planComposeLayers', () => {
  it('leaves a bare in-repo path to its caller — no content, no foreign read', async () => {
    const resolveForeignRepo = vi.fn()
    const planned = await planComposeLayers(['docker/dev.yml', { kind: 'path', path: 'a.yml' }], {
      resolveForeignRepo,
    })

    expect('error' in planned).toBe(false)
    if ('error' in planned) return
    expect(planned.layers).toEqual([
      { source: { kind: 'path', path: 'docker/dev.yml' }, path: 'docker/dev.yml' },
      { source: { kind: 'path', path: 'a.yml' }, path: 'a.yml' },
    ])
    expect(planned.projectDir).toBe('docker')
    expect(planned.baseDepth).toBe(1)
    expect(planned.needsPrimaryRepo).toBe(true)
    expect(resolveForeignRepo).not.toHaveBeenCalled()
  })

  it('carries an inline document through as content at a generated path', async () => {
    const planned = await planComposeLayers(
      ['docker/dev.yml', { kind: 'inline', content: 'services: {}\n' }],
      {},
    )

    expect('error' in planned).toBe(false)
    if ('error' in planned) return
    expect(planned.layers[1]).toEqual({
      source: { kind: 'inline', content: 'services: {}\n' },
      path: 'docker/.cat-factory/compose/1-inline.yml',
      content: 'services: {}\n',
    })
  })

  it('reads another repo at its declared ref, and at its default branch when none is given', async () => {
    const { ctx, reads } = fakeRepoContext({
      'compose/shared.yml': 'shared',
      'compose/edge.yml': 'edge',
    })
    const planned = await planComposeLayers(
      [
        { kind: 'repo', repo: 'acme/infra', path: 'compose/shared.yml', ref: 'v2' },
        { kind: 'repo', repo: 'acme/infra', path: 'compose/edge.yml' },
      ],
      { resolveForeignRepo: () => Promise.resolve(ctx) },
    )

    expect('error' in planned).toBe(false)
    if ('error' in planned) return
    expect(planned.layers.map((l) => l.content)).toEqual(['shared', 'edge'])
    expect(reads).toEqual([
      { path: 'compose/shared.yml', ref: 'v2' },
      { path: 'compose/edge.yml', ref: 'main' },
    ])
  })

  it('resolves each foreign repo ONCE however many layers name it (no N+1)', async () => {
    const { ctx } = fakeRepoContext({ 'a.yml': 'a', 'b.yml': 'b', 'c.yml': 'c' })
    const resolveForeignRepo = vi.fn(() => Promise.resolve(ctx))
    await planComposeLayers(
      [
        { kind: 'repo', repo: 'acme/infra', path: 'a.yml' },
        { kind: 'repo', repo: 'acme/infra', path: 'b.yml' },
        { kind: 'repo', repo: 'acme/infra', path: 'c.yml' },
      ],
      { resolveForeignRepo },
    )

    expect(resolveForeignRepo).toHaveBeenCalledTimes(1)
  })

  it('reports a repo-less layer list as needing no primary repo', async () => {
    const planned = await planComposeLayers([{ kind: 'inline', content: 'services: {}' }], {})
    expect('error' in planned).toBe(false)
    if ('error' in planned) return
    expect(planned.needsPrimaryRepo).toBe(false)
    expect(planned.projectDir).toBe('')
    expect(planned.baseDepth).toBe(0)
  })

  it('returns a blocking error — never throws — for each unreadable foreign layer', async () => {
    const missing = await planComposeLayers(
      [{ kind: 'repo', repo: 'acme/infra', path: 'nope.yml' }],
      { resolveForeignRepo: () => Promise.resolve(fakeRepoContext({}).ctx) },
    )
    expect(missing).toEqual({ error: "No compose file found at 'acme/infra:nope.yml'." })

    const unresolvable = await planComposeLayers(
      [{ kind: 'repo', repo: 'acme/infra', path: 'c.yml' }],
      { resolveForeignRepo: () => Promise.resolve(null) },
    )
    expect('error' in unresolvable && unresolvable.error).toContain(
      "No VCS connection could read 'acme/infra'",
    )

    // No resolver wired at all (no VCS connection on this deployment) is its own message, and
    // points at the alternative that does work here.
    const unwired = await planComposeLayers(
      [{ kind: 'repo', repo: 'acme/infra', path: 'c.yml' }],
      {},
    )
    expect('error' in unwired && unwired.error).toContain('supply the layer inline')
  })

  it('turns a THROWING resolver or read into a blocking error, not an escaping rejection', async () => {
    // The absent cases above are the easy half. A live VCS call fails far more often by REJECTING
    // (5xx, rate limit, revoked token) than by answering "not found", and both callers persist our
    // return value as the run's cause of death — an escaping throw would leave a shared stack stuck
    // at `starting` with nothing recorded.
    const resolverThrew = await planComposeLayers(
      [{ kind: 'repo', repo: 'acme/infra', path: 'a.yml' }],
      {
        resolveForeignRepo: () => Promise.reject(new Error('GitHub API 503')),
      },
    )
    expect('error' in resolverThrew && resolverThrew.error).toContain('GitHub API 503')
    expect('error' in resolverThrew && resolverThrew.error).toContain('acme/infra')

    // …and the converted message is SCRUBBED: it is persisted as `lastError` and rendered in the
    // SPA, while a private-repo fetch failure routinely echoes a tokenized request URL.
    const leaky = await planComposeLayers([{ kind: 'repo', repo: 'acme/infra', path: 'a.yml' }], {
      resolveForeignRepo: () =>
        Promise.reject(new Error('GET https://x-access-token:ghp_0123456789abcdefghij@host/a 401')),
    })
    expect('error' in leaky && leaky.error).not.toContain('ghp_0123456789abcdefghij')

    const { ctx } = fakeRepoContext({})
    vi.mocked(ctx.repo.getFile).mockRejectedValueOnce(new Error('rate limited'))
    const readThrew = await planComposeLayers(
      [{ kind: 'repo', repo: 'acme/infra', path: 'a.yml' }],
      {
        resolveForeignRepo: () => Promise.resolve(ctx),
      },
    )
    expect('error' in readThrew && readThrew.error).toContain('rate limited')
  })

  it('keys the foreign-repo cache by PROVIDER as well as slug', async () => {
    // `acme/infra` on GitHub and `acme/infra` on GitLab are different repos. A slug-only cache key
    // would serve the first one's context to the second one's layers — and silently, since both
    // reads succeed.
    const gh = fakeRepoContext({ 'a.yml': 'from-github' })
    const gl = fakeRepoContext({ 'a.yml': 'from-gitlab' })
    const planned = await planComposeLayers(
      [
        { kind: 'repo', repo: 'acme/infra', path: 'a.yml', provider: 'github' },
        { kind: 'repo', repo: 'acme/infra', path: 'a.yml', provider: 'gitlab' },
      ],
      {
        resolveForeignRepo: (coords) =>
          Promise.resolve(coords.provider === 'gitlab' ? gl.ctx : gh.ctx),
      },
    )

    expect('error' in planned).toBe(false)
    if ('error' in planned) return
    expect(planned.layers.map((l) => l.content)).toEqual(['from-github', 'from-gitlab'])
  })

  it('refuses a layer that would be materialized OUTSIDE the checkout, before reading anything', async () => {
    // An `inline` layer names where it lands, and that path becomes the `relPath` of a
    // `writeCheckoutFile` whose runtime implementation is a bare join — so an unguarded `../` is an
    // arbitrary host-file write with caller-chosen content. Refused here so BOTH consumers inherit
    // the rule (the recipe path also checks it pre-daemon; the shared-stack bring-up has no
    // preflight of its own).
    const resolveForeignRepo = vi.fn()
    const escaped = await planComposeLayers(
      ['docker/dev.yml', { kind: 'inline', content: 'services: {}', path: '../../evil.yml' }],
      { resolveForeignRepo },
    )
    expect('error' in escaped && escaped.error).toContain('escapes the checkout')
    expect('error' in escaped && escaped.error).toContain('../../evil.yml')
    // Refused BEFORE any repo work — an unsafe list is never partially resolved.
    expect(resolveForeignRepo).not.toHaveBeenCalled()

    for (const path of ['/etc/cron.d/x.yml', '~/x.yml', '${HOME}/x.yml', 'a/../../b.yml']) {
      const issue = await planComposeLayers([{ kind: 'inline', content: 's', path }], {})
      expect('error' in issue && issue.error).toContain('escapes the checkout')
    }
  })

  it('refuses an empty layer list', async () => {
    expect(await planComposeLayers([], {})).toEqual({
      error: 'No compose files are configured for this stack.',
    })
  })
})
