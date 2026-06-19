import { describe, expect, it } from 'vitest'
import { classifyMergeability } from '../../src/infrastructure/github/GitHubMergeabilityProvider'

// Maps GitHub's lazily-computed `mergeable` / `mergeable_state` to the engine's
// conflict-gate verdict. Only a 'dirty' state is a real conflict; a null/unknown
// reading means GitHub hasn't finished computing it (poll again); everything else
// has no conflict for the resolver to fix.
describe('classifyMergeability', () => {
  it("treats 'dirty' as a conflict regardless of the mergeable flag", () => {
    expect(classifyMergeability(false, 'dirty')).toBe('conflicted')
    expect(classifyMergeability(null, 'dirty')).toBe('conflicted')
  })

  it("treats a null mergeable or 'unknown' state as still-computing", () => {
    expect(classifyMergeability(null, 'unknown')).toBe('unknown')
    expect(classifyMergeability(null, 'clean')).toBe('unknown')
    expect(classifyMergeability(true, 'unknown')).toBe('unknown')
    expect(classifyMergeability(null, '')).toBe('unknown')
  })

  it('treats clean / behind / blocked / unstable as mergeable (no conflict to resolve)', () => {
    expect(classifyMergeability(true, 'clean')).toBe('mergeable')
    expect(classifyMergeability(true, 'behind')).toBe('mergeable')
    expect(classifyMergeability(true, 'blocked')).toBe('mergeable')
    expect(classifyMergeability(true, 'unstable')).toBe('mergeable')
  })
})
