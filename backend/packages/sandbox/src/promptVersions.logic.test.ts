import { describe, expect, it } from 'vitest'
import type { SandboxPromptVersion } from '@cat-factory/kernel'
import {
  filterByLabels,
  firstVersionFromBaseline,
  nextVersion,
  versionLabel,
} from './promptVersions.logic.js'

const baseline = {
  agentKind: 'reviewer',
  systemText: 'You are a code reviewer.',
  basePromptId: 'review',
}

describe('firstVersionFromBaseline', () => {
  it('roots a new lineage at version 1 with the baseline text', () => {
    const v1 = firstVersionFromBaseline(baseline, 'strict-reviewer', {
      id: 'pv_1',
      createdAt: 100,
      createdBy: 'user_a',
      labels: ['experiment'],
    })
    expect(v1).toMatchObject({
      id: 'pv_1',
      lineageId: 'pv_1',
      agentKind: 'reviewer',
      name: 'strict-reviewer',
      origin: 'candidate',
      systemText: 'You are a code reviewer.',
      basePromptId: 'review',
      version: 1,
      parentId: null,
      labels: ['experiment'],
      archivedAt: null,
    })
  })

  it('defaults labels to empty', () => {
    const v1 = firstVersionFromBaseline(baseline, 'r', { id: 'pv_1', createdAt: 1, createdBy: null })
    expect(v1.labels).toEqual([])
  })
})

describe('nextVersion', () => {
  it('increments the version, keeps the lineage, and links the parent', () => {
    const v1 = firstVersionFromBaseline(baseline, 'strict-reviewer', {
      id: 'pv_1',
      createdAt: 100,
      createdBy: 'user_a',
    })
    const v2 = nextVersion(v1, 'You are a VERY strict code reviewer.', {
      id: 'pv_2',
      createdAt: 200,
      createdBy: 'user_b',
      labels: ['v2'],
    })
    expect(v2).toMatchObject({
      id: 'pv_2',
      lineageId: 'pv_1',
      name: 'strict-reviewer',
      version: 2,
      parentId: 'pv_1',
      systemText: 'You are a VERY strict code reviewer.',
      basePromptId: 'review',
      labels: ['v2'],
    })
  })

  it('chains so a third version still points at the same lineage', () => {
    const v1 = firstVersionFromBaseline(baseline, 'r', { id: 'pv_1', createdAt: 1, createdBy: null })
    const v2 = nextVersion(v1, 'edit', { id: 'pv_2', createdAt: 2, createdBy: null })
    const v3 = nextVersion(v2, 'edit again', { id: 'pv_3', createdAt: 3, createdBy: null })
    expect(v3.version).toBe(3)
    expect(v3.lineageId).toBe('pv_1')
    expect(v3.parentId).toBe('pv_2')
  })
})

describe('versionLabel', () => {
  it('formats name@vN', () => {
    const v1 = firstVersionFromBaseline(baseline, 'strict', { id: 'pv_1', createdAt: 1, createdBy: null })
    expect(versionLabel(v1)).toBe('strict@v1')
  })
})

describe('filterByLabels', () => {
  const mk = (id: string, labels: string[]): SandboxPromptVersion =>
    firstVersionFromBaseline(baseline, id, { id, createdAt: 1, createdBy: null, labels })

  const versions = [mk('a', ['fast', 'cheap']), mk('b', ['fast']), mk('c', [])]

  it('returns all when no labels requested', () => {
    expect(filterByLabels(versions, [])).toHaveLength(3)
  })

  it('requires every requested label (AND, case-insensitive)', () => {
    expect(filterByLabels(versions, ['FAST']).map((v) => v.id)).toEqual(['a', 'b'])
    expect(filterByLabels(versions, ['fast', 'cheap']).map((v) => v.id)).toEqual(['a'])
  })

  it('returns none when a requested label matches nothing', () => {
    expect(filterByLabels(versions, ['nope'])).toEqual([])
  })
})
