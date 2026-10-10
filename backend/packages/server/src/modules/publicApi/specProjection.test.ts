import {
  PUBLIC_SPEC_MAX_ACCEPTANCE,
  PUBLIC_SPEC_MAX_FEATURE_CHARS,
  PUBLIC_SPEC_MAX_FEATURE_FILES,
  PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS,
  PUBLIC_SPEC_MAX_ISSUES,
  PUBLIC_SPEC_MAX_REQUIREMENTS,
  type PublicSpecProvenance,
  type RequirementItem,
  type ServiceSpecView,
  type SpecFeatureFile,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { toPublicRunSpec, toPublicServiceSpec } from './specProjection.js'

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
    const projected = toPublicServiceSpec('svc_1', 'present', viewWith(2, 3), PROVENANCE)
    expect(projected.serviceId).toBe('svc_1')
    expect(projected.anchor).toBe('present')
    expect(requirementsOf(projected.spec)).toHaveLength(6)
    // An EMPTY `truncations` is the load-bearing half: it is what tells a reader the tree above
    // is the whole spec rather than the part that fit.
    expect(projected.truncations).toEqual([])
  })

  it('caps requirements across the WHOLE tree and reports the real total', () => {
    // Two groups either side of the budget, so the cap has to be spent across groups rather than
    // applied per group. A per-group cap would return twice the ceiling and report neither.
    const perGroup = PUBLIC_SPEC_MAX_REQUIREMENTS
    const projected = toPublicServiceSpec('svc_1', 'present', viewWith(2, perGroup), PROVENANCE)
    expect(requirementsOf(projected.spec)).toHaveLength(PUBLIC_SPEC_MAX_REQUIREMENTS)
    expect(projected.truncations).toEqual([
      { section: 'requirements', shown: PUBLIC_SPEC_MAX_REQUIREMENTS, total: perGroup * 2 },
    ])
  })

  it('keeps a group the cap emptied, rather than pruning it out of the tree', () => {
    const projected = toPublicServiceSpec(
      'svc_1',
      'present',
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
      'present',
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
      'present',
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
      'present',
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
      'present',
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
    const projected = toPublicServiceSpec('svc_1', 'present', viewWith(1, 1, files), PROVENANCE)
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
    expect(toPublicServiceSpec('svc_1', 'present', view, PROVENANCE).issues).toEqual(
      view.diagnostics.issues,
    )
  })

  it('projects an ABSENT spec without inventing a tree, keeping the provenance', () => {
    const projected = toPublicServiceSpec(
      'svc_1',
      'absent',
      { present: false, spec: null, features: [], diagnostics: { anchor: 'absent', issues: [] } },
      PROVENANCE,
    )
    expect(projected).toMatchObject({
      anchor: 'absent',
      spec: null,
      features: [],
      issues: [],
      truncations: [],
      // The provenance still names the branch that was looked at, which is what makes
      // `anchor: 'absent'` a statement about a specific commit rather than about the service.
      provenance: PROVENANCE,
    })
  })

  it('carries the anchor the CALLER decided, never one re-derived from the view', () => {
    // A corrupt `spec/service.json` reads as an empty view exactly as a missing one does, and the
    // caller is the only layer that knows which. A projection recomputing `present` off the view
    // would answer `absent` here and fold the outcome the endpoint exists to keep apart.
    const view: ServiceSpecView = {
      present: false,
      spec: null,
      features: [],
      diagnostics: {
        anchor: 'unparsed',
        issues: [{ path: 'spec/service.json', kind: 'unparsed', dropped: 0 }],
      },
    }
    const projected = toPublicServiceSpec('svc_1', 'unparsed', view, PROVENANCE)
    expect(projected.anchor).toBe('unparsed')
    expect(projected.spec).toBeNull()
    expect(projected.issues).toEqual(view.diagnostics?.issues)
  })

  it('caps the ISSUE list, the one axis that grows with FAILURE rather than with the spec', () => {
    const issues = Array.from({ length: PUBLIC_SPEC_MAX_ISSUES + 7 }, (_, i) => ({
      path: `spec/modules/m/${i}.json`,
      kind: 'read_failed' as const,
      dropped: 0,
    }))
    const view = viewWith(1, 1)
    view.diagnostics = { anchor: 'present', issues }
    const projected = toPublicServiceSpec('svc_1', 'present', view, PROVENANCE)
    expect(projected.issues).toHaveLength(PUBLIC_SPEC_MAX_ISSUES)
    // Reported like every other cap: a silently shortened issue list understates a degraded read,
    // which is the one thing the list exists to prevent.
    expect(projected.truncations).toEqual([
      { section: 'issues', shown: PUBLIC_SPEC_MAX_ISSUES, total: issues.length },
    ])
  })

  it('bounds the Gherkin across ALL files, not only within each one', () => {
    // Each file fits the per-file cap, so the per-file cap alone would serve every one of them:
    // 500 x 20,000 characters is the ten-megabyte body the total budget exists to refuse.
    const each = PUBLIC_SPEC_MAX_FEATURE_CHARS
    const count = Math.ceil(PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS / each) + 5
    const files = Array.from({ length: count }, (_, i) =>
      feature(`spec/features/o/${i}.feature`, 'x'.repeat(each)),
    )
    const projected = toPublicServiceSpec('svc_1', 'present', viewWith(1, 1, files), PROVENANCE)
    const carried = projected.features.reduce((n, f) => n + f.chars, 0)
    expect(carried).toBeLessThanOrEqual(PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS)
    expect(projected.features.length).toBeLessThan(count)
    // `shown` counts what the caller actually received, so it reflects whichever bound bit.
    expect(projected.truncations).toEqual([
      { section: 'features', shown: projected.features.length, total: count },
    ])
  })

  it('caps acceptance criteria across the tree, keeping the requirements that carry them', () => {
    const perRequirement = 10
    const requirements = PUBLIC_SPEC_MAX_ACCEPTANCE / perRequirement + 5
    const view = viewWith(1, requirements)
    for (const group of view.spec?.modules[0]?.groups ?? []) {
      for (const item of group.requirements ?? []) {
        item.acceptance = Array.from({ length: perRequirement }, (_, i) => ({
          id: `${item.id}-ac-${i}`,
          given: 'a cart',
          when: 'checkout',
          outcome: 'an order',
        }))
      }
    }
    const projected = toPublicServiceSpec('svc_1', 'present', view, PROVENANCE)
    const served = requirementsOf(projected.spec)
    // Every requirement survives: the id is the join key this whole endpoint exists for, so the
    // criteria are what the budget cuts, never the row that names them.
    expect(served).toHaveLength(requirements)
    expect(served.reduce((n, r) => n + (r.acceptance ?? []).length, 0)).toBe(
      PUBLIC_SPEC_MAX_ACCEPTANCE,
    )
    expect(projected.truncations).toEqual([
      {
        section: 'acceptance',
        shown: PUBLIC_SPEC_MAX_ACCEPTANCE,
        total: requirements * perRequirement,
      },
    ])
  })
})

