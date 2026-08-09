import { describe, expect, it } from 'vitest'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { REMOTE_PERSISTENCE_METHODS } from '@cat-factory/server'
import { applyMothershipRemoteRepos, pickRepoSource } from '../src/container.js'
import {
  selectNodeFoundationalServiceDeps,
  selectNodeFragmentLibraryDeps,
  selectNodeSkillLibraryDeps,
} from '../src/container-content-library-deps.js'

// The Phase-3 `db: undefined` audit seam (docs/initiatives/mothership-mode.md): every org/durable
// store a standard build constructs directly from the Drizzle `db` routes through
// `pickRepoSource`, so in mothership mode (no Postgres) it comes from the remote registry instead
// of an absent db. Pure unit coverage of that routing decision — the wiring (each site uses it
// with the matching repo name) is then kept honest by `tsc` + the no-Postgres build test.

describe('pickRepoSource (mothership direct-db routing seam)', () => {
  it('builds the Drizzle repo when there is no remote registry (standard db build)', () => {
    let built = false
    const repo = { tag: 'drizzle' }
    const result = pickRepoSource(undefined, 'notificationRepository', () => {
      built = true
      return repo
    })
    expect(built).toBe(true)
    expect(result).toBe(repo)
  })

  it('sources the named entry from the remote registry without building (mothership)', () => {
    const remoteEntry = { tag: 'remote-proxy' }
    const remote: Record<string, unknown> = { notificationRepository: remoteEntry }
    let built = false
    const result = pickRepoSource(remote, 'notificationRepository', () => {
      built = true
      return { tag: 'drizzle' }
    })
    // The remote entry is returned and the Drizzle builder is NEVER invoked (no db to build over).
    expect(built).toBe(false)
    expect(result).toBe(remoteEntry)
  })

  it('keys strictly by the requested name (a mismatched name resolves undefined, never the builder)', () => {
    const remote: Record<string, unknown> = { bootstrapJobRepository: { tag: 'remote' } }
    // A present remote registry means mothership mode — even an absent name must NOT fall back to
    // building a Drizzle repo over the (nonexistent) db; it resolves the registry slot as-is.
    const result = pickRepoSource(remote, 'notificationRepository', () => ({ tag: 'drizzle' }))
    expect(result).toBeUndefined()
  })
})

// The OTHER half of that seam, and the one `pickRepoSource` cannot speak for: the content-library
// sub-helpers build their repos DIRECTLY from `db` (they are gated on their own config, so they
// cannot take the `sourced` closure), which means mothership mode depends on
// `applyMothershipRemoteRepos` re-pointing each one. Nothing structurally connected the two, and
// the gap that opened is the quiet kind: a repo the allow-list NAMES as remote, built over an
// absent `db`, is a `TypeError` on the run path rather than a clean `unknown_method` — so it reads
// as a crash with no mention of mothership mode anywhere in it.
//
// So assert the RELATION rather than a hand-kept list: every repository one of these helpers builds
// AND the allow-list names as remotely callable must be re-pointed. Both sides are derived from the
// code under test (the helper's own returned keys; the allow-list's own table), so a new library
// repo joins this assertion by existing.
describe('applyMothershipRemoteRepos (content-library re-sourcing)', () => {
  // `db` is only stored by the constructors, never touched at build time, so a sentinel is enough
  // to enumerate what each helper wires. The GitHub client is absent on purpose: its presence adds
  // only non-repository deps (the installation resolver), which this relation does not cover.
  const db = {} as never
  const installations = {} as never
  const workspaces = {} as never
  const enabled = {
    fragmentLibrary: { enabled: true, selector: 'deterministic' },
    agents: { routing: { default: { ref: undefined } } },
  } as never

  const builtByHelpers = (): string[] => [
    ...Object.keys(
      selectNodeFragmentLibraryDeps({
        config: enabled,
        env: {} as never,
        db,
        githubClient: undefined,
        installations,
        workspaces,
        modelProviderResolver: {} as never,
      }),
    ),
    ...Object.keys(selectNodeSkillLibraryDeps(enabled, db, undefined, installations, workspaces)),
    ...Object.keys(selectNodeFoundationalServiceDeps(db, undefined, installations, workspaces)),
  ]

  it('re-points every built repository the allow-list names as remote', () => {
    const names = builtByHelpers().filter((name) => name in REMOTE_PERSISTENCE_METHODS)
    // Sanity: the relation is only meaningful if the intersection is non-empty, and it is derived
    // (not pinned), so it grows with the libraries rather than needing a re-pinned count.
    expect(names.length).toBeGreaterThan(0)

    // Start from Drizzle sentinels, hand the function remote sentinels, and check what moved.
    const dependencies = Object.fromEntries(
      names.map((name) => [name, { source: 'drizzle', name }]),
    ) as unknown as CoreDependencies
    const remoteRepos = Object.fromEntries(names.map((name) => [name, { source: 'remote', name }]))
    applyMothershipRemoteRepos(dependencies, remoteRepos)

    const stillLocal = names.filter(
      (name) =>
        (dependencies as unknown as Record<string, { source: string }>)[name]?.source !== 'remote',
    )
    expect(stillLocal).toEqual([])
  })

  it('is a no-op outside mothership mode (no remote registry)', () => {
    const drizzle = { source: 'drizzle' }
    const dependencies = { promptFragmentRepository: drizzle } as unknown as CoreDependencies
    applyMothershipRemoteRepos(dependencies, undefined)
    expect(dependencies.promptFragmentRepository).toBe(drizzle)
  })

  it('leaves an UNCONFIGURED library alone, so routing cannot switch a module on', () => {
    // The fragment/skill libraries assemble from their repo ALONE, so setting one unconditionally
    // would force fragment resolution on every run against a mothership that may not wire it. The
    // foundational-services catalog is deliberately ungated, so it is routed unconditionally — the
    // asymmetry is the point, and this pins it.
    const dependencies = {} as CoreDependencies
    applyMothershipRemoteRepos(dependencies, {
      promptFragmentRepository: { source: 'remote' },
      foundationalServiceRepository: { source: 'remote' },
    })
    expect(dependencies.promptFragmentRepository).toBeUndefined()
    expect(dependencies.foundationalServiceRepository).toMatchObject({ source: 'remote' })
  })
})
