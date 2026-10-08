import { describe, expect, it } from 'vitest'
import {
  NEW_THREAD_TAB,
  draftEdit,
  isEditableDraft,
  postableSelection,
  canAsk,
  citationLabel,
  draftAnchor,
  droppedAnchor,
  failureKey,
  keptDrafts,
  isStale,
  reviewTaskTarget,
  suggestedQuestionThread,
  threadTabs,
} from './GuidedReview.logic'

describe('citationLabel', () => {
  it('names a span, a line, or a whole file', () => {
    expect(citationLabel({ path: 'a.ts', startLine: 3, endLine: 9 })).toBe('a.ts:3-9')
    expect(citationLabel({ path: 'a.ts', startLine: 3, endLine: 3 })).toBe('a.ts:3')
    expect(citationLabel({ path: 'a.ts', startLine: 3 })).toBe('a.ts:3')
    expect(citationLabel({ path: 'a.ts' })).toBe('a.ts')
  })
})

describe('canAsk', () => {
  it('waits only on a live answer in this thread', () => {
    expect(canAsk([{ role: 'user', status: 'complete' }])).toBe(true)
    expect(canAsk([{ role: 'assistant', status: 'pending' }])).toBe(false)
    expect(canAsk([{ role: 'assistant', status: 'running' }])).toBe(false)
    expect(canAsk([{ role: 'assistant', status: 'failed' }])).toBe(true)
  })
})

describe('threadTabs', () => {
  const view = { threads: [{ id: 't1' }, { id: 't2' }] } as never
  it('lists threads oldest first and adds the unsaved tab only while it is open', () => {
    expect(threadTabs(view, false)).toEqual(['t1', 't2'])
    expect(threadTabs(view, true)).toEqual(['t1', 't2', NEW_THREAD_TAB])
    expect(threadTabs(undefined, true)).toEqual([NEW_THREAD_TAB])
  })
})

describe('suggestedQuestionThread', () => {
  it('asks the suggestion in a thread of its own', () => {
    expect(suggestedQuestionThread('Is it bounded?')).toEqual({
      question: { content: 'Is it bounded?' },
    })
  })
})

describe('reviewTaskTarget', () => {
  const repo = { owner: 'acme', name: 'shop', provider: 'gitlab' as const }
  it('prefers the stored number and falls back to the URL', () => {
    expect(reviewTaskTarget({ prNumber: 7 }, repo)).toEqual({
      owner: 'acme',
      repo: 'shop',
      prNumber: 7,
      provider: 'gitlab',
    })
    expect(
      reviewTaskTarget({ prUrl: 'https://gitlab.example/acme/shop/-/merge_requests/42' }, repo)
        ?.prNumber,
    ).toBe(42)
    expect(reviewTaskTarget({ prUrl: 'https://github.com/acme/shop/pull/5' }, repo)?.prNumber).toBe(
      5,
    )
  })

  it('is null without a repository or a number', () => {
    expect(reviewTaskTarget({ prNumber: 7 }, undefined)).toBeNull()
    expect(reviewTaskTarget({ prUrl: 'https://example.com/nothing' }, repo)).toBeNull()
  })
})

describe('failure and draft labels', () => {
  it('translates each failure reason under its own key', () => {
    expect(failureKey('budget_exhausted')).toBe('guidedReview.failure.budget_exhausted')
  })

  it('names where a draft sits, or would have', () => {
    expect(droppedAnchor({ path: 'a.ts', line: 9 })).toBe('a.ts:9')
    expect(droppedAnchor({ path: '(none)', line: null })).toBe('(none)')
    expect(draftAnchor({ path: 'a.ts', line: 9, startLine: null })).toBe('a.ts:9')
    expect(draftAnchor({ path: 'a.ts', line: 9, startLine: 4 })).toBe('a.ts:4-9')
  })

  it('counts the drafts one message produced', () => {
    expect(keptDrafts([{ messageId: 'm1' }, { messageId: 'm2' }, { messageId: 'm1' }], 'm1')).toBe(
      2,
    )
  })
})

describe('isStale', () => {
  it('is stale only when a newer head is known', () => {
    expect(isStale('a', 'b')).toBe(true)
    expect(isStale('a', 'a')).toBe(false)
    expect(isStale('a', null)).toBe(false)
  })
})

describe('draft editing and posting', () => {
  it('treats proposed and failed drafts as still editable', () => {
    expect(
      ['proposed', 'failed', 'posting', 'posted', 'discarded'].map((status) =>
        isEditableDraft({ status: status as never }),
      ),
    ).toEqual([true, true, false, false, false])
  })

  it('posts only the selected drafts that are still postable, in list order', () => {
    const drafts = [
      { id: 'a', status: 'proposed' as const },
      { id: 'b', status: 'posted' as const },
      { id: 'c', status: 'failed' as const },
    ]
    expect(postableSelection(drafts, new Set(['c', 'b', 'a']))).toEqual(['a', 'c'])
  })

  it('sends only what an edit changed, and nothing for an untouched form', () => {
    const draft = { body: 'Bound the retries.', line: 3, side: 'RIGHT' as const }
    expect(draftEdit(draft, { body: ' Bound the retries. ', line: 3, side: 'RIGHT' })).toEqual({})
    expect(draftEdit(draft, { body: 'Cap at three.', line: 4, side: 'RIGHT' })).toEqual({
      body: 'Cap at three.',
      line: 4,
    })
  })
})
