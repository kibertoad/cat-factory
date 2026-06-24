import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSpecJob } from '../src/job.js'
import {
  type SpecDocTree,
  coerceSpecDoc,
  extractJsonObject,
  readExistingSpec,
  renderFeatureFiles,
  renderSpecFiles,
  writeRequirementsFiles,
} from '../src/spec.js'

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
  task: { id: 'blk_1', title: 'Login', description: 'Users can log in.' },
}

describe('parseSpecJob', () => {
  it('accepts a well-formed body and narrows the task', () => {
    const job = parseSpecJob(validBody)
    expect(job.repo.owner).toBe('acme')
    expect(job.branch).toBe('cat-factory/blk_1')
    expect(job.task.id).toBe('blk_1')
    expect(job.task.title).toBe('Login')
    expect(job.task.description).toBe('Users can log in.')
  })

  it('tolerates a missing/malformed task field with empty sub-fields', () => {
    const { task: _t, ...rest } = validBody
    expect(parseSpecJob(rest).task).toEqual({ id: '', title: '', description: '' })
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseSpecJob({
        ...validBody,
        repo: { ...validBody.repo, cloneUrl: 'https://evil.example/acme/widgets.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing branch', () => {
    const { branch: _b, ...rest } = validBody
    expect(() => parseSpecJob(rest)).toThrow(/branch/)
  })
})

describe('coerceSpecDoc', () => {
  it('drops malformed requirements and falls back to the repo name', () => {
    const doc = coerceSpecDoc(
      {
        modules: [
          {
            name: 'Access',
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
        ],
      },
      'widgets',
    )
    expect(doc?.service).toBe('widgets')
    const group = doc?.modules[0]?.groups[0]
    expect(doc?.modules).toHaveLength(1)
    expect(group?.requirements).toHaveLength(1)
    // Unknown priority/kind default sensibly.
    expect(group?.requirements[0]?.priority).toBe('should')
    expect(group?.requirements[0]?.kind).toBe('functional')
  })

  it('unwraps a { requirements: {...} } envelope', () => {
    expect(coerceSpecDoc({ requirements: { service: 'API' } }, 'fallback')?.service).toBe('API')
  })

  it('wraps stray top-level groups into one module (lenient safety net)', () => {
    const doc = coerceSpecDoc(
      {
        service: 'API',
        groups: [{ name: 'Login', requirements: [{ title: 'X', statement: 'SHALL X.' }] }],
      },
      'fallback',
    )
    expect(doc?.modules).toHaveLength(1)
    expect(doc?.modules[0]?.name).toBe('API')
    expect(doc?.modules[0]?.groups[0]?.name).toBe('Login')
  })

  it('assigns cross-group id-collision suffixes by name-sorted order, not the agent emit order', () => {
    // Two modules each carry a requirement whose fallback id slugs to `req-create`. The
    // `-2` suffix must always land on the same (name-sorted-second) module so a
    // reordered-but-identical doc renders byte-identical shards — otherwise the suffix
    // would flip between branches and reintroduce merge churn.
    const make = (first: string, second: string) => ({
      service: 'X',
      modules: [
        { name: first, groups: [{ name: 'G', requirements: [{ title: 'Create', statement: 'SHALL create.' }] }] },
        { name: second, groups: [{ name: 'G', requirements: [{ title: 'Create', statement: 'SHALL create.' }] }] },
      ],
    })
    const idFor = (doc: SpecDocTree | null, moduleName: string) =>
      doc?.modules.find((m) => m.name === moduleName)?.groups[0]?.requirements[0]?.id
    const ab = coerceSpecDoc(make('Alpha', 'Beta'), 'X')
    const ba = coerceSpecDoc(make('Beta', 'Alpha'), 'X')
    // Alpha sorts first → keeps the bare id in BOTH emit orders; Beta always gets `-2`.
    expect(idFor(ab, 'Alpha')).toBe('req-create')
    expect(idFor(ab, 'Beta')).toBe('req-create-2')
    expect(idFor(ba, 'Alpha')).toBe('req-create')
    expect(idFor(ba, 'Beta')).toBe('req-create-2')
  })

  it('rescues stray top-level groups even when a non-empty modules array is all malformed', () => {
    // A model returns BOTH a junk `modules` (no usable names → coerces to nothing) AND the
    // real work under flat top-level `groups`. The safety net keys on the COERCED result,
    // so the groups are still rescued rather than silently dropped.
    const doc = coerceSpecDoc(
      {
        service: 'API',
        modules: [{ summary: 'no name, dropped' }],
        groups: [{ name: 'Login', requirements: [{ title: 'X', statement: 'SHALL X.' }] }],
      },
      'fallback',
    )
    expect(doc?.modules).toHaveLength(1)
    expect(doc?.modules[0]?.name).toBe('API')
    expect(doc?.modules[0]?.groups[0]?.name).toBe('Login')
  })

  it('drops acceptance criteria with no Then clause', () => {
    const doc = coerceSpecDoc(
      {
        service: 'X',
        modules: [
          {
            name: 'M',
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
        ],
      },
      'fallback',
    )
    expect(doc?.modules[0]?.groups[0]?.requirements[0]?.acceptance).toHaveLength(1)
  })

  it('returns null when there is no usable service name', () => {
    expect(coerceSpecDoc({ modules: [] }, '')).toBeNull()
  })

  it('assigns deterministic acceptance ids derived from the requirement (no global counter leak)', () => {
    const input = {
      service: 'X',
      modules: [
        {
          name: 'M',
          groups: [
            {
              name: 'G',
              requirements: [
                {
                  id: 'req-a',
                  title: 'A',
                  statement: 'The system SHALL A.',
                  // No acceptance ids supplied → the harness derives them.
                  acceptance: [
                    { given: 'g', when: 'w', outcome: 'o1' },
                    { given: 'g', when: 'w', outcome: 'o2' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const first = coerceSpecDoc(input, 'X')!
    expect(first.modules[0]?.groups[0]?.requirements[0]?.acceptance.map((a) => a.id)).toEqual([
      'req-a-ac-1',
      'req-a-ac-2',
    ])
    // Coercing again yields the SAME ids — no module-global counter carrying state across calls.
    const second = coerceSpecDoc(input, 'X')!
    expect(second).toEqual(first)
  })

  it('de-duplicates colliding requirement / rule ids and derives stable rule ids from text', () => {
    const doc = coerceSpecDoc(
      {
        service: 'X',
        modules: [
          {
            name: 'M',
            groups: [
              {
                name: 'G',
                requirements: [
                  { id: 'req-dup', title: 'A', statement: 'SHALL A.' },
                  { id: 'req-dup', title: 'B', statement: 'SHALL B.' },
                ],
                // No rule ids → derived from the rule text (NOT positional), so reordering
                // a group's rules never churns the file.
                rules: [{ rule: 'Names are unique.' }, { rule: 'Totals never negative.' }],
              },
            ],
          },
        ],
      },
      'X',
    )!
    const group = doc.modules[0]!.groups[0]!
    expect(group.requirements.map((r) => r.id)).toEqual(['req-dup', 'req-dup-2'])
    expect(group.rules.map((r) => r.id)).toEqual([
      'rule-names-are-unique',
      'rule-totals-never-negative',
    ])
  })
})

describe('extractJsonObject', () => {
  it('parses a bare object, strips fences and recovers from prose', () => {
    expect(extractJsonObject('{"service":"x"}')).toEqual({ service: 'x' })
    expect(extractJsonObject('```json\n{"service":"x"}\n```')).toEqual({ service: 'x' })
    expect(extractJsonObject('Here: {"service":"x"} done')).toEqual({ service: 'x' })
  })
})

const sampleDoc: SpecDocTree = {
  service: 'Widgets',
  summary: 'Manages widgets.',
  modules: [
    {
      name: 'Access',
      summary: 'User access.',
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
          rules: [
            {
              id: 'rule-session-expiry',
              rule: 'A session SHALL expire after 24h.',
              rationale: 'Security.',
              sourceBlockIds: [],
            },
          ],
        },
      ],
    },
  ],
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('renderSpecFiles', () => {
  it('shards into service.json, an overview index, and per-group module files', () => {
    const byPath = Object.fromEntries(renderSpecFiles(sampleDoc).map((f) => [f.path, f.content]))

    // The service metadata is tiny and content-only (no requirements inline).
    expect(JSON.parse(byPath['spec/service.json']!)).toEqual({
      service: 'Widgets',
      summary: 'Manages widgets.',
    })

    // The overview is an INDEX (names + links), not the requirement bodies.
    const overview = byPath['spec/overview.md']!
    expect(overview).toContain('# Widgets — Specification')
    expect(overview).toContain('## Access')
    expect(overview).toContain('[Authentication](modules/access/authentication.md)')
    expect(overview).not.toContain('The system SHALL let a user log in.')

    // Per-module metadata file.
    expect(JSON.parse(byPath['spec/modules/access/_module.json']!)).toEqual({
      name: 'Access',
      summary: 'User access.',
    })

    // The canonical per-group shard is exactly that group's content.
    const group = sampleDoc.modules[0]!.groups[0]!
    expect(JSON.parse(byPath['spec/modules/access/authentication.json']!)).toEqual(group)

    // The human render of the group carries its requirements AND its scoped rules.
    const md = byPath['spec/modules/access/authentication.md']!
    expect(md).toContain('# Access — Authentication')
    expect(md).toContain('The system SHALL let a user log in.')
    expect(md).toContain('A session SHALL expire after 24h.')
  })

  it('is deterministic (same doc → same bytes)', () => {
    expect(renderSpecFiles(sampleDoc)).toEqual(renderSpecFiles(sampleDoc))
  })

  it("a group's shard bytes depend only on that group (other groups do not affect it)", () => {
    const twoGroups: SpecDocTree = {
      ...sampleDoc,
      modules: [
        {
          ...sampleDoc.modules[0]!,
          groups: [
            sampleDoc.modules[0]!.groups[0]!,
            { name: 'Logout', summary: 'Sign-out.', requirements: [], rules: [] },
          ],
        },
      ],
    }
    const a = Object.fromEntries(renderSpecFiles(sampleDoc).map((f) => [f.path, f.content]))
    const b = Object.fromEntries(renderSpecFiles(twoGroups).map((f) => [f.path, f.content]))
    // Adding a sibling feature must NOT change the existing feature's shard bytes.
    expect(b['spec/modules/access/authentication.json']).toBe(
      a['spec/modules/access/authentication.json'],
    )
  })
})

describe('renderFeatureFiles', () => {
  it('renders one nested .feature per group with a tagged scenario per criterion', () => {
    const files = renderFeatureFiles(sampleDoc)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('spec/features/access/authentication.feature')
    const content = files[0]!.content
    expect(content).toContain('Feature: Access — Authentication')
    expect(content).toContain('@must')
    expect(content).toContain('Scenario: Login')
    expect(content).toContain('Given a registered user')
    expect(content).toContain('When they sign in')
    expect(content).toContain('Then a session starts')
  })

  it('omits groups with no acceptance criteria', () => {
    const doc: SpecDocTree = {
      service: 'X',
      summary: '',
      modules: [
        {
          name: 'M',
          summary: '',
          groups: [{ name: 'Empty', summary: '', requirements: [], rules: [] }],
        },
      ],
    }
    expect(renderFeatureFiles(doc)).toHaveLength(0)
  })
})

describe('writeRequirementsFiles', () => {
  it('reassembles the sharded spec from disk (round-trip)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-roundtrip-'))
    try {
      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(sampleDoc),
        ...renderFeatureFiles(sampleDoc),
      ])
      const back = await readExistingSpec(dir, 'fallback')
      expect(back).toEqual(sampleDoc)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prunes pre-sharding monolithic artifacts and old flat feature files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-legacy-'))
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      // Simulate a repo created before sharding: a monolithic spec + a flat feature file.
      await mkdir(join(dir, 'spec/features'), { recursive: true })
      await writeFile(join(dir, 'spec/spec.json'), '{"service":"old"}\n', 'utf8')
      await writeFile(join(dir, 'spec/rules.md'), '# old rules\n', 'utf8')
      await writeFile(join(dir, 'spec/version.json'), '{"version":7}\n', 'utf8')
      await writeFile(join(dir, 'spec/features/login.feature'), 'Feature: old\n', 'utf8')

      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(sampleDoc),
        ...renderFeatureFiles(sampleDoc),
      ])

      // The stale monolithic + flat-layout files are gone…
      expect(await exists(join(dir, 'spec/spec.json'))).toBe(false)
      expect(await exists(join(dir, 'spec/rules.md'))).toBe(false)
      expect(await exists(join(dir, 'spec/version.json'))).toBe(false)
      expect(await exists(join(dir, 'spec/features/login.feature'))).toBe(false)
      // …and the freshly sharded layout is written.
      expect(await exists(join(dir, 'spec/service.json'))).toBe(true)
      expect(await exists(join(dir, 'spec/modules/access/authentication.json'))).toBe(true)
      expect(await exists(join(dir, 'spec/features/access/authentication.feature'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deletes orphaned canonical shards but never the seed feature files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-orphan-'))
    try {
      // Seed two features in the Access module.
      const twoGroups: SpecDocTree = {
        ...sampleDoc,
        modules: [
          {
            ...sampleDoc.modules[0]!,
            groups: [
              sampleDoc.modules[0]!.groups[0]!,
              {
                name: 'Logout',
                summary: 'Sign-out.',
                requirements: [
                  {
                    id: 'req-logout',
                    title: 'Logout',
                    statement: 'The system SHALL log a user out.',
                    kind: 'functional',
                    priority: 'must',
                    sourceBlockIds: [],
                    acceptance: [
                      { id: 'lo-1', given: 'a session', when: 'they sign out', outcome: 'it ends' },
                    ],
                  },
                ],
                rules: [],
              },
            ],
          },
        ],
      }
      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(twoGroups),
        ...renderFeatureFiles(twoGroups),
      ])
      expect(await exists(join(dir, 'spec/modules/access/logout.json'))).toBe(true)
      expect(await exists(join(dir, 'spec/features/access/logout.feature'))).toBe(true)

      // A later run drops the Logout feature: its canonical shards are pruned…
      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(sampleDoc),
        ...renderFeatureFiles(sampleDoc),
      ])
      expect(await exists(join(dir, 'spec/modules/access/logout.json'))).toBe(false)
      expect(await exists(join(dir, 'spec/modules/access/logout.md'))).toBe(false)
      // …but the kept feature's shard and the seed-once .feature both survive.
      expect(await exists(join(dir, 'spec/modules/access/authentication.json'))).toBe(true)
      expect(await exists(join(dir, 'spec/features/access/logout.feature'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('seeds feature files only once (preserves pass-2 polish) but refreshes canonical shards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-write-'))
    try {
      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(sampleDoc),
        ...renderFeatureFiles(sampleDoc),
      ])
      const featurePath = join(dir, 'spec/features/access/authentication.feature')
      expect(await readFile(featurePath, 'utf8')).toContain('Scenario: Login')

      // The acceptance agent polishes the feature file in place (pass 2).
      const { writeFile } = await import('node:fs/promises')
      await writeFile(
        featurePath,
        'Feature: Access — Authentication\n\n  Scenario: Polished\n',
        'utf8',
      )

      // A second run with a changed group summary must NOT clobber the polished feature
      // file, but MUST refresh the canonical group shard.
      const changed: SpecDocTree = {
        ...sampleDoc,
        modules: [
          {
            ...sampleDoc.modules[0]!,
            groups: [{ ...sampleDoc.modules[0]!.groups[0]!, summary: 'Sign-in flows, revised.' }],
          },
        ],
      }
      await writeRequirementsFiles(dir, [
        ...renderSpecFiles(changed),
        ...renderFeatureFiles(changed),
      ])

      // Polished feature file is preserved.
      expect(await readFile(featurePath, 'utf8')).toContain('Scenario: Polished')
      // Canonical shard is refreshed.
      const json = JSON.parse(
        await readFile(join(dir, 'spec/modules/access/authentication.json'), 'utf8'),
      )
      expect(json.summary).toBe('Sign-in flows, revised.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
