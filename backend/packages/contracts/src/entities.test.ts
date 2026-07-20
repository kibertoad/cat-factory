import { describe, expect, it } from 'vitest'
import type { AprioriBranch, Block, PullRequestRef } from './entities.js'
import {
  allPullRequests,
  aprioriReferenceBranches,
  aprioriWorkingBranch,
  isSafeGitBranchName,
  isWebSearchProvider,
  resolveAprioriWorkingBranch,
} from './entities.js'

// isSafeGitBranchName is a write-boundary guard: the value is used as a git ref, so a
// regression that admits a leading '-', whitespace, or a forbidden ref char lets a stored
// branch smuggle in a flag/path-injection vector. Pin the accept/reject boundary.
describe('isSafeGitBranchName', () => {
  it('accepts ordinary branch names', () => {
    expect(isSafeGitBranchName('main')).toBe(true)
    expect(isSafeGitBranchName('cat-factory/block-123')).toBe(true)
    expect(isSafeGitBranchName('feature/add_thing.v2')).toBe(true)
  })

  it('rejects the empty name and a bare "@"', () => {
    expect(isSafeGitBranchName('')).toBe(false)
    expect(isSafeGitBranchName('@')).toBe(false)
  })

  it('rejects a leading dash (would read as a flag)', () => {
    expect(isSafeGitBranchName('-rf')).toBe(false)
    expect(isSafeGitBranchName('--force')).toBe(false)
  })

  it('rejects leading, trailing, and doubled slashes', () => {
    expect(isSafeGitBranchName('/main')).toBe(false)
    expect(isSafeGitBranchName('main/')).toBe(false)
    expect(isSafeGitBranchName('a//b')).toBe(false)
  })

  it('rejects the .lock suffix', () => {
    expect(isSafeGitBranchName('main.lock')).toBe(false)
  })

  it('rejects the .. sequence and @{ reflog syntax', () => {
    expect(isSafeGitBranchName('a..b')).toBe(false)
    expect(isSafeGitBranchName('a@{0}')).toBe(false)
  })

  it('rejects git-forbidden ref characters', () => {
    for (const ch of ['~', '^', ':', '?', '*', '[', '\\']) {
      expect(isSafeGitBranchName(`a${ch}b`)).toBe(false)
    }
  })

  it('rejects whitespace, control chars, and DEL', () => {
    expect(isSafeGitBranchName('a b')).toBe(false)
    expect(isSafeGitBranchName('a\tb')).toBe(false)
    expect(isSafeGitBranchName('a\nb')).toBe(false)
    expect(isSafeGitBranchName('a\x7fb')).toBe(false)
  })
})

function branch(name: string, mode: AprioriBranch['mode']): AprioriBranch {
  return { name, mode }
}

describe('aprioriWorkingBranch', () => {
  it('returns undefined when there is no list or no working entry', () => {
    expect(aprioriWorkingBranch(undefined)).toBeUndefined()
    expect(aprioriWorkingBranch([])).toBeUndefined()
    expect(aprioriWorkingBranch([branch('ref', 'reference')])).toBeUndefined()
  })

  it('returns the single working branch name', () => {
    expect(aprioriWorkingBranch([branch('ref', 'reference'), branch('wip', 'working')])).toBe('wip')
  })
})

describe('aprioriReferenceBranches', () => {
  it('returns only the reference-mode names, preserving order', () => {
    expect(
      aprioriReferenceBranches([
        branch('r1', 'reference'),
        branch('wip', 'working'),
        branch('r2', 'reference'),
      ]),
    ).toEqual(['r1', 'r2'])
  })

  it('returns [] for undefined / no references', () => {
    expect(aprioriReferenceBranches(undefined)).toEqual([])
    expect(aprioriReferenceBranches([branch('wip', 'working')])).toEqual([])
  })
})

describe('resolveAprioriWorkingBranch', () => {
  it('returns the working branch when it differs from the base', () => {
    expect(resolveAprioriWorkingBranch([branch('wip', 'working')], 'main')).toBe('wip')
  })

  it('returns undefined when no working branch is set', () => {
    expect(resolveAprioriWorkingBranch(undefined, 'main')).toBeUndefined()
    expect(resolveAprioriWorkingBranch([branch('r', 'reference')], 'main')).toBeUndefined()
  })

  it('throws when the working branch equals the base branch', () => {
    expect(() => resolveAprioriWorkingBranch([branch('main', 'working')], 'main')).toThrow(
      /base branch/,
    )
  })
})

const ref = (url: string): PullRequestRef => ({ url })

describe('allPullRequests', () => {
  it('returns [] when the block has no PRs', () => {
    expect(allPullRequests({ pullRequest: undefined, peerPullRequests: undefined })).toEqual([])
  })

  it('lists the own-service PR first with no repo/frameId', () => {
    const out = allPullRequests({ pullRequest: ref('own'), peerPullRequests: [] })
    expect(out).toEqual([{ ref: ref('own') }])
    expect(out[0]).not.toHaveProperty('repo')
  })

  it('appends peer PRs carrying repo and (when known) frameId', () => {
    const block: Pick<Block, 'pullRequest' | 'peerPullRequests'> = {
      pullRequest: ref('own'),
      peerPullRequests: [
        { repo: 'org/peer1', frameId: 'f1', ref: ref('p1') },
        { repo: 'org/peer2', ref: ref('p2') },
      ],
    }
    expect(allPullRequests(block)).toEqual([
      { ref: ref('own') },
      { repo: 'org/peer1', frameId: 'f1', ref: ref('p1') },
      { repo: 'org/peer2', ref: ref('p2') },
    ])
  })

  it('omits frameId entirely when a peer has none (not set to undefined)', () => {
    const out = allPullRequests({
      pullRequest: undefined,
      peerPullRequests: [{ repo: 'org/peer', ref: ref('p') }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).not.toHaveProperty('frameId')
  })
})

describe('isWebSearchProvider', () => {
  it('narrows the two valid providers', () => {
    expect(isWebSearchProvider('brave')).toBe(true)
    expect(isWebSearchProvider('searxng')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isWebSearchProvider('google')).toBe(false)
    expect(isWebSearchProvider('')).toBe(false)
    expect(isWebSearchProvider(null)).toBe(false)
    expect(isWebSearchProvider(undefined)).toBe(false)
    expect(isWebSearchProvider(123)).toBe(false)
  })
})
