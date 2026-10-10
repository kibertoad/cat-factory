import type { AprioriBranch, Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { aprioriBranchesError } from './board.logic.js'

// Minimal task-block factory — only the fields aprioriBranchesError reads.
function task(over: Partial<Block> = {}): Block {
  return {
    id: 'blk_task',
    title: 'A task',
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: 'blk_frame',
    ...over,
  }
}

const ref = (name: string): AprioriBranch => ({ name, mode: 'reference' })
const work = (name: string): AprioriBranch => ({ name, mode: 'working' })

describe('aprioriBranchesError', () => {
  it('accepts an empty list', () => {
    expect(aprioriBranchesError([], task(), false)).toBeNull()
  })

  it('accepts one working + several reference branches', () => {
    const branches = [work('feature/x'), ref('spike/a'), ref('spike/b')]
    expect(aprioriBranchesError(branches, task(), false)).toBeNull()
  })

  it('rejects two working branches', () => {
    expect(aprioriBranchesError([work('a'), work('b')], task(), false)).toMatch(
      /At most one working/,
    )
  })

  it('rejects a duplicate branch name', () => {
    expect(aprioriBranchesError([ref('a'), ref('a')], task(), false)).toMatch(/Duplicate/)
  })

  it('rejects the same name as both reference and working (as a duplicate)', () => {
    expect(aprioriBranchesError([work('a'), ref('a')], task(), false)).toMatch(/Duplicate/)
  })

  it('rejects a working branch on a multi-repo task', () => {
    expect(aprioriBranchesError([work('a')], task(), true)).toMatch(/multi-repo/)
  })

  it('allows reference-only branches on a multi-repo task', () => {
    expect(aprioriBranchesError([ref('a')], task(), true)).toBeNull()
  })

  describe('frozen once a PR exists', () => {
    const withPr = (branches: AprioriBranch[] | undefined) =>
      task({
        aprioriBranches: branches,
        pullRequest: { number: 1, url: 'http://x', branch: 'feature/x' },
      })

    it('rejects changing the working branch after a PR exists', () => {
      const block = withPr([work('feature/x')])
      expect(aprioriBranchesError([work('feature/y')], block, false)).toMatch(/cannot be changed/)
    })

    it('rejects dropping the working branch after a PR exists', () => {
      const block = withPr([work('feature/x')])
      expect(aprioriBranchesError([], block, false)).toMatch(/cannot be changed/)
    })

    it('allows keeping the working branch while editing references after a PR exists', () => {
      const block = withPr([work('feature/x')])
      expect(aprioriBranchesError([work('feature/x'), ref('spike/new')], block, false)).toBeNull()
    })
  })
})
