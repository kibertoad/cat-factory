import {
  PUBLIC_SPEC_MAX_FEATURE_CHARS,
  PUBLIC_SPEC_MAX_FEATURE_FILES,
  PUBLIC_SPEC_MAX_REQUIREMENTS,
  type PublicSpecProvenance,
  type RequirementItem,
  type ServiceSpecView,
  type SpecFeatureFile,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { toPublicServiceSpec } from './specProjection.js'

// The public spec projection's whole job is bounding a response WITHOUT lying about the spec
// behind it, so every test here asks the same question: after the cap, can a reader still tell
// what the service declares?

const PROVENANCE: PublicSpecProvenance = {
  provider: 'github',
  owner: 'acme',
  repo: 'checkout',
  ref: 'main',
  commit: 'abc123',
}

function requirement(id: string): RequirementItem {
  return {
    id,
    title: id,
    statement: 'The system SHALL do the thing.',
    kind: 'functional',
    priority: 'must',
    state: 'aspirational',
    sourceBlockIds: [],
    acceptance: [],
  }
}

/** A view whose requirements are spread over `groups` groups of `perGroup` each. */
function viewWith(
  groups: number,
  perGroup: number,
  features: SpecFeatureFile[] = [],
): ServiceSpecView {
  let n = 0
  return {
    present: true,
    spec: {
      service: 'Checkout',
      summary: '',
      modules: [
        {
          name: 'Orders',
          summary: '',
          groups: Array.from({ length: groups }, (_, g) => ({
            name: `group-${g}`,
            summary: '',
            requirements: Array.from({ length: perGroup }, () => requirement(`req-${n++}`)),
            rules: [],
          })),
        },
      ],
    },
    features,
    diagnostics: { anchor: 'present', issues: [] },
  }
}

function feature(path: string, content: string): SpecFeatureFile {
  return { module: 'Orders', group: 'g', path, content }
}

const requirementsOf = (spec: ReturnType<typeof toPublicServiceSpec>['spec']) =>
  (spec?.modules ?? []).flatMap((m) => m.groups ?? []).flatMap((g) => g.requirements ?? [])

describe('toPublicServiceSpec', () => {
  it('passes a small spec through whole, with nothing to report', () => {
    const projected = toPublicServiceSpec('svc_1', viewWith(2, 3), PROVENANCE)
    expect(projected.serviceId).toBe('svc_1')
    expect(projected.present).toBe(true)
    expect(requirementsOf(projected.spec)).toHaveLength(6)
    // An EMPTY `truncations` is the load-bearing half: it is what tells a reader the tree above
    // is the whole spec rather than the part that fit.
    expect(projected.truncations).toEqual([])
  })

  it('caps requirements across the WHOLE tree and reports the real total', () => {
    // Two groups either side of the budget, so the cap has to be spent across groups rather than
    // applied per group. A per-group cap would return twice the ceiling and report neither.
    const perGroup = PUBLIC_SPEC_MAX_REQUIREMENTS
    const projected = toPublicServiceSpec('svc_1', viewWith(2, perGroup), PROVENANCE)
    expect(requirementsOf(projected.spec)).toHaveLength(PUBLIC_SPEC_MAX_REQUIREMENTS)
    expect(projected.truncations).toEqual([
      { section: 'requirements', shown: PUBLIC_SPEC_MAX_REQUIREMENTS, total: perGroup * 2 },
    ])
  })

  it('keeps a group the cap emptied, rather than pruning it out of the tree', () => {
    const projected = toPublicServiceSpec(
      'svc_1',
      viewWith(2, PUBLIC_SPEC_MAX_REQUIREMENTS),
      PROVENANCE,
    )
    const groups = (projected.spec?.modules ?? []).flatMap((m) => m.groups ?? [])
    // The second group spent no budget at all. It stays, empty: a group that VANISHES reads as a
    // feature the service never specified, which is a stronger claim than "we ran out of room".
    expect(groups.map((g) => g.name)).toEqual(['group-0', 'group-1'])
    expect(groups[1]?.requirements).toEqual([])
  })

  it("cuts in traversal order, so the rows served are the tree's own first rows", () => {
    const projected = toPublicServiceSpec(
      'svc_1',
      viewWith(1, PUBLIC_SPEC_MAX_REQUIREMENTS + 5),
      PROVENANCE,
    )
    const ids = requirementsOf(projected.spec).map((r) => r.id)
    expect(ids[0]).toBe('req-0')
    expect(ids.at(-1)).toBe(`req-${PUBLIC_SPEC_MAX_REQUIREMENTS - 1}`)
  })

  it('clamps a long feature file and states what it holds', () => {
    const long = 'x'.repeat(PUBLIC_SPEC_MAX_FEATURE_CHARS + 500)
    const projected = toPublicServiceSpec(
      'svc_1',
      viewWith(1, 1, [feature('spec/features/o/a.feature', long)]),
      PROVENANCE,
    )
    const file = projected.features[0]!
    expect(file.chars).toBe(PUBLIC_SPEC_MAX_FEATURE_CHARS)
    expect(file.totalChars).toBe(PUBLIC_SPEC_MAX_FEATURE_CHARS + 500)
    expect(file.truncated).toBe(true)
    expect(file.content).toHaveLength(PUBLIC_SPEC_MAX_FEATURE_CHARS)
    // A file that FITS is not marked truncated, so `truncated` stays a signal rather than noise.
    const small = toPublicServiceSpec(
      'svc_1',
      viewWith(1, 1, [feature('spec/features/o/b.feature', 'Feature: b\n')]),
      PROVENANCE,
    )
    expect(small.features[0]).toMatchObject({ chars: 11, totalChars: 11, truncated: false })
  })

  it('counts and cuts Gherkin in code POINTS, never mid-surrogate', () => {
    // An astral character is two UTF-16 units and one code point. A raw `slice` at the ceiling
    // would emit a lone surrogate (a replacement character on the wire) and report a length no
    // caller could reproduce from the bytes it received.
    const content = '🐱'.repeat(PUBLIC_SPEC_MAX_FEATURE_CHARS + 10)
    const projected = toPublicServiceSpec(
      'svc_1',
      viewWith(1, 1, [feature('spec/features/o/c.feature', content)]),
      PROVENANCE,
    )
    const file = projected.features[0]!
    expect(file.totalChars).toBe(PUBLIC_SPEC_MAX_FEATURE_CHARS + 10)
    expect([...file.content]).toHaveLength(PUBLIC_SPEC_MAX_FEATURE_CHARS)
    expect(file.content.endsWith('🐱')).toBe(true)
  })

  it('caps the NUMBER of feature files and reports how many exist', () => {
    const files = Array.from({ length: PUBLIC_SPEC_MAX_FEATURE_FILES + 3 }, (_, i) =>
      feature(`spec/features/o/${i}.feature`, 'Feature: x\n'),
    )
    const projected = toPublicServiceSpec('svc_1', viewWith(1, 1, files), PROVENANCE)
    expect(projected.features).toHaveLength(PUBLIC_SPEC_MAX_FEATURE_FILES)
    expect(projected.truncations).toEqual([
      {
        section: 'features',
        shown: PUBLIC_SPEC_MAX_FEATURE_FILES,
        total: PUBLIC_SPEC_MAX_FEATURE_FILES + 3,
      },
    ])
  })

  it("carries the reader's issues through, so a partial tree says which files are missing", () => {
    const view = viewWith(1, 1)
    view.diagnostics = {
      anchor: 'present',
      issues: [
        { path: 'spec/modules/m/flaky.json', kind: 'read_failed', dropped: 0 },
        { path: 'spec/modules/m/g.json', kind: 'partial', dropped: 2 },
      ],
    }
    expect(toPublicServiceSpec('svc_1', view, PROVENANCE).issues).toEqual(view.diagnostics.issues)
  })

  it('projects an ABSENT spec without inventing a tree, keeping the provenance', () => {
    const projected = toPublicServiceSpec(
      'svc_1',
      { present: false, spec: null, features: [], diagnostics: { anchor: 'absent', issues: [] } },
      PROVENANCE,
    )
    expect(projected).toMatchObject({
      present: false,
      spec: null,
      features: [],
      issues: [],
      truncations: [],
      // The provenance still names the branch that was looked at, which is what makes
      // `present: false` a statement about a specific commit rather than about the service.
      provenance: PROVENANCE,
    })
  })
})
