import {
  foldFindings,
  type FindingsRevision,
  type ResearchDefinition,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { mergeBodies, selectQuestionIds } from './ResearchStepController.js'

const definition: ResearchDefinition = {
  key: 'acme:vendor',
  version: 1,
  title: 'Vendor',
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
  credentials: [],
  targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  inputs: [],
  promptAdditions: {},
}

function revision(statuses: Record<string, 'answered' | 'partial' | 'blocked'>): FindingsRevision {
  return {
    id: 'rev_1',
    projectId: 'prj_1',
    taskId: 'task_1',
    seq: 1,
    mode: 'initial',
    definitionKey: 'acme:vendor',
    definitionVersion: 1,
    createdAt: 1,
    body: {
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
    },
  }
}

describe('selectQuestionIds', () => {
  const folded = foldFindings([revision({ scheme: 'answered', scopes: 'partial' })])

  it('asks every question initially and only the untouched ones to extend', () => {
    expect(selectQuestionIds(definition, 'initial', folded)).toEqual(['scheme', 'scopes', 'expiry'])
    expect(selectQuestionIds(definition, 'extend', folded)).toEqual(['expiry'])
  })

  it('clarifies what is partial or blocked, and refreshes what has an answer', () => {
    expect(selectQuestionIds(definition, 'clarify', folded)).toEqual(['scopes'])
    expect(selectQuestionIds(definition, 'refresh', folded)).toEqual(['scheme', 'scopes'])
  })

  it('narrows clarify and refresh to the named questions', () => {
    expect(selectQuestionIds(definition, 'refresh', folded, ['scheme'])).toEqual(['scheme'])
  })

  it('offers the ad-hoc questions earlier tasks added to every mode but initial', () => {
    const adhoc = 'adhoc:task_0:1'
    const withAdhoc = foldFindings([revision({ scheme: 'answered', [adhoc]: 'partial' })])
    expect(selectQuestionIds(definition, 'initial', withAdhoc, undefined, [adhoc])).toEqual([
      'scheme',
      'scopes',
      'expiry',
    ])
    expect(selectQuestionIds(definition, 'clarify', withAdhoc, undefined, [adhoc])).toEqual([adhoc])
    expect(selectQuestionIds(definition, 'refresh', withAdhoc, undefined, [adhoc])).toEqual([
      'scheme',
      adhoc,
    ])
  })
})

describe('mergeBodies', () => {
  it('lets the later answer to a question replace the checkpointed one, keeping the rest', () => {
    const checkpoint = revision({ scheme: 'answered', scopes: 'blocked' }).body
    const final = revision({ scopes: 'answered' }).body
    const merged = mergeBodies(checkpoint, final)
    expect(merged.findings.map((f) => [f.questionId, f.status])).toEqual([
      ['scheme', 'answered'],
      ['scopes', 'answered'],
    ])
  })
})
