import type { GitHubRepo } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { changedDirectoryRepoIds, type StoredDirectoryRepo } from './directory-repos.js'

const repo = (overrides: Partial<GitHubRepo> = {}): GitHubRepo => ({
  githubId: 1,
  installationId: 10,
  owner: 'acme',
  name: 'api',
  defaultBranch: 'main',
  private: true,
  provider: 'github',
  syncedAt: 2_000,
  ...overrides,
})

const stored = (overrides: Partial<StoredDirectoryRepo> = {}): StoredDirectoryRepo => ({
  githubId: 1,
  owner: 'acme',
  name: 'api',
  defaultBranch: 'main',
  private: true,
  provider: 'github',
  tombstoned: false,
  ...overrides,
})

describe('changedDirectoryRepoIds', () => {
  it('ignores a re-sync that only moves synced_at or the installation', () => {
    expect(
      changedDirectoryRepoIds([stored()], [repo({ syncedAt: 9_000, installationId: 11 })]),
    ).toEqual([])
  })

  it('reports a new row and a revived tombstone', () => {
    expect(changedDirectoryRepoIds([], [repo()])).toEqual([1])
    expect(changedDirectoryRepoIds([stored({ tombstoned: true })], [repo()])).toEqual([1])
  })

  it.each([
    ['owner', { owner: 'other' }],
    ['name', { name: 'web' }],
    ['default branch', { defaultBranch: 'trunk' }],
    ['visibility', { private: false }],
    ['provider', { provider: 'gitlab' as const }],
  ])('reports a changed %s', (_field, change) => {
    expect(changedDirectoryRepoIds([stored()], [repo(change)])).toEqual([1])
  })

  it('reads a missing provider as github', () => {
    expect(changedDirectoryRepoIds([stored()], [repo({ provider: undefined })])).toEqual([])
  })
})
