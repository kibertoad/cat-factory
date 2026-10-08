import type { GuidedReviewMessage } from '@cat-factory/contracts'
import type { GitHubChangedFile } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  anchorDrafts,
  coerceAnswer,
  coerceDraftProposals,
  coerceOverview,
  partitionPatches,
  threadHistory,
  threadTitleFrom,
} from './guidedReview.logic.js'

function file(path: string, patch: string | null): GitHubChangedFile {
  return { path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch }
}

// Hunk: old lines 10-12, new lines 10-13. RIGHT 10 (context), 11 (added), 12 (context)…
const PATCH = ['@@ -10,3 +10,4 @@', ' keep', '-old', '+new', '+added', ' tail'].join('\n')

function message(seq: number, over: Partial<GuidedReviewMessage>): GuidedReviewMessage {
  return {
    id: `m${seq}`,
    threadId: 't',
    sessionId: 's',
    seq,
    role: 'user',
    kind: 'answer',
    depth: 'inline',
    content: `message ${seq}`,
    status: 'complete',
    citations: [],
    failure: null,
    draftReport: null,
    model: null,
    createdAt: seq,
    updatedAt: seq,
    ...over,
  }
}

describe('coerceOverview', () => {
  it('keeps well-formed entries, drops untitled ones and gives each question an id', () => {
    let n = 0
    const overview = coerceOverview(
      {
        summary: ' Adds checkout. ',
        intent: 'Sell things.',
        meaningfulChanges: [
          { title: 'Cart', detail: 'New cart', paths: ['src/cart.ts', 3] },
          { detail: 'no title' },
        ],
        consequences: 'not a list',
        risks: [{ title: 'Retries', detail: 'Unbounded', severity: 'critical', paths: [] }],
        focusAreas: [
          {
            title: 'Retry loop',
            why: 'Risky',
            anchors: [{ path: 'src/pay.ts', startLine: 4, endLine: 0 }, {}],
          },
        ],
        suggestedQuestions: ['What happens on timeout?', { question: 'Is it idempotent?' }, ''],
      },
      () => `q${++n}`,
    )
    expect(overview).toEqual({
      summary: 'Adds checkout.',
      intent: 'Sell things.',
      meaningfulChanges: [{ title: 'Cart', detail: 'New cart', paths: ['src/cart.ts'] }],
      consequences: [],
      risks: [{ title: 'Retries', detail: 'Unbounded', severity: 'medium', paths: [] }],
      focusAreas: [
        { title: 'Retry loop', why: 'Risky', anchors: [{ path: 'src/pay.ts', startLine: 4 }] },
      ],
      suggestedQuestions: [
        { id: 'q1', question: 'What happens on timeout?' },
        { id: 'q2', question: 'Is it idempotent?' },
      ],
    })
  })

  it('returns null when the reply carries no summary', () => {
    expect(coerceOverview({ intent: 'x' }, () => 'q')).toBeNull()
    expect(coerceOverview('not json', () => 'q')).toBeNull()
  })
})

describe('coerceAnswer', () => {
  it('keeps the answer and the valid citations', () => {
    expect(
      coerceAnswer({
        answer: 'Because **retries**.',
        citations: [{ path: 'a.ts', startLine: 1, endLine: 2, side: 'RIGHT' }, { startLine: 3 }],
      }),
    ).toEqual({
      content: 'Because **retries**.',
      citations: [{ path: 'a.ts', startLine: 1, endLine: 2, side: 'RIGHT' }],
    })
  })

  it('is null without answer text', () => {
    expect(coerceAnswer({ citations: [] })).toBeNull()
  })
})

