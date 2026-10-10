import { describe, expect, it } from 'vitest'
import type { RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { readServiceSpec } from '../src/repo-ops/readServiceSpec.js'

// An in-memory RepoFiles over a flat path→content map. listDirectory derives entries from
// the keys (one level deep), so the reader is exercised exactly as it walks a real repo.
function fakeRepo(files: Record<string, string>): RepoFiles {
  const getFile: RepoFiles['getFile'] = async (path) =>
    path in files ? { content: files[path]!, sha: `sha-${path}` } : null

  const listDirectory: RepoFiles['listDirectory'] = async (dir) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const seen = new Map<string, RepoContentEntry>()
    for (const full of Object.keys(files)) {
      if (!full.startsWith(prefix)) continue
      const rest = full.slice(prefix.length)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      const path = `${prefix}${name}`
      if (!seen.has(path)) {
        seen.set(path, { path, name, type: slash === -1 ? 'file' : 'dir', sha: `sha-${path}` })
      }
    }
    return [...seen.values()]
  }

  return {
    getFile,
    listDirectory,
    headSha: async () => null,
    createBranch: async () => undefined,
    deleteBranch: async () => undefined,
    commitFiles: async () => ({ sha: 'c' }),
    openPullRequest: async () => ({ number: 1, url: 'u' }) as never,
  }
}

