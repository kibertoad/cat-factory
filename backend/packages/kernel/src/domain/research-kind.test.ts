import { describe, expect, it } from 'vitest'
import { foldFindings, type FindingsRevisionBody, type ResearchSpec } from '@cat-factory/contracts'
import { mergeFindingsBodies, selectQuestionIds } from './research-kind.js'

const spec: ResearchSpec = {
  brief: 'Learn the vendor.',
  topics: [
    {
      id: 'auth',
      title: 'Auth',
      questions: [
        { id: 'scheme', question: 'Which scheme?' },
        { id: 'scopes', question: 'Which scopes?' },
        { id: 'expiry', question: 'How long do tokens live?' },
      ],
    },
  ],
}

function body(statuses: Record<string, 'answered' | 'partial' | 'blocked'>): FindingsRevisionBody {
  return {
    summary: '',
    learnings: [],
    adhocQuestions: [],
    findings: Object.entries(statuses).map(([questionId, status]) => ({
      questionId,
      status,
      answer: status === 'blocked' ? '' : 'known',
      confidence: 'high' as const,
      evidence: [],
      caveats: [],
      ...(status === 'blocked' ? { blockedOn: { credentialKey: 'VENDOR_LOGIN' } } : {}),
    })),
  }
}

describe('selectQuestionIds', () => {
  const folded = foldFindings([
    { id: 'r1', seq: 1, body: body({ scheme: 'answered', scopes: 'partial' }) },
  ])

  it('asks every question initially and only the untouched ones to extend', () => {
    expect(selectQuestionIds(spec, 'initial', folded)).toEqual(['scheme', 'scopes', 'expiry'])
    expect(selectQuestionIds(spec, 'extend', folded)).toEqual(['expiry'])
  })

  it('clarifies what is partial or blocked, and refreshes what has an answer', () => {
    expect(selectQuestionIds(spec, 'clarify', folded)).toEqual(['scopes'])
    expect(selectQuestionIds(spec, 'refresh', folded)).toEqual(['scheme', 'scopes'])
  })

  it('narrows clarify and refresh to the named questions', () => {
    expect(selectQuestionIds(spec, 'refresh', folded, ['scheme'])).toEqual(['scheme'])
  })
})

describe('mergeFindingsBodies', () => {
  it('lets the later answer to a question replace the checkpointed one, keeping the rest', () => {
    const merged = mergeFindingsBodies(
      body({ scheme: 'answered', scopes: 'blocked' }),
      body({ scopes: 'answered' }),
    )
    expect(merged.findings.map((f) => [f.questionId, f.status])).toEqual([
      ['scheme', 'answered'],
      ['scopes', 'answered'],
    ])
  })
})