describe('anchorDrafts', () => {
  const files = [file('src/pay.ts', PATCH), file('src/blob.png', null)]

  it('keeps lines inside a hunk and reports every refused proposal with its reason', () => {
    const { proposals, incomplete } = coerceDraftProposals({
      comments: [
        { path: 'src/pay.ts', line: 11, side: 'RIGHT', body: 'Bound this.', rationale: 'r' },
        { path: 'src/pay.ts', line: 11, side: 'LEFT', body: 'Removed line.', rationale: 'r' },
        { path: 'src/pay.ts', line: 40, side: 'RIGHT', body: 'Far away.', rationale: 'r' },
        { path: 'README.md', line: 1, side: 'RIGHT', body: 'Not in PR.', rationale: 'r' },
        { path: 'src/pay.ts', side: 'RIGHT', body: 'No line.' },
      ],
    })
    const { kept, report } = anchorDrafts(proposals, incomplete, files)
    expect(kept.map((d) => [d.side, d.line])).toEqual([
      ['RIGHT', 11],
      ['LEFT', 11],
    ])
    expect(report).toEqual({
      proposed: 5,
      dropped: [
        { path: 'src/pay.ts', line: null, side: 'RIGHT', reason: 'incomplete' },
        { path: 'src/pay.ts', line: 40, side: 'RIGHT', reason: 'outside_diff' },
        { path: 'README.md', line: 1, side: 'RIGHT', reason: 'not_in_pr' },
      ],
    })
  })

  it('narrows a span whose start is outside the hunk to its last line', () => {
    const { proposals } = coerceDraftProposals({
      comments: [{ path: 'src/pay.ts', startLine: 2, line: 12, side: 'RIGHT', body: 'Span.' }],
    })
    expect(anchorDrafts(proposals, [], files).kept[0]).toMatchObject({ startLine: null, line: 12 })
  })

  it('narrows a span whose ends sit in two different hunks, which the host refuses', () => {
    const twoHunks = '@@ -1,2 +1,2 @@\n a\n b\n@@ -20,2 +20,2 @@\n c\n d'
    const { proposals } = coerceDraftProposals({
      comments: [{ path: 'src/two.ts', startLine: 2, line: 21, side: 'RIGHT', body: 'Span.' }],
    })
    expect(anchorDrafts(proposals, [], [file('src/two.ts', twoHunks)]).kept[0]).toMatchObject({
      startLine: null,
      line: 21,
    })
  })

  it('refuses any line of a file the host returned no patch for', () => {
    const { proposals } = coerceDraftProposals({
      comments: [{ path: 'src/blob.png', line: 1, side: 'RIGHT', body: 'Binary.' }],
    })
    expect(anchorDrafts(proposals, [], files).report.dropped).toEqual([
      { path: 'src/blob.png', line: 1, side: 'RIGHT', reason: 'outside_diff' },
    ])
  })
})

describe('threadHistory', () => {
  it('keeps the newest settled turns within budget and counts what it left out', () => {
    const messages = [
      message(1, { content: 'a'.repeat(30) }),
      message(2, { role: 'assistant', content: 'b'.repeat(30) }),
      message(3, { role: 'assistant', status: 'failed', content: '' }),
      message(4, { content: 'c'.repeat(30) }),
      message(5, { role: 'assistant', status: 'pending', content: '' }),
    ]
    expect(threadHistory(messages, 65)).toEqual({
      history: [
        { role: 'assistant', content: 'b'.repeat(30) },
        { role: 'user', content: 'c'.repeat(30) },
      ],
      omittedTurns: 1,
    })
  })

  it('always keeps the latest turn even when it alone exceeds the budget', () => {
    expect(threadHistory([message(1, { content: 'x'.repeat(100) })], 10).history).toHaveLength(1)
  })
})

describe('partitionPatches', () => {
  it('inlines patches until the budget, then lists the rest, skipping files without one', () => {
    const files = [file('a.ts', 'x'.repeat(40)), file('b.ts', null), file('c.ts', 'y'.repeat(40))]
    expect(partitionPatches(files, 50)).toEqual({
      inline: [{ path: 'a.ts', patch: 'x'.repeat(40) }],
      omitted: ['c.ts'],
    })
  })
})

describe('threadTitleFrom', () => {
  it('takes the first line and cuts it to the title limit', () => {
    expect(threadTitleFrom('  Why retries?\nmore detail')).toBe('Why retries?')
    expect(threadTitleFrom('q'.repeat(200))).toHaveLength(80)
  })
})
