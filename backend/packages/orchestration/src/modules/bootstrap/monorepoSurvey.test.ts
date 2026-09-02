import type { AdoptionSurvey, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeSurveyPath,
  parentDirectoryOf,
  surveyMonorepo,
  type MonorepoSurveyRequest,
  type SurveySide,
} from './monorepoSurvey.js'

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
  '.github/workflows/release.yml': 'name: release',
  'services/billing/package.json': '{"name":"@acme/billing"}',
  'services/billing/Dockerfile': 'FROM node:24',
  'services/billing/src/index.ts': 'export {}',
}

/** Every path the transcript holds as READ, which is exactly what a decision may cite. */
function citable(survey: AdoptionSurvey): string[] {
  return survey.reads.filter((read) => read.outcome === 'read').map((read) => read.path)
}

/** One transcript entry by key, so an assertion can name its outcome and origin. */
function entry(survey: AdoptionSurvey, path: string) {
  return survey.reads.find((read) => read.path === path)
}

const request = (overrides: Partial<MonorepoSurveyRequest> = {}): MonorepoSurveyRequest => ({
  monorepo: side(MONOREPO),
  directory: 'services/payments',
  ...overrides,
})

describe('parentDirectoryOf', () => {
  it('names where a new service’s siblings live, and the root for a top-level one', () => {
    expect(parentDirectoryOf('services/payments')).toBe('services')
    expect(parentDirectoryOf('a/b/c')).toBe('a/b')
    expect(parentDirectoryOf('payments')).toBe('')
  })
})

describe('normalizeSurveyPath', () => {
  it('accepts a repository path however the model spelled it', () => {
    expect(normalizeSurveyPath('  ./services/billing/ ')).toEqual({ path: 'services/billing' })
    expect(normalizeSurveyPath('/package.json')).toEqual({ path: 'package.json' })
    expect(normalizeSurveyPath('')).toEqual({ path: '' })
  })

  it('refuses magic rather than only traversal, and NAMES the refusal', () => {
    // The path becomes a URL segment on the contents API. A backslash or a control character
    // means the model is guessing at a shell or a Windows path, and answering "not found" would
    // tell it the repository lacks a file it never actually asked for.
    expect(normalizeSurveyPath('../../etc/passwd')).toMatchObject({
      refused: expect.stringContaining('leaves the repository'),
    })
    expect(normalizeSurveyPath('services\\billing')).toMatchObject({
      refused: expect.stringContaining('not part of a repository path'),
    })
    expect(normalizeSurveyPath(`services/${'a'.repeat(500)}`)).toMatchObject({
      refused: expect.stringContaining('too long'),
    })
  })
})

