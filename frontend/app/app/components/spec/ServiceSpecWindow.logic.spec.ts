import { describe, it, expect } from 'vitest'
import {
  filterRequirementsByState,
  requirementState,
  summarizeRequirementStates,
  summarizeSpecStates,
} from './ServiceSpecWindow.logic'
import type { RequirementItem, SpecModule } from '~/types/spec'

/**
 * The implementation-state view of the service-spec window (service-acceptance-criteria, slice 4).
 * The axis only earns its keep if "agreed" and "observed to hold" never render the same, so these
 * pin the counting, the defensive read of a missing state, and the filter's identity fast path.
 */
const req = (id: string, state?: RequirementItem['state']): RequirementItem =>
  ({
    id,
    title: id,
    statement: `The system SHALL ${id}.`,
    kind: 'functional',
    priority: 'must',
    ...(state ? { state } : {}),
  }) as RequirementItem

describe('requirementState', () => {
  it('reads an explicit established state', () => {
    expect(requirementState(req('a', 'established'))).toBe('established')
  })

  it('treats an absent or unknown state as aspirational', () => {
    expect(requirementState(req('a'))).toBe('aspirational')
    expect(requirementState({ state: 'nonsense' } as unknown as RequirementItem)).toBe(
      'aspirational',
    )
  })
})

describe('summarizeRequirementStates', () => {
  it('counts both halves and their total', () => {
    expect(
      summarizeRequirementStates([
        req('a', 'established'),
        req('b', 'aspirational'),
        req('c', 'established'),
      ]),
    ).toEqual({ total: 3, established: 2, aspirational: 1 })
  })

  it('counts a requirement with no state as aspirational', () => {
    expect(summarizeRequirementStates([req('a')])).toEqual({
      total: 1,
      established: 0,
      aspirational: 1,
    })
  })

  it('returns zeroes for an absent or empty list', () => {
    const zero = { total: 0, established: 0, aspirational: 0 }
    expect(summarizeRequirementStates(undefined)).toEqual(zero)
    expect(summarizeRequirementStates([])).toEqual(zero)
  })
})

describe('summarizeSpecStates', () => {
  // The parsed wire type fills every optional with its default, so the sparse shapes below are
  // cast: they stand for what a hand-written or partially-hydrated tree actually looks like at
  // runtime, which is exactly the case the helpers are defensive about.
  const modules = [
    {
      name: 'auth',
      groups: [
        { name: 'login', requirements: [req('a', 'established'), req('b')] },
        { name: 'logout', requirements: [req('c', 'established')] },
      ],
    },
    // A module whose only group has no requirements, and a module with no groups at all: both
    // contribute nothing rather than throwing — a spec is legitimately sparse while it is
    // being written.
    { name: 'billing', groups: [{ name: 'invoices' }] },
    { name: 'empty' },
  ] as unknown as SpecModule[]

  it('rolls the per-group counts up across the tree', () => {
    expect(summarizeSpecStates(modules)).toEqual({ total: 3, established: 2, aspirational: 1 })
  })

  it('returns zeroes for an absent module list', () => {
    expect(summarizeSpecStates(undefined)).toEqual({ total: 0, established: 0, aspirational: 0 })
  })
})

describe('filterRequirementsByState', () => {
  const list = [req('a', 'established'), req('b'), req('c', 'aspirational')]

  it('returns the same array reference for the default filter', () => {
    expect(filterRequirementsByState(list, 'all')).toBe(list)
  })

  it('keeps only the requested half', () => {
    expect(filterRequirementsByState(list, 'established').map((r) => r.id)).toEqual(['a'])
    expect(filterRequirementsByState(list, 'aspirational').map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('handles an absent list', () => {
    expect(filterRequirementsByState(undefined, 'established')).toEqual([])
    expect(filterRequirementsByState(undefined, 'all')).toEqual([])
  })
})
