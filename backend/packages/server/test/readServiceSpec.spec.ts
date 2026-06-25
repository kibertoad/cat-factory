import { describe, expect, it } from 'vitest'
import type { RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { readServiceSpec } from '../src/modules/serviceSpec/readServiceSpec.js'

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
    commitFiles: async () => ({ sha: 'c' }),
    openPullRequest: async () => ({ number: 1, url: 'u' }) as never,
  }
}

describe('readServiceSpec', () => {
  it('returns an empty (absent) view when no spec/service.json exists', async () => {
    const view = await readServiceSpec(fakeRepo({}), 'main')
    expect(view).toEqual({ present: false, spec: null, features: [] })
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

  it('never throws when a repo read fails — degrades to an empty view', async () => {
    const repo = fakeRepo({})
    repo.getFile = async () => {
      throw new Error('GitHub 502')
    }
    const view = await readServiceSpec(repo, 'main')
    expect(view).toEqual({ present: false, spec: null, features: [] })
  })
})