describe('the seeded opening context', () => {
  it('reads the root conventions and lists the CI directory rather than picking workflows', async () => {
    // Reading an arbitrary two workflows was the old shape's fourth gap: a monorepo with thirty
    // per-service pipelines contributed whichever two sorted first, and what a new directory is
    // actually REQUIRED to satisfy was likely in one of the twenty-eight nobody read. The listing
    // is the menu; the model spends a read on the one that matters.
    const session = await surveyMonorepo(request({ template: side({ 'jest.config.js': '{}' }) }))
    const survey = session.survey()
    expect(citable(survey)).toContain('monorepo:package.json')
    expect(citable(survey)).toContain('monorepo:.github/workflows/')
    expect(citable(survey)).not.toContain('monorepo:.github/workflows/ci.yml')
    expect(session.seedFiles()['monorepo:.github/workflows/']).toContain('ci.yml')
    expect(citable(survey)).toContain('template:jest.config.js')
  })

  it('offers EVERY qualifying sibling, so a monorepo that disagrees with itself can say so', async () => {
    // One sibling is a sample of size one. A six-year-old Java service beside three TypeScript
    // ones has no house convention, and naming whichever directory sorted first reports the
    // disagreement as though it were the answer.
    const session = await surveyMonorepo(
      request({
        monorepo: side({
          'package.json': '{}',
          'services/billing/package.json': '{}',
          'services/ledger/pom.xml': '<project/>',
          'services/assets/logo.svg': '<svg/>',
        }),
      }),
    )
    const survey = session.survey()
    // `assets` holds no convention file of its own, so it is not a worked example: a bad sibling
    // is worse than none, because "no sibling" is a fact the plan REPORTS.
    expect(survey.siblingServices).toEqual(['services/billing', 'services/ledger'])
    expect(citable(survey)).toContain('monorepo:services/billing/')
    expect(citable(survey)).toContain('monorepo:services/ledger/')
  })

  it('never reads the target directory itself as its own worked example', async () => {
    // The new service does not exist yet, but a retry surveying after a partial run must not
    // treat whatever it left behind as the monorepo's established convention.
    const session = await surveyMonorepo(
      request({ monorepo: side({ ...MONOREPO, 'services/payments/package.json': '{}' }) }),
    )
    expect(session.survey().siblingServices).toEqual(['services/billing'])
  })

  it('reports NO sibling rather than implying a root-only survey saw one', async () => {
    const session = await surveyMonorepo(
      request({ monorepo: side({ 'package.json': '{}' }), directory: 'apps/web' }),
    )
    expect(session.survey().siblingServices).toEqual([])
  })

  it('never names a dot-directory or a CI folder as a worked example', async () => {
    // `.` sorts below every letter, so the alphabetically first entry of a root listing is
    // `.changeset`/`.github` in any repository that keeps tooling there.
    const session = await surveyMonorepo(
      request({
        monorepo: side({
          'package.json': '{}',
          '.changeset/config.json': '{}',
          '.github/workflows/ci.yml': 'name: ci',
          'billing/package.json': '{"name":"billing"}',
        }),
        directory: 'payments',
      }),
    )
    expect(session.survey().siblingServices).toEqual(['billing'])
  })

  it('records each side’s SHAPE, which is the only evidence either offers about layout', async () => {
    // No root manifest states where a service puts its code, its tests or its entry point.
    // Without a citable listing a `source-layout` recommendation has nothing behind it and is
    // dropped upstream as invention, so `template` was the only answer for that area.
    const session = await surveyMonorepo(
      request({ template: side({ 'package.json': '{}', 'lib/main.ts': 'export {}' }) }),
    )
    const seeded = session.seedFiles()
    expect(seeded['monorepo:services/billing/']).toContain('src/')
    expect(seeded['template:./']).toContain('lib/')
  })

  it('separates a read that FAILED from a file that is simply absent', async () => {
    // Collapsing the two lets a survey blinded by an expired token present itself as a monorepo
    // with no conventions, which is the opposite conclusion.
    const session = await surveyMonorepo(request({ monorepo: side(MONOREPO, ['package.json']) }))
    const survey = session.survey()
    expect(entry(survey, 'monorepo:package.json')?.outcome).toBe('unreadable')
    expect(citable(survey)).not.toContain('monorepo:package.json')
    // A file that was never there contributes no entry at all.
    expect(entry(survey, 'monorepo:Cargo.toml')).toBeUndefined()
  })

  it('names a body that did not fit the reserved budget instead of dropping it silently', async () => {
    const session = await surveyMonorepo(
      request({
        monorepo: side({ 'package.json': 'x'.repeat(400), 'README.md': 'y'.repeat(400) }),
        limits: { maxSeedChars: 420, maxFileChars: 1_000 },
      }),
    )
    const survey = session.survey()
    const refused = survey.reads.filter((read) => read.outcome === 'refused')
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]?.note).toContain('ask for it if you need it')
  })

  it('reserves the budget PER SIDE, so a fat monorepo cannot crowd out the template', async () => {
    // Spent in key order it is not a bound but a handover to whichever side sorts first, and
    // `monorepo:` sorts before `template:` for every key.
    const session = await surveyMonorepo(
      request({
        monorepo: side({ 'package.json': 'x'.repeat(5_000), 'README.md': 'x'.repeat(5_000) }),
        template: side({ 'package.json': '{"name":"template"}' }),
        limits: { maxSeedChars: 6_000, maxFileChars: 6_000 },
      }),
    )
    expect(citable(session.survey())).toContain('template:package.json')
  })

  it('surveys the monorepo alone when the run has no reference template', async () => {
    const session = await surveyMonorepo(request())
    expect(session.sides).toEqual(['monorepo'])
    expect(Object.keys(session.seedFiles()).every((key) => key.startsWith('monorepo:'))).toBe(true)
  })

  it('probes a BOUNDED set, so the SEED’s cost does not scale with the monorepo', async () => {
    // The model's own budget is what bounds the rest; the opening context must not grow with the
    // repository, or a survey of ten thousand files costs a thousand times one of ten.
    const wide: Record<string, string> = { 'package.json': '{}' }
    for (let i = 0; i < 400; i++) wide[`noise-${i}.txt`] = 'x'
    const reader = files(wide)
    const getFile = vi.spyOn(reader, 'getFile')
    await surveyMonorepo({ monorepo: { files: reader }, directory: 'services/payments' })
    expect(getFile.mock.calls.every(([path]) => !String(path).startsWith('noise-'))).toBe(true)
    expect(getFile.mock.calls.length).toBeLessThan(20)
  })
})

