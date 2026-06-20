import { describe, expect, it } from 'vitest'
import { parseRequirementsJob } from '../src/job.js'
import {
  type RequirementsDocTree,
  coerceRequirementsDoc,
  extractJsonObject,
  hashRequirements,
  nextRequirementsVersion,
  renderFeatureFiles,
  renderRequirementsFiles,
  renderVersionFile,
} from '../src/requirements.js'

const validBody = {
  jobId: 'rq_123',
  systemPrompt: 'You are a requirements analyst.',
  instructions: 'Write the requirements.',
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
  branch: 'cat-factory/blk_1',
  tasks: [
    { id: 'blk_1', title: 'Login', description: 'Users can log in.' },
    { id: 'blk_2', title: '', description: '' },
  ],
}

describe('parseRequirementsJob', () => {
  it('accepts a well-formed body and drops empty tasks', () => {
    const job = parseRequirementsJob(validBody)
    expect(job.repo.owner).toBe('acme')
    expect(job.branch).toBe('cat-factory/blk_1')
    // The second task (no title/description) is dropped.
    expect(job.tasks).toHaveLength(1)
    expect(job.tasks[0]?.title).toBe('Login')
  })

  it('tolerates a missing/!array tasks field', () => {
    const { tasks: _t, ...rest } = validBody
    expect(parseRequirementsJob(rest).tasks).toEqual([])
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseRequirementsJob({
        ...validBody,
        repo: { ...validBody.repo, cloneUrl: 'https://evil.example/acme/widgets.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing branch', () => {
    const { branch: _b, ...rest } = validBody
    expect(() => parseRequirementsJob(rest)).toThrow(/branch/)
  })
})

describe('coerceRequirementsDoc', () => {
  it('drops malformed requirements and falls back to the repo name', () => {
    const doc = coerceRequirementsDoc(
      {
        groups: [
          {
            name: 'Login',
            requirements: [
              { title: 'Sign in', statement: 'The system SHALL sign in.' },
              { nope: true },
            ],
          },
        ],
      },
      'widgets',
    )
    expect(doc?.service).toBe('widgets')
    expect(doc?.groups).toHaveLength(1)
    expect(doc?.groups[0]?.requirements).toHaveLength(1)
    // Unknown priority/kind default sensibly.
    expect(doc?.groups[0]?.requirements[0]?.priority).toBe('should')
    expect(doc?.groups[0]?.requirements[0]?.kind).toBe('functional')
  })

  it('unwraps a { requirements: {...} } envelope', () => {
    expect(coerceRequirementsDoc({ requirements: { service: 'API' } }, 'fallback')?.service).toBe(
      'API',
    )
  })

  it('drops acceptance criteria with no Then clause', () => {
    const doc = coerceRequirementsDoc(
      {
        service: 'X',
        groups: [
          {
            name: 'G',
            requirements: [
              {
                title: 'R',
                statement: 'The system SHALL do X.',
                acceptance: [
                  { given: 'a', when: 'b', outcome: 'c' },
                  { given: 'a', when: 'b' },
                ],
              },
            ],
          },
        ],
      },
      'fallback',
    )
    expect(doc?.groups[0]?.requirements[0]?.acceptance).toHaveLength(1)
  })

  it('returns null when there is no usable service name', () => {
    expect(coerceRequirementsDoc({ groups: [] }, '')).toBeNull()
  })
})

describe('extractJsonObject', () => {
  it('parses a bare object, strips fences and recovers from prose', () => {
    expect(extractJsonObject('{"service":"x"}')).toEqual({ service: 'x' })
    expect(extractJsonObject('```json\n{"service":"x"}\n```')).toEqual({ service: 'x' })
    expect(extractJsonObject('Here: {"service":"x"} done')).toEqual({ service: 'x' })
  })
})

const sampleDoc: RequirementsDocTree = {
  service: 'Widgets',
  summary: 'Manages widgets.',
  groups: [
    {
      name: 'Authentication',
      summary: 'Sign-in flows.',
      requirements: [
        {
          id: 'req-login',
          title: 'Login',
          statement: 'The system SHALL let a user log in.',
          kind: 'functional',
          priority: 'must',
          sourceBlockIds: ['blk_1'],
          acceptance: [
            {
              id: 'ac-1',
              given: 'a registered user',
              when: 'they sign in',
              outcome: 'a session starts',
            },
          ],
        },
      ],
    },
  ],
  rules: [
    {
      id: 'rule-1',
      rule: 'A session SHALL expire after 24h.',
      rationale: 'Security.',
      sourceBlockIds: [],
    },
  ],
}

describe('renderRequirementsFiles', () => {
  it('renders the canonical JSON, an overview, and a rules file', () => {
    const byPath = Object.fromEntries(
      renderRequirementsFiles(sampleDoc).map((f) => [f.path, f.content]),
    )
    expect(JSON.parse(byPath['requirements/requirements.json']!)).toEqual(sampleDoc)

    const overview = byPath['requirements/overview.md']!
    expect(overview).toContain('# Widgets — Requirements')
    expect(overview).toContain('Login')
    expect(overview).toContain('_(must, functional)_')

    const rules = byPath['requirements/rules.md']!
    expect(rules).toContain('A session SHALL expire after 24h.')
  })

  it('is deterministic (same doc → same bytes)', () => {
    expect(renderRequirementsFiles(sampleDoc)).toEqual(renderRequirementsFiles(sampleDoc))
  })
})

describe('renderFeatureFiles', () => {
  it('renders one .feature per group with a tagged scenario per criterion', () => {
    const files = renderFeatureFiles(sampleDoc)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('requirements/features/authentication.feature')
    const content = files[0]!.content
    expect(content).toContain('Feature: Authentication')
    expect(content).toContain('@must')
    expect(content).toContain('Scenario: Login')
    expect(content).toContain('Given a registered user')
    expect(content).toContain('When they sign in')
    expect(content).toContain('Then a session starts')
  })

  it('omits groups with no acceptance criteria', () => {
    const doc: RequirementsDocTree = {
      service: 'X',
      summary: '',
      groups: [{ name: 'Empty', summary: '', requirements: [] }],
      rules: [],
    }
    expect(renderFeatureFiles(doc)).toHaveLength(0)
  })
})

describe('version manifest', () => {
  const now = new Date('2026-06-20T00:00:00.000Z')

  it('starts at version 1 with no prior manifest', () => {
    expect(nextRequirementsVersion(sampleDoc, null, now)).toEqual({
      version: 1,
      generatedAt: now.toISOString(),
    })
  })

  it('keeps the version + timestamp when the content is unchanged', () => {
    const prior = {
      version: 4,
      generatedAt: '2020-01-01T00:00:00.000Z',
      hash: hashRequirements(sampleDoc),
      requirements: 1,
      rules: 1,
    }
    expect(nextRequirementsVersion(sampleDoc, prior, now)).toEqual({
      version: 4,
      generatedAt: '2020-01-01T00:00:00.000Z',
    })
  })

  it('renders a lightweight manifest with the content hash and counts', () => {
    const file = renderVersionFile(sampleDoc, { version: 2, generatedAt: now.toISOString() })
    expect(file.path).toBe('requirements/version.json')
    expect(JSON.parse(file.content)).toEqual({
      version: 2,
      generatedAt: now.toISOString(),
      hash: hashRequirements(sampleDoc),
      requirements: 1,
      rules: 1,
    })
  })
})
