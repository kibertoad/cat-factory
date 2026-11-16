import { describe, expect, it } from 'vitest'
import {
  foldFindings,
  type FindingsRevisionBody,
  type ResearchProjectView,
  type ResearchSpec,
} from '@cat-factory/contracts'
import { mergeFindingsBodies, researchKindModule, selectQuestionIds } from './research-kind.js'

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

describe('researchKindModule.view', () => {
  const definition = {
    kind: 'research',
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    credentials: [],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'ui' as const }],
    inputs: [],
    promptAdditions: {},
    spec,
  }
  const outcome = (id: string, seq: number, findings: FindingsRevisionBody) => ({
    id,
    projectId: 'p1',
    stream: 'main',
    seq,
    intent: 'initial',
    schemaVersion: 1,
    taskId: null,
    definitionKey: 'acme:vendor',
    definitionVersion: 1,
    artifactRefs: [],
    createdAt: seq,
    body: findings,
  })

  it('folds every revision and counts coverage against the pinned definition', () => {
    const view = researchKindModule.view!({
      definition,
      inputs: {},
      outcomes: [
        outcome('r1', 1, body({ scheme: 'answered', scopes: 'blocked' })),
        outcome('r2', 2, body({ scopes: 'partial' })),
      ],
    }) as ResearchProjectView
    expect(view.latestRevisionId).toBe('r2')
    expect(view.coverage.total).toEqual({ answered: 1, partial: 1, unanswered: 1, blocked: 0 })
    expect(view.findings.find((f) => f.finding.questionId === 'scopes')?.notes).toHaveLength(1)
  })

  it('still folds the revisions of a project whose definition is gone, with no topic to cover', () => {
    const view = researchKindModule.view!({
      definition: null,
      inputs: {},
      outcomes: [outcome('r1', 1, body({ scheme: 'answered' }))],
    }) as ResearchProjectView
    expect(view.findings).toHaveLength(1)
    expect(view.coverage.byTopic).toEqual([])
    expect(view.coverage.retiredQuestionIds).toEqual(['scheme'])
  })
})