describe('the model’s own reads', () => {
  it('records what it fetched as citable, and charges the exploration budget', async () => {
    const session = await surveyMonorepo(request())
    const answer = await session.explore({
      side: 'monorepo',
      kind: 'read',
      path: 'services/billing/Dockerfile',
    })
    expect(answer.outcome).toBe('read')
    expect(answer.key).toBe('monorepo:services/billing/Dockerfile')
    const survey = session.survey()
    expect(citable(survey)).toContain('monorepo:services/billing/Dockerfile')
    expect(entry(survey, 'monorepo:services/billing/Dockerfile')?.origin).toBe('model')
    expect(survey.exploration.calls).toBe(1)
    expect(survey.exploration.chars).toBe(MONOREPO['services/billing/Dockerfile'].length)
  })

  it('refuses past the call ceiling, STATES it to the model, and reports it on the survey', async () => {
    // Exhaustion has to reach the model, or the loop ends with a plan that reads as confident
    // about areas it never looked at.
    const session = await surveyMonorepo(request({ limits: { maxExplorationCalls: 1 } }))
    await session.explore({ side: 'monorepo', kind: 'read', path: 'services/billing/Dockerfile' })
    const refused = await session.explore({
      side: 'monorepo',
      kind: 'read',
      path: 'services/billing/src/index.ts',
    })
    expect(refused.outcome).toBe('refused')
    expect(refused.note).toContain('exploration budget is spent')
    const survey = session.survey()
    expect(survey.exploration.exhausted).toBe('calls')
    expect(survey.exploration.calls).toBe(2)
    expect(citable(survey)).not.toContain('monorepo:services/billing/src/index.ts')
  })

  it('refuses past the content ceiling as its own exhaustion, not as a missing file', async () => {
    const session = await surveyMonorepo(request({ limits: { maxExplorationChars: 5 } }))
    const refused = await session.explore({
      side: 'monorepo',
      kind: 'read',
      path: 'services/billing/Dockerfile',
    })
    expect(refused.outcome).toBe('refused')
    expect(session.survey().exploration.exhausted).toBe('chars')
  })

  it('counts a refused call, so nonsense paths cannot buy an unbounded loop', async () => {
    const session = await surveyMonorepo(request({ limits: { maxExplorationCalls: 2 } }))
    await session.explore({ side: 'monorepo', kind: 'read', path: '../../etc/passwd' })
    await session.explore({ side: 'monorepo', kind: 'read', path: '..\\..\\secrets' })
    const third = await session.explore({ side: 'monorepo', kind: 'read', path: 'package.json' })
    expect(third.outcome).toBe('refused')
    expect(session.survey().exploration.exhausted).toBe('calls')
  })

  it('refuses to read the service being created back as an existing convention', async () => {
    // A retry surveys after a partial run, so the target directory can hold the previous
    // attempt's draft. Citing it would be the platform quoting itself to itself.
    const session = await surveyMonorepo(
      request({ monorepo: side({ ...MONOREPO, 'services/payments/package.json': '{}' }) }),
    )
    const answer = await session.explore({
      side: 'monorepo',
      kind: 'read',
      path: 'services/payments/package.json',
    })
    expect(answer.outcome).toBe('refused')
    expect(answer.note).toContain('the service being created')
  })

  it('refuses a side this run has no repository for', async () => {
    const session = await surveyMonorepo(request())
    const answer = await session.explore({ side: 'template', kind: 'read', path: 'package.json' })
    expect(answer.outcome).toBe('refused')
    expect(answer.note).toContain('no template repository')
  })

  it('distinguishes an absent file from a failed read, and neither is citable', async () => {
    const session = await surveyMonorepo(request({ monorepo: side(MONOREPO, ['Cargo.toml']) }))
    const absent = await session.explore({ side: 'monorepo', kind: 'read', path: 'nope.json' })
    expect(absent).toMatchObject({ outcome: 'absent', key: null })
    const failed = await session.explore({ side: 'monorepo', kind: 'read', path: 'Cargo.toml' })
    expect(failed.outcome).toBe('unreadable')
    expect(failed.note).toContain('UNKNOWN')
    expect(citable(session.survey())).not.toContain('monorepo:Cargo.toml')
  })

  it('answers a re-read from the transcript rather than spending the budget twice', async () => {
    // The seed already paid for `package.json`; a model that asks for it again is not owed a
    // second read out of a bounded budget, and refusing it would teach the model the file went
    // away.
    const session = await surveyMonorepo(request())
    const answer = await session.explore({ side: 'monorepo', kind: 'read', path: 'package.json' })
    expect(answer.outcome).toBe('read')
    expect(session.survey().exploration.chars).toBe(0)
  })

  it('scrubs secrets at READ time, on the model’s own reads as much as the seed’s', async () => {
    // The exploration half has no compose step a caller could scrub at, which is exactly how a
    // credential would reach a model through the new path while the old one stayed clean.
    const session = await surveyMonorepo(
      request({
        monorepo: side({
          'package.json': '{}',
          'deploy/env.md': 'token: ghp_abcdefghijklmnopqrstuvwxyz012345',
        }),
      }),
    )
    const answer = await session.explore({ side: 'monorepo', kind: 'read', path: 'deploy/env.md' })
    expect(answer.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(answer.body).toContain('[REDACTED]')
  })

  it('records a side the platform could never reach, so it does not read as an absence', async () => {
    const session = await surveyMonorepo(request())
    session.noteUnavailable('template', 'acme/service-template', 'not linked to this workspace')
    const read = entry(session.survey(), 'template:acme/service-template')
    expect(read?.outcome).toBe('unreadable')
    expect(read?.note).toContain('not linked')
  })
})
