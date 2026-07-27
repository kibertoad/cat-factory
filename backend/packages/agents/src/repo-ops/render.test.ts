import type { SpecDoc } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  canonicalBlueprintJson,
  coerceBlueprintService,
  coerceSpecDoc,
  dedupeSpecIds,
  hashBlueprint,
  moduleSlug,
  nextBlueprintVersion,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
  renderSpecFeatureFiles,
  renderSpecFiles,
  promoteRequirementStates,
  clearAspirationalTag,
} from './render.js'

// Golden-file tests locking the deterministic backend rendering of the in-repo
// `blueprints/`/`spec/` artifacts (ported out of the executor-harness). The exact
// bytes matter: the artifacts are committed to the repo, so any drift is a real diff.

const fileMap = (files: { path: string; content: string }[]): Record<string, string> =>
  Object.fromEntries(files.map((f) => [f.path, f.content]))

// Every requirement + acceptance id in a coerced doc, in module→group→requirement order.
const collectSpecIds = (doc: SpecDoc): string[] =>
  doc.modules!.flatMap((m) =>
    m.groups!.flatMap((g) =>
      g.requirements!.flatMap((r) => [r.id, ...(r.acceptance ?? []).map((a) => a.id)]),
    ),
  )

describe('blueprint rendering', () => {
  const service = coerceBlueprintService(
    {
      name: 'Widget',
      summary: 'A widget.',
      modules: [
        {
          name: 'Auth Module',
          summary: 'Handles auth.',
          references: ['src/auth', 'src/auth/login.ts'],
        },
        { name: 'Billing', summary: '', references: [] },
      ],
    },
    'fallback',
  )!

  it('coerces a bare object, defaulting type and dropping empties', () => {
    expect(service.type).toBe('service')
    expect(service.name).toBe('Widget')
    expect(service.modules?.map((m) => m.name)).toEqual(['Auth Module', 'Billing'])
  })

  it('slugs module names filesystem-safely', () => {
    expect(moduleSlug('Auth Module')).toBe('auth-module')
    expect(moduleSlug('  !!!  ')).toBe('module')
  })

  it('renders the canonical blueprint.json with a trailing newline', () => {
    const files = fileMap(renderBlueprintFiles(service))
    expect(files['blueprints/blueprint.json']).toBe(canonicalBlueprintJson(service))
    expect(files['blueprints/blueprint.json']?.endsWith('\n')).toBe(true)
  })

  it('renders overview.md and per-module deep dives byte-for-byte', () => {
    const files = fileMap(renderBlueprintFiles(service))
    expect(files['blueprints/overview.md']).toBe(
      `# Widget

> Generated service blueprint. Read this overview first for the
> high-level structure; open \`modules/<name>.md\` only for a module
> directly relevant to your task.

A widget.

## Modules

### [Auth Module](modules/auth-module.md)

Handles auth.

### [Billing](modules/billing.md)
`,
    )
    expect(files['blueprints/modules/auth-module.md']).toBe(
      `# Auth Module

Handles auth.


**Code references:**
- \`src/auth\`
- \`src/auth/login.ts\`
`,
    )
    expect(files['blueprints/modules/billing.md']).toBe(`# Billing\n`)
  })

  it('keeps the version stable when content is unchanged, bumps otherwise', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const first = await nextBlueprintVersion(service, null, now)
    expect(first).toEqual({ version: 1, generatedAt: '2026-01-01T00:00:00.000Z' })

    const hash = await hashBlueprint(service)
    const manifest = JSON.parse((await renderBlueprintVersionFile(service, first)).content)
    expect(manifest).toEqual({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      hash,
      modules: 2,
    })

    const later = new Date('2026-02-02T00:00:00.000Z')
    const unchanged = await nextBlueprintVersion(
      service,
      { version: 1, generatedAt: first.generatedAt, hash, modules: 2 },
      later,
    )
    expect(unchanged).toEqual(first) // same hash → no bump, no new timestamp
  })
})

