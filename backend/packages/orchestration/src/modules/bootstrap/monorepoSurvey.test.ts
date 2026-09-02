import type { RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { parentDirectoryOf, surveyMonorepo, type SurveySide } from './monorepoSurvey.js'

/** A `RepoFiles` over a fixed map; a path listed in `failing` throws instead of answering. */
function files(map: Record<string, string>, failing: string[] = []): RepoFiles {
  const fail = new Set(failing)
  return {
    async getFile(path: string) {
      if (fail.has(path)) throw new Error(`read failed: ${path}`)
      const content = map[path]
      return content === undefined ? null : { content, sha: `sha-${path}` }
    },
    async listDirectory(path: string) {
      if (fail.has(path || '.')) throw new Error(`list failed: ${path}`)
      const prefix = path ? `${path}/` : ''
      const names = new Set<string>()
      for (const key of Object.keys(map)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      return [...names].map((name) => ({
        path: `${prefix}${name}`,
        name,
        type: map[`${prefix}${name}`] === undefined ? 'dir' : 'file',
        sha: `sha-${prefix}${name}`,
      }))
    },
  } as unknown as RepoFiles
}

const side = (map: Record<string, string>, failing: string[] = []): SurveySide => ({
  files: files(map, failing),
})

const MONOREPO = {
  'package.json': '{"workspaces":["services/*"]}',
  'vitest.config.ts': 'export default {}',
  '.github/workflows/ci.yml': 'name: ci',
  'services/billing/package.json': '{"name":"@acme/billing"}',
  'services/billing/Dockerfile': 'FROM node:24',
}

describe('parentDirectoryOf', () => {
  it('names where a new service’s siblings live, and the root for a top-level one', () => {
    expect(parentDirectoryOf('services/payments')).toBe('services')
    expect(parentDirectoryOf('a/b/c')).toBe('a/b')
    expect(parentDirectoryOf('payments')).toBe('')
  })
})

describe('surveyMonorepo', () => {
  it('reads the root conventions, the CI, and the nearest EXISTING sibling service', () => {
    // The sibling is the read that matters most and the one no root file can stand in for: it is
    // what a service in this repository actually looks like.
    return surveyMonorepo({
      monorepo: side(MONOREPO),
      template: side({ 'package.json': '{}', 'jest.config.js': '{}' }),
      directory: 'services/payments',
    }).then(({ survey, files: read }) => {
      expect(survey.siblingService).toBe('services/billing')
      expect(survey.monorepoPaths).toContain('package.json')
      expect(survey.monorepoPaths).toContain('.github/workflows/ci.yml')
      expect(survey.monorepoPaths).toContain('services/billing/package.json')
      expect(survey.monorepoPaths).toContain('services/billing/Dockerfile')
      expect(survey.templatePaths).toContain('jest.config.js')
      // The read contents are keyed by the SAME prefixed path a decision's evidence cites, which
      // is what lets an unevidenced claim be dropped without knowing which side a path came from.
      expect(read['monorepo:package.json']).toBe(MONOREPO['package.json'])
      expect(read['template:jest.config.js']).toBe('{}')
      expect(survey.unreadablePaths).toEqual([])
    })
  })

  it('never reads the target directory itself as its own worked example', async () => {
    // The new service does not exist yet, but a retry surveying after a partial run must not
    // treat whatever it left behind as the monorepo's established convention.
    const { survey } = await surveyMonorepo({
      monorepo: side({ ...MONOREPO, 'services/payments/package.json': '{}' }),
      directory: 'services/payments',
    })
    expect(survey.siblingService).toBe('services/billing')
    expect(survey.monorepoPaths).not.toContain('services/payments/package.json')
  })

  it('reports NO sibling rather than implying a root-only survey saw one', async () => {
    const { survey } = await surveyMonorepo({
      monorepo: side({ 'package.json': '{}' }),
      directory: 'apps/web',
    })
    // A plan built from root conventions alone is materially weaker, and only this says which.
    expect(survey.siblingService).toBeNull()
  })

  it('never names a dot-directory or a CI folder as the monorepo’s worked example', async () => {
    // `.` sorts below every letter, so the alphabetically first entry of a root listing is
    // `.changeset`/`.github` in any repository that keeps tooling there. Naming one as the
    // sibling told the reviewer that a workflows folder is "the best available statement of what
    // a service in this monorepo looks like", and the model then cited CI config as a service's
    // conventions.
    const { survey } = await surveyMonorepo({
      monorepo: side({
        'package.json': '{}',
        '.changeset/config.json': '{}',
        '.github/workflows/ci.yml': 'name: ci',
        'billing/package.json': '{"name":"billing"}',
      }),
      directory: 'payments',
    })
    expect(survey.siblingService).toBe('billing')
  })

  it('skips a candidate that holds no convention file of its own', async () => {
    // A directory that says nothing about how a service here is built is worse than no example,
    // because "no sibling" is a fact the plan REPORTS while a bad sibling is one it asserts.
    const { survey } = await surveyMonorepo({
      monorepo: side({
        'package.json': '{}',
        'services/assets/logo.svg': '<svg/>',
        'services/billing/package.json': '{"name":"@acme/billing"}',
      }),
      directory: 'services/payments',
    })
    expect(survey.siblingService).toBe('services/billing')
  })

  it('records each side’s SHAPE, which is the only evidence either offers about layout', async () => {
    // No root manifest states where a service puts its code, its tests or its entry point, and
    // the sibling's own config files do not either. Without a citable listing, a `source-layout`
    // recommendation has nothing behind it and is dropped upstream as invention, so the model
    // could only ever answer `template` for one of the twelve areas it is asked about.
    const { survey, files: read } = await surveyMonorepo({
      monorepo: side({
        'package.json': '{}',
        'services/billing/package.json': '{}',
        'services/billing/src/index.ts': 'export {}',
        'services/billing/test/index.test.ts': 'export {}',
      }),
      template: side({ 'package.json': '{}', 'lib/main.ts': 'export {}' }),
      directory: 'services/payments',
    })
    expect(survey.monorepoPaths).toContain('services/billing/')
    expect(read['monorepo:services/billing/']).toContain('src/')
    expect(read['monorepo:services/billing/']).toContain('test/')
    // Both sides, or the one that has any evidence wins the area by default.
    expect(survey.templatePaths).toContain('./')
    expect(read['template:./']).toContain('lib/')
  })

  it('separates a read that FAILED from a file that is simply absent', async () => {
    // Collapsing the two lets a survey blinded by an expired token present itself as a monorepo
    // with no conventions, which is the opposite conclusion.
    const { survey } = await surveyMonorepo({
      monorepo: side(MONOREPO, ['package.json']),
      directory: 'services/payments',
    })
    expect(survey.unreadablePaths).toContain('monorepo:package.json')
    expect(survey.monorepoPaths).not.toContain('package.json')
    // A file that was never there contributes to neither list.
    expect(survey.unreadablePaths).not.toContain('monorepo:Cargo.toml')
  })

  it('surveys the monorepo alone when the run has no reference template', async () => {
    const { survey, files: read } = await surveyMonorepo({
      monorepo: side(MONOREPO),
      directory: 'services/payments',
    })
    expect(survey.templatePaths).toEqual([])
    expect(Object.keys(read).every((key) => key.startsWith('monorepo:'))).toBe(true)
  })

  it('probes a BOUNDED, declared set, so its cost does not scale with the monorepo', async () => {
    // No crawl and no recursive walk: a survey of a repository with ten thousand files must cost
    // the same as one of a repository with ten.
    const wide: Record<string, string> = { 'package.json': '{}' }
    for (let i = 0; i < 400; i++) wide[`noise-${i}.txt`] = 'x'
    const reader = files(wide)
    const getFile = vi.spyOn(reader, 'getFile')
    await surveyMonorepo({ monorepo: { files: reader }, directory: 'services/payments' })
    // Only files on the convention list are fetched; the 400 unlisted ones are never read.
    expect(getFile.mock.calls.every(([path]) => !String(path).startsWith('noise-'))).toBe(true)
    expect(getFile.mock.calls.length).toBeLessThan(20)
  })
})
