import { describe, expect, it } from 'vitest'
import {
  adhocQuestionId,
  foldFindings,
  isAdhocQuestionId,
  parseResearchDefinition,
  researchCoverage,
  type FoldableFindingsRevision,
  type QuestionFinding,
  type ResearchDefinitionInput,
} from './research.js'

function definition(
  over: Partial<ResearchDefinitionInput> = {},
  spec: Partial<ResearchDefinitionInput['spec']> = {},
): ResearchDefinitionInput {
  return {
    kind: 'research',
    key: 'acme:content-integration',
    version: 1,
    title: 'Content integration',
    spec: {
      brief: 'Find out how the vendor exposes content.',
      topics: [
        {
          id: 'auth',
          title: 'Authentication',
          questions: [
            { id: 'auth-scheme', question: 'Which auth scheme does the API use?' },
            { id: 'token-ttl', question: 'How long does a token live?' },
          ],
        },
        {
          id: 'content',
          title: 'Content',
          questions: [{ id: 'list', question: 'How is content listed?' }],
        },
      ],
      ...spec,
    },
    targets: [{ baseUrl: 'https://api.vendor.example', surface: 'api' }],
    ...over,
  }
}

function finding(
  questionId: string,
  status: QuestionFinding['status'],
  answer = '',
): QuestionFinding {
  return {
    questionId,
    status,
    answer,
    confidence: 'high',
    evidence: [],
    caveats: [],
    ...(status === 'blocked' ? { blockedOn: { credentialKey: 'VENDOR_TOKEN' } } : {}),
  }
}

function revision(
  id: string,
  seq: number,
  findings: QuestionFinding[],
  summary = '',
): FoldableFindingsRevision {
  return {
    id,
    seq,
    body: { summary, findings, learnings: [] },
  }
}

describe('research definition schema', () => {
  it('accepts a well-formed definition and fills the optional lists', () => {
    const parsed = parseResearchDefinition(definition())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.credentials).toEqual([])
      expect(parsed.value.inputs).toEqual([])
    }
  })

  it('refuses a question id repeated across topics, since findings merge by it', () => {
    const parsed = parseResearchDefinition(
      definition(
        {},
        {
          topics: [
            { id: 'a', title: 'A', questions: [{ id: 'q', question: 'one?' }] },
            { id: 'b', title: 'B', questions: [{ id: 'q', question: 'two?' }] },
          ],
        },
      ),
    )
    expect(parsed.ok).toBe(false)
  })

  it('refuses an authored id in the ad-hoc namespace', () => {
    const parsed = parseResearchDefinition(
      definition(
        {},
        { topics: [{ id: 'a', title: 'A', questions: [{ id: 'adhoc:x:1', question: 'q?' }] }] },
      ),
    )
    expect(parsed.ok).toBe(false)
  })

  it('refuses a key without a namespace and a non-https target', () => {
    expect(parseResearchDefinition(definition({ key: 'content' })).ok).toBe(false)
    expect(
      parseResearchDefinition(
        definition({ targets: [{ baseUrl: 'http://api.vendor.example', surface: 'api' }] }),
      ).ok,
    ).toBe(false)
  })

  it('refuses a credential key the platform reserves for its own configuration', () => {
    const parsed = parseResearchDefinition(
      definition({
        credentials: [
          { key: 'ENCRYPTION_KEY', kind: 'secret', label: 'Sealing key', requiredAtStart: true },
        ],
      }),
    )
    expect(parsed.ok).toBe(false)
  })
})

describe('ad-hoc question ids', () => {
  it('are namespaced to their task', () => {
    const id = adhocQuestionId('blk_7', 2)
    expect(id).toBe('adhoc:blk_7:2')
    expect(isAdhocQuestionId(id)).toBe(true)
    expect(isAdhocQuestionId('auth-scheme')).toBe(false)
  })
})

describe('foldFindings', () => {
  it('folds in start order, not finish order', () => {
    const later = revision('r2', 2, [finding('auth-scheme', 'answered', 'OAuth 2')])
    const earlier = revision('r1', 1, [finding('auth-scheme', 'answered', 'API key')])
    const folded = foldFindings([later, earlier])
    expect(folded.byQuestion['auth-scheme']?.finding.answer).toBe('OAuth 2')
    expect(folded.byQuestion['auth-scheme']?.notes.map((n) => n.answer)).toEqual(['API key'])
    expect(folded.latestRevisionId).toBe('r2')
  })

  it('never lets a later blocked or unanswered re-check erase an established answer', () => {
    const folded = foldFindings([
      revision('r1', 1, [
        finding('auth-scheme', 'answered', 'OAuth 2'),
        finding('list', 'partial', 'Paged'),
      ]),
      revision('r2', 2, [finding('auth-scheme', 'blocked'), finding('list', 'unanswered')]),
    ])
    expect(folded.byQuestion['auth-scheme']?.finding.status).toBe('answered')
    expect(folded.byQuestion['auth-scheme']?.notes).toEqual([
      {
        revisionId: 'r2',
        seq: 2,
        status: 'blocked',
        answer: '',
        blockedOn: { credentialKey: 'VENDOR_TOKEN' },
      },
    ])
    expect(folded.byQuestion['list']?.finding.status).toBe('partial')
  })

  it('lets an answer replace an earlier blocked attempt', () => {
    const folded = foldFindings([
      revision('r1', 1, [finding('token-ttl', 'blocked')]),
      revision('r2', 2, [finding('token-ttl', 'answered', '1h')]),
    ])
    expect(folded.byQuestion['token-ttl']?.finding.answer).toBe('1h')
    expect(folded.byQuestion['token-ttl']?.notes[0]?.status).toBe('blocked')
  })

  it('takes the newest summary and keeps every learning tagged with its revision', () => {
    const first = revision('r1', 1, [], 'first')
    first.body.learnings = [{ title: 'Rate limit is 10/s', detail: '' }]
    const second = revision('r2', 2, [], 'second')
    const folded = foldFindings([first, second])
    expect(folded.summary).toBe('second')
    expect(folded.learnings).toEqual([
      { title: 'Rate limit is 10/s', detail: '', revisionId: 'r1' },
    ])
  })

  it('is empty with no revisions', () => {
    expect(foldFindings([])).toEqual({
      byQuestion: {},
      learnings: [],
      summary: '',
      latestRevisionId: null,
    })
  })
})

describe('researchCoverage', () => {
  it('counts every asked question once, treating a never-answered one as unanswered', () => {
    const parsed = parseResearchDefinition(definition())
    if (!parsed.ok) throw new Error('fixture invalid')
    const adhoc = adhocQuestionId('blk_1', 1)
    const folded = foldFindings([
      revision('r1', 1, [
        finding('auth-scheme', 'answered', 'OAuth 2'),
        finding('token-ttl', 'blocked'),
        finding(adhoc, 'partial', 'maybe'),
        finding('retired-question', 'answered', 'old'),
      ]),
    ])
    const coverage = researchCoverage(parsed.value.spec.topics, [adhoc], folded)
    const asked = parsed.value.spec.topics.flatMap((t) => t.questions).length + 1
    const counted = Object.values(coverage.total).reduce((sum, n) => sum + n, 0)
    expect(counted).toBe(asked)
    expect(coverage.byTopic).toEqual([
      { topicId: 'auth', counts: { answered: 1, partial: 0, unanswered: 0, blocked: 1 } },
      { topicId: 'content', counts: { answered: 0, partial: 0, unanswered: 1, blocked: 0 } },
    ])
    expect(coverage.adhoc.partial).toBe(1)
    expect(coverage.retiredQuestionIds).toEqual(['retired-question'])
  })
})