describe('spec rendering', () => {
  const doc = coerceSpecDoc(
    {
      service: 'Widget',
      summary: 'Spec.',
      modules: [
        {
          name: 'Identity',
          summary: 'Who can do what.',
          groups: [
            {
              name: 'Auth',
              requirements: [
                {
                  title: 'Login',
                  statement: 'User can log in.',
                  priority: 'must',
                  kind: 'functional',
                  acceptance: [
                    // Deliberately a model-emitted `then` to exercise the `then` → `outcome` coercion.
                    // eslint-disable-next-line unicorn/no-thenable
                    { given: 'a user', when: 'they log in', then: 'they get a token' },
                    { given: 'bad creds', when: 'they log in', outcome: 'they are rejected' },
                  ],
                },
              ],
              // Rules scoped to the feature (no top-level catch-all). Ids derived from text.
              rules: [{ rule: 'No negative totals.', rationale: 'money' }, { rule: 'Idempotent.' }],
            },
            {
              name: 'Auth', // duplicate group name within the module → group slug collision
              requirements: [
                {
                  title: 'Logout',
                  statement: 'User can log out.',
                  acceptance: [
                    { given: 'a session', when: 'they log out', outcome: 'session ends' },
                  ],
                },
                // No Then clause → not testable → acceptance dropped (req itself survives).
                { title: 'NoThen', statement: 'Edge', acceptance: [{ given: 'x', when: 'y' }] },
              ],
            },
          ],
        },
      ],
    },
    'fallback',
  )!

  it('applies id fallbacks, defaults, then→outcome, and drops untestable acceptance', () => {
    const groups = doc.modules![0]!.groups!
    const login = groups[0]!.requirements![0]!
    expect(login.id).toBe('req-login')
    expect(login.acceptance?.map((a) => a.id)).toEqual(['req-login-ac-1', 'req-login-ac-2'])
    expect(login.acceptance![0]!.outcome).toBe('they get a token') // then → outcome
    expect(groups[0]!.rules!.map((r) => r.id)).toEqual([
      'rule-no-negative-totals',
      'rule-idempotent',
    ])

    const logout = groups[1]!.requirements![0]!
    expect(logout.priority).toBe('should') // defaulted
    expect(logout.kind).toBe('functional') // defaulted

    const noThen = groups[1]!.requirements![1]!
    expect(noThen.acceptance).toEqual([]) // the lone no-outcome criterion was dropped
  })

  it('shards each feature group into its own canonical json file', () => {
    const files = fileMap(renderSpecFiles(doc))
    const group = doc.modules![0]!.groups![0]!
    expect(files['spec/modules/identity/auth.json']).toBe(`${JSON.stringify(group, null, 2)}\n`)
    // No monolithic spec.json — the overview is a pure index.
    expect(files['spec/spec.json']).toBeUndefined()
    expect(files['spec/overview.md']).toContain('## Identity')
    expect(files['spec/overview.md']).toContain('[Auth](modules/identity/auth.md)')
  })

  it('renders Gherkin feature files: @must tags, scenario numbering, slug collision', () => {
    const files = fileMap(renderSpecFeatureFiles(doc))
    expect(Object.keys(files).sort()).toEqual([
      'spec/features/identity/auth-2.feature',
      'spec/features/identity/auth.feature',
    ])
    // Every scenario carries `@aspirational` (nothing in this fixture is established yet) plus
    // the `# requirement: <id>` anchor the tester keys its verdicts by.
    expect(files['spec/features/identity/auth.feature']).toBe(
      `Feature: Identity — Auth

  @must @aspirational
  # requirement: req-login
  Scenario: Login (#1)
    Given a user
    When they log in
    Then they get a token

  @must @aspirational
  # requirement: req-login
  Scenario: Login (#2)
    Given bad creds
    When they log in
    Then they are rejected
`,
    )
    expect(files['spec/features/identity/auth-2.feature']).toBe(
      `Feature: Identity — Auth

  @aspirational
  # requirement: req-logout
  Scenario: Logout
    Given a session
    When they log out
    Then session ends
`,
    )
  })

  it('omits @aspirational once a requirement is established, keeping the id anchor', () => {
    const established = coerceSpecDoc(
      {
        service: 'Shop',
        modules: [
          {
            name: 'Identity',
            groups: [
              {
                name: 'Auth',
                requirements: [
                  {
                    id: 'req-login',
                    title: 'Login',
                    statement: 'The system SHALL log users in.',
                    priority: 'must',
                    state: 'established',
                    acceptance: [{ given: 'a user', when: 'they log in', outcome: 'a token' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      'Shop',
    )!
    const files = fileMap(renderSpecFeatureFiles(established))
    expect(files['spec/features/identity/auth.feature']).toBe(
      `Feature: Identity — Auth

  @must
  # requirement: req-login
  Scenario: Login
    Given a user
    When they log in
    Then a token
`,
    )
  })

  it('dedupes colliding ids deterministically', () => {
    const collide = coerceSpecDoc(
      {
        service: 'S',
        modules: [
          {
            name: 'M',
            groups: [
              {
                name: 'A',
                requirements: [
                  {
                    title: 'Login',
                    statement: 'x',
                    acceptance: [{ given: 'g', when: 'w', outcome: 'o' }],
                  },
                ],
              },
              {
                name: 'B',
                requirements: [
                  {
                    title: 'Login',
                    statement: 'y',
                    acceptance: [{ given: 'g', when: 'w', outcome: 'o' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      'fallback',
    )!
    const ids = collectSpecIds(collide)
    // Second "Login" requirement and its acceptance are suffixed; no duplicates remain.
    expect(ids).toEqual(['req-login', 'req-login-ac-1', 'req-login-2', 'req-login-ac-1-2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is idempotent — re-running dedupe on an already-unique doc is a no-op', () => {
    const before = JSON.stringify(doc)
    dedupeSpecIds(doc)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('assigns cross-group id-collision suffixes by name-sorted order, not the emit order', () => {
    const make = (first: string, second: string) =>
      coerceSpecDoc(
        {
          service: 'X',
          modules: [
            {
              name: first,
              groups: [{ name: 'G', requirements: [{ title: 'Create', statement: 'SHALL.' }] }],
            },
            {
              name: second,
              groups: [{ name: 'G', requirements: [{ title: 'Create', statement: 'SHALL.' }] }],
            },
          ],
        },
        'X',
      )!
    const idFor = (d: SpecDoc, name: string) =>
      d.modules!.find((m) => m.name === name)!.groups![0]!.requirements![0]!.id
    for (const d of [make('Alpha', 'Beta'), make('Beta', 'Alpha')]) {
      // Alpha sorts first → bare id; Beta always gets `-2`, independent of emit order, so
      // the per-group shards stay byte-stable across branches.
      expect(idFor(d, 'Alpha')).toBe('req-create')
      expect(idFor(d, 'Beta')).toBe('req-create-2')
    }
  })
})

// ---------------------------------------------------------------------------
// Implementation state (aspirational ⇄ established) — the axis that makes a prescriptive
// spec safe to write down before the behaviour exists. These pin the two things that
// actually reach an agent: the markdown SPLIT (what the build/test prompts read off disk)
// and the promotion helpers (how a state ever changes).
// ---------------------------------------------------------------------------

describe('requirement implementation state', () => {
  const mixed = (): SpecDoc =>
    coerceSpecDoc(
      {
        service: 'Shop',
        modules: [
          {
            name: 'Identity',
            groups: [
              {
                name: 'Auth',
                requirements: [
                  {
                    id: 'req-login',
                    title: 'Login',
                    statement: 'The system SHALL log users in.',
                    priority: 'must',
                    state: 'established',
                    acceptance: [{ given: 'a user', when: 'they log in', outcome: 'a token' }],
                  },
                  {
                    id: 'req-sso',
                    title: 'SSO',
                    statement: 'The system SHALL support SSO.',
                    priority: 'should',
                    state: 'aspirational',
                    acceptance: [{ given: 'an idp', when: 'they log in', outcome: 'a session' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      'Shop',
    )!

  it('defaults an absent or unrecognised state to aspirational, never established', () => {
    const doc = coerceSpecDoc(
      {
        service: 'S',
        modules: [
          {
            name: 'M',
            groups: [
              {
                name: 'G',
                requirements: [
                  { id: 'a', title: 'A', statement: 'SHALL a.' },
                  { id: 'b', title: 'B', statement: 'SHALL b.', state: 'established' },
                  { id: 'c', title: 'C', statement: 'SHALL c.', state: 'totally-made-up' },
                ],
              },
            ],
          },
        ],
      },
      'S',
    )!
    const reqs = doc.modules![0]!.groups![0]!.requirements!
    expect(reqs.map((r) => r.state)).toEqual(['aspirational', 'established', 'aspirational'])
  })

  it('splits the group markdown into established vs aspirational, labelling each', () => {
    const md = fileMap(renderSpecFiles(mixed()))['spec/modules/identity/auth.md']!
    expect(md).toContain('## Requirements — established')
    expect(md).toContain('## Requirements — aspirational (not yet built)')
    // The established half is standing behaviour; the aspirational half must say it is not.
    expect(md).toContain('breaking any of it is a regression')
    expect(md).toContain('Do NOT assume the service already behaves this')
    // Each requirement is rendered under the correct heading, with its id exposed so an
    // agent (and the tester) can name it.
    const established = md.slice(
      md.indexOf('## Requirements — established'),
      md.indexOf('## Requirements — aspirational'),
    )
    expect(established).toContain('`req-login`')
    expect(established).not.toContain('`req-sso`')
    expect(md.slice(md.indexOf('## Requirements — aspirational'))).toContain('`req-sso`')
  })

  it('omits a heading entirely when one half is empty', () => {
    const doc = mixed()
    doc.modules![0]!.groups![0]!.requirements = doc.modules![0]!.groups![0]!.requirements!.filter(
      (r) => r.state === 'aspirational',
    )
    const md = fileMap(renderSpecFiles(doc))['spec/modules/identity/auth.md']!
    expect(md).not.toContain('## Requirements — established')
    expect(md).toContain('## Requirements — aspirational (not yet built)')
  })

  it('promotes only the named aspirational requirements, and reports what it promoted', () => {
    const doc = mixed()
    // `req-login` is ALREADY established, so it is not re-reported — that is what lets a
    // replayed durable step tell "no work to do" from "work done".
    expect(promoteRequirementStates(doc, ['req-login', 'req-sso'])).toEqual(['req-sso'])
    const reqs = doc.modules![0]!.groups![0]!.requirements!
    expect(reqs.map((r) => r.state)).toEqual(['established', 'established'])
    // Idempotent: a second pass over the same ids promotes nothing.
    expect(promoteRequirementStates(doc, ['req-login', 'req-sso'])).toEqual([])
  })

  it('never demotes, and ignores unknown ids', () => {
    const doc = mixed()
    expect(promoteRequirementStates(doc, ['req-nonexistent'])).toEqual([])
    expect(promoteRequirementStates(doc, [])).toEqual([])
    expect(doc.modules![0]!.groups![0]!.requirements!.map((r) => r.state)).toEqual([
      'established',
      'aspirational',
    ])
  })
})

describe('clearAspirationalTag', () => {
  const feature = `Feature: Identity — Auth

  @must @aspirational
  # requirement: req-login
  Scenario: Login
    Given a user
    When they log in
    Then a token

  @aspirational
  # requirement: req-sso
  Scenario: SSO
    Given an idp
    When they log in
    Then a session
`

  it('drops the tag only for promoted ids, keeping sibling tags', () => {
    const out = clearAspirationalTag(feature, ['req-login'])
    expect(out).toContain('  @must\n  # requirement: req-login')
    // The untouched requirement keeps its tag.
    expect(out).toContain('  @aspirational\n  # requirement: req-sso')
  })

  it('removes a tag line that becomes empty rather than leaving a blank tag', () => {
    const out = clearAspirationalTag(feature, ['req-sso'])
    expect(out).toContain('  # requirement: req-sso\n  Scenario: SSO')
    expect(out.split('\n').filter((l) => l.trim() === '@aspirational')).toHaveLength(0)
    // The line is SPLICED OUT, not blanked — a whitespace-only leftover would be a stray
    // line in a committed artifact (and a diff on every promotion).
    expect(out.split('\n').filter((l) => /^[ \t]+$/.test(l))).toHaveLength(0)
    // The other requirement's tag line is untouched.
    expect(out).toContain('  @must @aspirational\n  # requirement: req-login')
  })

  it('is a no-op when nothing matches, so a polished file is never mangled', () => {
    expect(clearAspirationalTag(feature, [])).toBe(feature)
    expect(clearAspirationalTag(feature, ['req-unknown'])).toBe(feature)
    // A polished file that lost the anchor comment degrades to a no-op.
    const polished = 'Feature: X\n\n  @aspirational\n  Scenario: Y\n    Then z\n'
    expect(clearAspirationalTag(polished, ['req-login'])).toBe(polished)
  })
})
