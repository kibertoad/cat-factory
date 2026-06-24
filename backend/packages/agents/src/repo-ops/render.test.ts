import { describe, expect, it } from 'vitest'
import {
  canonicalBlueprintJson,
  canonicalSpecJson,
  coerceBlueprintService,
  coerceSpecDoc,
  dedupeSpecIds,
  hashBlueprint,
  moduleSlug,
  nextBlueprintVersion,
  nextSpecVersion,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
  renderSpecFeatureFiles,
  renderSpecFiles,
  renderSpecVersionFile,
} from './render.js'

// Golden-file tests locking the deterministic backend rendering of the in-repo
// `blueprints/`/`spec/` artifacts (ported out of the executor-harness). The exact
// bytes matter: the artifacts are committed to the repo, so any drift is a real diff.

const fileMap = (files: { path: string; content: string }[]): Record<string, string> =>
  Object.fromEntries(files.map((f) => [f.path, f.content]))

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
        },
        {
          name: 'Auth', // duplicate group name → feature-file slug collision
          requirements: [
            {
              title: 'Logout',
              statement: 'User can log out.',
              acceptance: [{ given: 'a session', when: 'they log out', outcome: 'session ends' }],
            },
            // No Then clause → not testable → acceptance dropped (req itself survives).
            { title: 'NoThen', statement: 'Edge', acceptance: [{ given: 'x', when: 'y' }] },
          ],
        },
      ],
      rules: [{ rule: 'No negative totals.', rationale: 'money' }, { rule: 'Idempotent.' }],
    },
    'fallback',
  )!

  it('applies id fallbacks, defaults, then→outcome, and drops untestable acceptance', () => {
    const login = doc.groups![0]!.requirements![0]!
    expect(login.id).toBe('req-login')
    expect(login.acceptance?.map((a) => a.id)).toEqual(['req-login-ac-1', 'req-login-ac-2'])
    expect(login.acceptance![0]!.outcome).toBe('they get a token') // then → outcome

    const logout = doc.groups![1]!.requirements![0]!
    expect(logout.priority).toBe('should') // defaulted
    expect(logout.kind).toBe('functional') // defaulted

    const noThen = doc.groups![1]!.requirements![1]!
    expect(noThen.acceptance).toEqual([]) // the lone no-outcome criterion was dropped
  })

  it('renders spec.json canonically', () => {
    const files = fileMap(renderSpecFiles(doc))
    expect(files['spec/spec.json']).toBe(canonicalSpecJson(doc))
  })

  it('renders Gherkin feature files: @must tags, scenario numbering, slug collision', () => {
    const files = fileMap(renderSpecFeatureFiles(doc))
    expect(Object.keys(files).sort()).toEqual([
      'spec/features/auth-2.feature',
      'spec/features/auth.feature',
    ])
    expect(files['spec/features/auth.feature']).toBe(
      `Feature: Auth

  @must
  Scenario: Login (#1)
    Given a user
    When they log in
    Then they get a token

  @must
  Scenario: Login (#2)
    Given bad creds
    When they log in
    Then they are rejected
`,
    )
    expect(files['spec/features/auth-2.feature']).toBe(
      `Feature: Auth

  Scenario: Logout
    Given a session
    When they log out
    Then session ends
`,
    )
  })

  it('counts requirements and rules in the version manifest', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const version = await nextSpecVersion(doc, null, now)
    const manifest = JSON.parse((await renderSpecVersionFile(doc, version)).content)
    expect(manifest.requirements).toBe(3) // Login + Logout + NoThen
    expect(manifest.rules).toBe(2)
    expect(manifest.version).toBe(1)
  })

  it('dedupes colliding ids deterministically', () => {
    const collide = coerceSpecDoc(
      {
        service: 'S',
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
      'fallback',
    )!
    const ids = collide.groups!.flatMap((g) =>
      g.requirements!.flatMap((r) => [r.id, ...(r.acceptance ?? []).map((a) => a.id)]),
    )
    // Second "Login" requirement and its acceptance are suffixed; no duplicates remain.
    expect(ids).toEqual(['req-login', 'req-login-ac-1', 'req-login-2', 'req-login-ac-1-2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is idempotent — re-running dedupe on an already-unique doc is a no-op', () => {
    const before = canonicalSpecJson(doc)
    dedupeSpecIds(doc)
    expect(canonicalSpecJson(doc)).toBe(before)
  })
})