describe('readServiceSpec', () => {
  it('returns an empty (absent) view when no spec/service.json exists', async () => {
    const view = await readServiceSpec(fakeRepo({}), 'main')
    expect(view).toEqual({
      present: false,
      spec: null,
      features: [],
      // ABSENT, not `read_failed`: the branch simply holds no spec. The two produce the same
      // empty tree and are the pair every consumer of this reader has to be able to separate.
      diagnostics: { anchor: 'absent', issues: [] },
    })
  })

  it('reassembles the sharded tree (modules → groups → requirements) and Gherkin files', async () => {
    const repo = fakeRepo({
      'spec/service.json': JSON.stringify({ service: 'Checkout', summary: 'Buy things.' }),
      'spec/overview.md': '# Overview',
      'spec/modules/auth/_module.json': JSON.stringify({ name: 'Auth', summary: 'Sign in.' }),
      'spec/modules/auth/login.json': JSON.stringify({
        name: 'Login',
        summary: 'Email + password.',
        requirements: [
          {
            id: 'req-login',
            title: 'Login',
            statement: 'The system SHALL authenticate a user.',
            kind: 'functional',
            priority: 'must',
            acceptance: [
              { id: 'req-login-ac-1', given: 'a user', when: 'they sign in', outcome: 'a session' },
            ],
          },
        ],
        rules: [{ id: 'rule-1', rule: 'Passwords are hashed.' }],
      }),
      'spec/modules/auth/login.md': '# Login',
      'spec/features/auth/login.feature': 'Feature: Auth — Login\n  Scenario: Login\n',
    })

    const view = await readServiceSpec(repo, 'main')

    expect(view.present).toBe(true)
    expect(view.spec?.service).toBe('Checkout')
    const module = view.spec?.modules?.[0]
    expect(module?.name).toBe('Auth')
    const group = module?.groups?.[0]
    expect(group?.name).toBe('Login')
    expect(group?.requirements?.[0]?.id).toBe('req-login')
    expect(group?.requirements?.[0]?.acceptance?.[0]?.outcome).toBe('a session')
    expect(group?.rules?.[0]?.rule).toBe('Passwords are hashed.')

    // The feature file is labelled with the resolved module + group DISPLAY names (not slugs).
    expect(view.features).toHaveLength(1)
    expect(view.features[0]).toMatchObject({
      module: 'Auth',
      group: 'Login',
      path: 'spec/features/auth/login.feature',
    })
    expect(view.features[0]!.content).toContain('Feature: Auth — Login')
  })

  it('ignores _module.json as a group shard and tolerates a malformed shard', async () => {
    const repo = fakeRepo({
      'spec/service.json': JSON.stringify({ service: 'S' }),
      'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
      'spec/modules/m/good.json': JSON.stringify({ name: 'Good', requirements: [] }),
      'spec/modules/m/broken.json': '{ not json',
    })

    const view = await readServiceSpec(repo, 'main')
    expect(view.present).toBe(true)
    // The module is present; the malformed shard is dropped, the good one kept.
    const groups = view.spec?.modules?.[0]?.groups ?? []
    expect(groups.map((g) => g.name)).toEqual(['Good'])
  })

  it('still presents the tree when the service name is empty (degrade, not blank)', async () => {
    const repo = fakeRepo({
      // A present-but-empty service name must NOT blank the whole spec: the SPA falls back to
      // the block title, so the modules should still come through.
      'spec/service.json': JSON.stringify({ service: '' }),
      'spec/modules/auth/_module.json': JSON.stringify({ name: 'Auth' }),
      'spec/modules/auth/login.json': JSON.stringify({ name: 'Login', requirements: [] }),
    })

    const view = await readServiceSpec(repo, 'main')
    expect(view.present).toBe(true)
    expect(view.spec?.service).toBe('')
    expect(view.spec?.modules?.[0]?.name).toBe('Auth')
    expect(view.spec?.modules?.[0]?.groups?.[0]?.name).toBe('Login')
    // And NOT reported as damage: "this spec names no service" is a state the read doc exists to
    // express, so flagging it would fire the repair row on the ordinary case.
    expect(view.diagnostics?.issues).toEqual([])
  })

  it('degrades a blank _module.json name to the slug instead of dropping the module', async () => {
    const repo = fakeRepo({
      'spec/service.json': JSON.stringify({ service: 'S' }),
      // A present-but-empty module name must fall back to the slug (`blank`), NOT drop the
      // whole module + its valid groups — a corrupt/half-written `_module.json` shouldn't be
      // worse than a missing one (which already falls back to the slug).
      'spec/modules/blank/_module.json': JSON.stringify({ name: '' }),
      'spec/modules/blank/g.json': JSON.stringify({ name: 'G', requirements: [] }),
      'spec/modules/good/_module.json': JSON.stringify({ name: 'Good' }),
      'spec/modules/good/g.json': JSON.stringify({ name: 'G', requirements: [] }),
    })

    const view = await readServiceSpec(repo, 'main')
    expect(view.present).toBe(true)
    expect(view.spec?.modules?.map((m) => m.name)?.sort()).toEqual(['Good', 'blank'])
  })

  it('salvages a group per requirement — one over-long title drops only that requirement', async () => {
    const repo = fakeRepo({
      'spec/service.json': JSON.stringify({ service: 'S' }),
      'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
      // The lenient writer never caps `title`/`statement`, but the reader's schema does
      // (title maxLength 120). The over-long requirement must drop ALONE — its valid sibling,
      // the group, and the group's rules all survive.
      'spec/modules/m/g.json': JSON.stringify({
        name: 'Group',
        requirements: [
          {
            id: 'req-toolong',
            title: 'x'.repeat(200),
            statement: 'The system SHALL do the thing.',
            kind: 'functional',
            priority: 'must',
          },
          {
            id: 'req-ok',
            title: 'Valid',
            statement: 'The system SHALL also do this.',
            kind: 'functional',
            priority: 'should',
          },
        ],
        rules: [{ id: 'rule-1', rule: 'An invariant holds.' }],
      }),
    })

    const view = await readServiceSpec(repo, 'main')
    expect(view.present).toBe(true)
    const group = view.spec?.modules?.[0]?.groups?.[0]
    expect(group?.name).toBe('Group')
    // The over-long requirement is gone; the valid sibling + the rule remain.
    expect(group?.requirements?.map((r) => r.id)).toEqual(['req-ok'])
    expect(group?.rules?.map((r) => r.id)).toEqual(['rule-1'])
  })

  it('never throws when a repo read fails, and the empty view SAYS the read failed', async () => {
    const repo = fakeRepo({})
    repo.getFile = async () => {
      throw new Error('GitHub 502')
    }
    const view = await readServiceSpec(repo, 'main')
    // Same empty tree as the absent case above, and a different diagnosis. This pair is the
    // whole reason the field exists: without it a VCS outage is indistinguishable from a
    // service that has written no requirements, and every caller reports the wrong one.
    expect(view).toEqual({
      present: false,
      spec: null,
      features: [],
      diagnostics: {
        anchor: 'read_failed',
        issues: [{ path: 'spec/service.json', kind: 'read_failed', dropped: 0 }],
      },
    })
  })

  it('separates a CORRUPT anchor from an absent one, naming the file', async () => {
    const view = await readServiceSpec(fakeRepo({ 'spec/service.json': '{ not json' }), 'main')
    // A half-written anchor is a repo state somebody has to fix, not a branch with no spec and
    // not a provider outage: three empty trees, three different remedies.
    expect(view.present).toBe(false)
    expect(view.diagnostics).toEqual({
      anchor: 'unparsed',
      issues: [{ path: 'spec/service.json', kind: 'unparsed', dropped: 0 }],
    })
  })

  it('names a shard that failed to READ, and keeps the rest of the tree', async () => {
    const files = {
      'spec/service.json': JSON.stringify({ service: 'S' }),
      'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
      'spec/modules/m/good.json': JSON.stringify({ name: 'Good', requirements: [] }),
      'spec/modules/m/flaky.json': JSON.stringify({ name: 'Flaky', requirements: [] }),
    }
    const repo = fakeRepo(files)
    const underlying = repo.getFile
    repo.getFile = async (path, ref) => {
      if (path === 'spec/modules/m/flaky.json') throw new Error('GitHub 502')
      return underlying(path, ref)
    }

    const view = await readServiceSpec(repo, 'main')
    expect(view.present).toBe(true)
    expect(view.spec?.modules?.[0]?.groups?.map((g) => g.name)).toEqual(['Good'])
    // The group that did not arrive is NAMED. Dropped silently it would read as a service that
    // never declared it, which is the same lie the anchor cases above avoid, one file smaller.
    expect(view.diagnostics?.issues).toEqual([
      { path: 'spec/modules/m/flaky.json', kind: 'read_failed', dropped: 0 },
    ])
  })

  it('reports a SALVAGED group as partial, counting the items it lost', async () => {
    const repo = fakeRepo({
      'spec/service.json': JSON.stringify({ service: 'S' }),
      'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
      'spec/modules/m/g.json': JSON.stringify({
        name: 'Group',
        requirements: [
          {
            id: 'req-toolong',
            title: 'x'.repeat(200),
            statement: 'S.',
            kind: 'functional',
            priority: 'must',
          },
          { id: 'req-ok', title: 'Valid', statement: 'S.', kind: 'functional', priority: 'should' },
        ],
        rules: [
          { id: 'rule-1', rule: 'An invariant holds.' },
          { id: '', rule: '' },
        ],
      }),
    })

    const view = await readServiceSpec(repo, 'main')
    // The salvage rebuilds a VALID-LOOKING group that is quietly missing items, so a reader
    // counting coverage off it would report a smaller spec as a complete one. `partial` and its
    // count are what make that visible.
    expect(view.diagnostics?.issues).toEqual([
      { path: 'spec/modules/m/g.json', kind: 'partial', dropped: 2 },
    ])
  })

  it('reports an UNPARSED shard, and a clean read carries no issues at all', async () => {
    const broken = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S' }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/broken.json': '{ not json',
      }),
      'main',
    )
    expect(broken.diagnostics).toEqual({
      anchor: 'present',
      issues: [{ path: 'spec/modules/m/broken.json', kind: 'unparsed', dropped: 0 }],
    })

    const clean = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S' }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/g.json': JSON.stringify({ name: 'G', requirements: [] }),
      }),
      'main',
    )
    expect(clean.diagnostics).toEqual({ anchor: 'present', issues: [] })
  })

  it('reports an UNCOUNTABLE salvage loss as null, never as zero', async () => {
    // `requirements` present but not a list: those requirements are lost exactly as a failed
    // validation loses them, and there is nothing to count. Coercing the container to `[]` and
    // reporting `dropped: 0` rebuilds a group that VALIDATES and declares nothing, which defeats
    // the salvage's whole purpose precisely where the shard was most badly damaged.
    const view = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S' }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/g.json': JSON.stringify({
          name: 'G',
          requirements: { 'req-a': { id: 'req-a' } },
        }),
      }),
      'main',
    )
    expect(view.diagnostics?.issues).toEqual([
      { path: 'spec/modules/m/g.json', kind: 'partial', dropped: null },
    ])
    // The group still names itself: its identity survived even though its contents did not.
    expect(view.spec?.modules?.[0]?.groups?.[0]?.name).toBe('G')
  })

  it('keeps "declares none" and "unreadable" apart when a container is simply ABSENT', async () => {
    // The other side of the rule above. `rules` is omitted here, which legitimately means "this
    // group declares none", while `requirements` holds one item that fails validation. The loss
    // is therefore countable, and answering `null` would report an omitted optional field as
    // damage on every ordinary salvage.
    const view = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S' }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/g.json': JSON.stringify({
          name: 'G',
          requirements: [{ id: 'req-a', title: 'T'.repeat(200) }],
        }),
      }),
      'main',
    )
    expect(view.diagnostics?.issues).toEqual([
      { path: 'spec/modules/m/g.json', kind: 'partial', dropped: 1 },
    ])
  })

  it('stops walking at its READ BUDGET and says how many files it never fetched', async () => {
    const files: Record<string, string> = {
      'spec/service.json': JSON.stringify({ service: 'S' }),
      'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
    }
    for (let i = 0; i < 20; i++) {
      files[`spec/modules/m/g${i}.json`] = JSON.stringify({ name: `G${i}`, requirements: [] })
    }
    const repo = fakeRepo(files)
    let reads = 0
    const getFile = repo.getFile.bind(repo)
    repo.getFile = async (path, ref) => {
      reads += 1
      return getFile(path, ref)
    }

    const view = await readServiceSpec(repo, 'main', { maxReads: 6 })
    // The bound is the point: the tree's size is set by somebody else's repository, and one
    // request may not turn into an unbounded number of provider round trips.
    expect(reads).toBeLessThanOrEqual(6)
    const unread = view.diagnostics?.issues.filter((i) => i.kind === 'unread') ?? []
    // ONE row for the whole stopped walk: a row per skipped file would make the budget's own
    // report the largest thing in the response, which is what the budget exists to prevent.
    expect(unread).toHaveLength(1)
    expect(unread[0]?.path).toBe('spec')
    expect(unread[0]?.dropped).toBeGreaterThan(0)
    // Still a usable, honestly-labelled partial view rather than a refusal.
    expect(view.present).toBe(true)
  })

  it('leaves a spec that fits its budget completely unremarked', async () => {
    const view = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S' }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/g.json': JSON.stringify({ name: 'G', requirements: [] }),
      }),
      'main',
    )
    expect(view.diagnostics?.issues).toEqual([])
  })

  it('coerces the anchor to what the doc schema will PARSE, and reports the repair', async () => {
    // The reader's output is typed as the read-doc schema, and until it clamped it was not: an
    // over-long name or a non-string summary produced a view failing the schema its own type
    // names. On `/api/v1` that is a 200 violating the contract it is published under.
    const view = await readServiceSpec(
      fakeRepo({
        'spec/service.json': JSON.stringify({ service: 'S'.repeat(200), summary: 42 }),
        'spec/modules/m/_module.json': JSON.stringify({ name: 'M' }),
        'spec/modules/m/g.json': JSON.stringify({ name: 'G', requirements: [] }),
      }),
      'main',
    )
    expect(view.spec?.service).toHaveLength(120)
    expect(view.spec?.summary).toBe('')
    // Reported, because a clamped name is content this view does not carry.
    expect(view.diagnostics?.issues).toEqual([
      { path: 'spec/service.json', kind: 'partial', dropped: null },
    ])
  })
})
