import { describe, expect, it } from 'vitest'
import type { QuestionStatus } from '@cat-factory/contracts'
import {
  type ResearchReading,
  parseAdhocQuestions,
  readerTopics,
  researchReadingOf,
  revisitableQuestions,
} from '~/utils/research'

function finding(questionId: string, status: QuestionStatus) {
  return {
    finding: {
      questionId,
      status,
      answer: `${questionId} answer`,
      confidence: 'high' as const,
      evidence: [],
      caveats: [],
      ...(status === 'blocked' ? { blockedOn: { credentialKey: 'VENDOR_LOGIN' } } : {}),
    },
    revisionId: 'pout_1',
    seq: 1,
    notes: [],
  }
}

const topics = [
  {
    id: 'auth',
    title: 'Auth',
    questions: [
      { id: 'scheme', question: 'Which auth scheme?' },
      { id: 'scopes', question: 'Which scopes exist?' },
      { id: 'rotate', question: 'How are keys rotated?' },
    ],
  },
]

function view(): ResearchReading {
  return {
    topics,
    view: {
      summary: '',
      latestRevisionId: 'pout_1',
      findings: [
        finding('scheme', 'answered'),
        finding('scopes', 'blocked'),
        finding('adhoc:tsk_1:1', 'partial'),
        finding('legacy', 'answered'),
      ],
      learnings: [],
      adhocQuestions: [{ id: 'adhoc:tsk_1:1', question: 'Is there a sandbox?' }],
      coverage: {
        total: { answered: 2, partial: 1, unanswered: 1, blocked: 1 },
        byTopic: [],
        adhoc: { answered: 0, partial: 1, unanswered: 0, blocked: 0 },
        retiredQuestionIds: ['legacy'],
      },
    },
  }
}

describe('researchReadingOf', () => {
  const board = {
    projectId: 'prj_1',
    kind: 'research',
    pin: { definitionKey: 'acme:vendor', definitionVersion: 2, definitionHash: 'h', inputs: {} },
    definition: {
      kind: 'research',
      key: 'acme:vendor',
      version: 2,
      title: 'Vendor',
      spec: { brief: 'Learn the vendor.', topics },
      credentials: [],
      targets: [{ baseUrl: 'https://vendor.example', surface: 'api' as const }],
      inputs: [],
      promptAdditions: {},
    },
    definitionChanged: false,
    outcomes: [],
    credentials: [],
    view: view().view,
  }

  it('reads the topics off the pinned definition and the kind view as served', () => {
    expect(researchReadingOf(board)?.topics.map((t) => t.id)).toEqual(['auth'])
    expect(researchReadingOf({ ...board, definition: null })?.topics).toEqual([])
    expect(researchReadingOf({ ...board, view: null })).toBeNull()
  })
})

describe('readerTopics', () => {
  it('groups definition questions, ad-hoc questions and answers the version no longer asks', () => {
    const { topics, adhoc, retired } = readerTopics(view())
    expect(topics[0]!.questions.map((q) => [q.id, q.status])).toEqual([
      ['scheme', 'answered'],
      ['scopes', 'blocked'],
      ['rotate', 'unanswered'],
    ])
    expect(adhoc).toMatchObject([{ id: 'adhoc:tsk_1:1', question: 'Is there a sandbox?' }])
    expect(retired.map((q) => q.id)).toEqual(['legacy'])
  })
})

describe('revisitableQuestions', () => {
  it('offers open answers to clarify and every answered question to refresh', () => {
    expect(revisitableQuestions(view(), 'clarify').map((q) => q.id)).toEqual([
      'scopes',
      'adhoc:tsk_1:1',
    ])
    expect(revisitableQuestions(view(), 'refresh').map((q) => q.id)).toEqual([
      'scheme',
      'scopes',
      'adhoc:tsk_1:1',
    ])
    expect(revisitableQuestions(view(), 'extend')).toEqual([])
  })
})

describe('parseAdhocQuestions', () => {
  it('takes one question per line and drops blank ones', () => {
    expect(parseAdhocQuestions('  First?\n\nSecond?  \n')).toEqual(['First?', 'Second?'])
  })
})
