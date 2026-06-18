import { describe, expect, it } from 'vitest'
import { parseBlueprintJob } from '../src/job.js'
import {
  type BlueprintServiceTree,
  coerceService,
  extractJsonObject,
  hashBlueprint,
  moduleSlug,
  nextVersion,
  renderBlueprintFiles,
  renderVersionFile,
} from '../src/blueprint.js'

const validBlueprintBody = {
  jobId: 'bp_123',
  systemPrompt: 'You are a software architect.',
  instructions: 'Map the repository.',
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
  mode: 'create',
}

describe('parseBlueprintJob', () => {
  it('accepts a well-formed body and defaults an unknown mode to create', () => {
    const job = parseBlueprintJob({ ...validBlueprintBody, mode: 'nonsense' })
    expect(job.repo.owner).toBe('acme')
    expect(job.branch).toBe('main')
    expect(job.mode).toBe('create')
  })

  it('preserves an explicit update mode', () => {
    expect(parseBlueprintJob({ ...validBlueprintBody, mode: 'update' }).mode).toBe('update')
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseBlueprintJob({
        ...validBlueprintBody,
        repo: { ...validBlueprintBody.repo, cloneUrl: 'https://evil.example/acme/widgets.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing branch', () => {
    const { branch: _branch, ...rest } = validBlueprintBody
    expect(() => parseBlueprintJob(rest)).toThrow(/branch/)
  })
})

describe('coerceService', () => {
  it('drops malformed nodes and falls back to the repo name', () => {
    const service = coerceService(
      {
        modules: [{ name: 'Auth', summary: 'Auth.' }, { nope: true }],
      },
      'widgets',
    )
    expect(service?.name).toBe('widgets')
    expect(service?.type).toBe('service')
    expect(service?.modules).toHaveLength(1)
    expect(service?.modules[0]?.name).toBe('Auth')
  })

  it('unwraps a { service: {...} } envelope', () => {
    expect(coerceService({ service: { name: 'API', type: 'api' } }, 'fallback')?.name).toBe('API')
  })

  it('returns null when there is no usable name', () => {
    expect(coerceService({ modules: [] }, '')).toBeNull()
  })
})

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"name":"x"}')).toEqual({ name: 'x' })
  })
  it('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"name":"x"}\n```')).toEqual({ name: 'x' })
  })
  it('recovers the first balanced object from surrounding prose', () => {
    expect(extractJsonObject('Here it is: {"name":"x"} done.')).toEqual({ name: 'x' })
  })
  it('throws when there is no object', () => {
    expect(() => extractJsonObject('no json here')).toThrow()
  })
})

describe('moduleSlug', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(moduleSlug('Auth & Billing')).toBe('auth-billing')
  })
  it('falls back when empty', () => {
    expect(moduleSlug('!!!')).toBe('module')
  })
})

const sampleService: BlueprintServiceTree = {
  type: 'service',
  name: 'Widgets',
  summary: 'Manages widgets.',
  references: ['package.json'],
  modules: [
    {
      name: 'Auth',
      summary: 'Authentication.',
      references: ['src/auth/login.ts'],
    },
  ],
}

describe('renderBlueprintFiles', () => {
  it('renders the canonical JSON, an overview, and one deep-dive per module', () => {
    const files = renderBlueprintFiles(sampleService)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]))

    expect(byPath['blueprints/blueprint.json']).toBeDefined()
    expect(JSON.parse(byPath['blueprints/blueprint.json']!)).toEqual(sampleService)

    const overview = byPath['blueprints/overview.md']!
    expect(overview).toContain('# Widgets')
    expect(overview).toContain('[Auth](modules/auth.md)')

    const moduleDoc = byPath['blueprints/modules/auth.md']!
    expect(moduleDoc).toContain('# Auth')
    expect(moduleDoc).toContain('Authentication.')
    expect(moduleDoc).toContain('`src/auth/login.ts`')
  })

  it('is deterministic (same tree → same bytes)', () => {
    expect(renderBlueprintFiles(sampleService)).toEqual(renderBlueprintFiles(sampleService))
  })
})

describe('version manifest', () => {
  const now = new Date('2026-06-17T00:00:00.000Z')

  it('starts at version 1 with no prior manifest', () => {
    expect(nextVersion(sampleService, null, now)).toEqual({
      version: 1,
      generatedAt: now.toISOString(),
    })
  })

  it('keeps the version + timestamp when the content is unchanged', () => {
    const prior = {
      version: 4,
      generatedAt: '2020-01-01T00:00:00.000Z',
      hash: hashBlueprint(sampleService),
      modules: 1,
    }
    expect(nextVersion(sampleService, prior, now)).toEqual({
      version: 4,
      generatedAt: '2020-01-01T00:00:00.000Z',
    })
  })

  it('bumps the version + refreshes the timestamp when the content changes', () => {
    const prior = {
      version: 4,
      generatedAt: '2020-01-01T00:00:00.000Z',
      hash: 'stale',
      modules: 0,
    }
    expect(nextVersion(sampleService, prior, now)).toEqual({
      version: 5,
      generatedAt: now.toISOString(),
    })
  })

  it('renders a lightweight manifest with the content hash and counts', () => {
    const file = renderVersionFile(sampleService, { version: 2, generatedAt: now.toISOString() })
    expect(file.path).toBe('blueprints/version.json')
    const manifest = JSON.parse(file.content)
    expect(manifest).toEqual({
      version: 2,
      generatedAt: now.toISOString(),
      hash: hashBlueprint(sampleService),
      modules: 1,
    })
  })
})
