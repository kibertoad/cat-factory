import { describe, expect, it } from 'vitest'
import type { PrReviewFinding, RepoFileContent } from '@cat-factory/kernel'
import {
  attachFindingExcerpts,
  EXCERPT_MAX_BYTES,
  EXCERPT_MAX_FILES,
  excerptAround,
} from './prReviewExcerpts.logic.js'

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')

const finding = (over: Partial<PrReviewFinding>): PrReviewFinding => ({
  id: 'prf_x',
  sliceId: null,
  path: 'src/a.ts',
  line: 5,
  side: 'RIGHT',
  severity: 'medium',
  category: 'correctness',
  title: 'Finding',
  detail: 'detail',
  suggestedFix: null,
  ...over,
})

const file = (content: string, over: Partial<RepoFileContent> = {}): RepoFileContent => ({
  content,
  sha: 'blob',
  ...over,
})

describe('excerptAround', () => {
  it('takes three lines either side of the anchor', () => {
    expect(excerptAround(numbered(20), 10)).toEqual({
      startLine: 7,
      endLine: 13,
      side: 'RIGHT',
      text: 'line 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13',
    })
  })

  it('clamps at both ends of the file, ignoring the trailing newline', () => {
    expect(excerptAround(`${numbered(3)}\n`, 1)).toMatchObject({ startLine: 1, endLine: 3 })
    expect(excerptAround(`${numbered(3)}\n`, 3)).toMatchObject({ startLine: 1, endLine: 3 })
  })

  it('normalises CRLF line endings', () => {
    expect(excerptAround('a\r\nb\r\nc', 2)?.text).toBe('a\nb\nc')
  })

  it('is null for a line outside the file, a non-positive line, or binary content', () => {
    expect(excerptAround(numbered(3), 4)).toBeNull()
    expect(excerptAround(numbered(3), 0)).toBeNull()
    expect(excerptAround('a\u0000b', 1)).toBeNull()
  })

  it('drops context from the outside in to stay within the byte budget', () => {
    const wide = 'x'.repeat(500)
    const content = Array.from({ length: 9 }, (_, i) => (i === 4 ? 'anchor' : wide)).join('\n')
    const excerpt = excerptAround(content, 5)!
    expect(excerpt).toMatchObject({ startLine: 3, endLine: 7 })
    expect(excerpt.text.split('\n')[2]).toBe('anchor')
    expect(new TextEncoder().encode(excerpt.text).length).toBeLessThanOrEqual(EXCERPT_MAX_BYTES)
  })

  it('counts bytes, not characters', () => {
    const content = ['é'.repeat(600), 'anchor', 'é'.repeat(600)].join('\n')
    expect(excerptAround(content, 2)).toEqual({
      startLine: 2,
      endLine: 3,
      side: 'RIGHT',
      text: `anchor\n${'é'.repeat(600)}`,
    })
  })

  it('is null when the anchor line alone is over budget', () => {
    expect(excerptAround('y'.repeat(EXCERPT_MAX_BYTES + 1), 1)).toBeNull()
  })
})

describe('attachFindingExcerpts', () => {
  it('reads each excerptable path once and stamps every finding', async () => {
    const reads: string[] = []
    const result = await attachFindingExcerpts(
      [
        finding({ id: 'a', line: 2 }),
        finding({ id: 'b', line: 9 }),
        finding({ id: 'c', line: null, side: null }),
        finding({ id: 'd', line: 2, side: 'LEFT' }),
      ],
      async (path) => {
        reads.push(path)
        return file(numbered(10))
      },
    )
    expect(reads).toEqual(['src/a.ts'])
    expect(result.map((f) => f.excerpt?.startLine ?? null)).toEqual([1, 6, null, null])
  })

  it('leaves the excerpt null for a deleted, lossy or unreadable file', async () => {
    const result = await attachFindingExcerpts(
      [
        finding({ id: 'gone', path: 'gone.ts' }),
        finding({ id: 'png', path: 'logo.png' }),
        finding({ id: 'boom', path: 'boom.ts' }),
      ],
      async (path) => {
        if (path === 'gone.ts') return null
        if (path === 'logo.png') return file('��', { lossy: true })
        throw new Error('rate limited')
      },
    )
    expect(result.map((f) => f.excerpt)).toEqual([null, null, null])
  })

  it('reads at most EXCERPT_MAX_FILES distinct files', async () => {
    const findings = Array.from({ length: EXCERPT_MAX_FILES + 5 }, (_, i) =>
      finding({ id: `f${i}`, path: `src/f${i}.ts`, line: 1 }),
    )
    let reads = 0
    const result = await attachFindingExcerpts(findings, async () => {
      reads++
      return file('only line')
    })
    expect(reads).toBe(EXCERPT_MAX_FILES)
    expect(result.filter((f) => f.excerpt).length).toBe(EXCERPT_MAX_FILES)
    expect(result.at(-1)!.excerpt).toBeNull()
  })
})