// The RUN projection serves the same document at a different ref, so the assertion worth making
// is not that its caps work (they are the same code) but that it IS the same code: a second copy
// is how the two endpoints would come to bound one repository's Gherkin differently.
describe('toPublicRunSpec', () => {
  it('bounds a run read exactly as the service read bounds the same view', () => {
    const view = viewWith(4, PUBLIC_SPEC_MAX_REQUIREMENTS)
    const asService = toPublicServiceSpec('svc_1', 'present', view, PROVENANCE)
    const asRun = toPublicRunSpec('exec_1', { anchor: 'present', view, provenance: PROVENANCE })

    expect(asRun.spec).toEqual(asService.spec)
    expect(asRun.features).toEqual(asService.features)
    expect(asRun.issues).toEqual(asService.issues)
    expect(asRun.truncations).toEqual(asService.truncations)
    expect(asRun.truncations.length).toBeGreaterThan(0)
  })

  it('serves not_read as an empty body with no provenance, never as an absent spec', () => {
    // The one shape the service read cannot produce. `provenance: null` is the point: naming a
    // branch would imply a read that did not happen, and an `absent` anchor would claim the branch
    // holds no requirements, which is a statement nothing has checked.
    expect(toPublicRunSpec('exec_1', { anchor: 'not_read' })).toEqual({
      runId: 'exec_1',
      anchor: 'not_read',
      spec: null,
      features: [],
      provenance: null,
      issues: [],
      truncations: [],
    })
  })
})
