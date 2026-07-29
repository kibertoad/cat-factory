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

  it('refuses an empty layer list', async () => {
    expect(await planComposeLayers([], {})).toEqual({
      error: 'No compose files are configured for this stack.',
    })
  })
})
