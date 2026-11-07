import {
  foldFindings,
  type FindingsRevision,
  type Project,
  type ResearchDefinition,
} from '@cat-factory/contracts'
import type {
  AgentRunResult,
  Block,
  FindingsRevisionRow,
  PipelineStep,
  ResolvedResearchDefinition,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  ResearchStepController,
  mergeBodies,
  revisionIdFor,
  selectQuestionIds,
} from './ResearchStepController.js'
import { ResearchFindingsStore } from './ResearchFindingsStore.js'

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

describe('ResearchStepController', () => {
  const project: Project = {
    id: 'prj_1',
    accountId: 'acc_1',
    kind: 'research',
    rootBlockId: 'root_1',
    serviceIds: [],
    createdAt: 0,
  }
  const task = { id: 'task_2', taskTypeFields: {} } as unknown as Block

  function controller(opts: { hash?: string; revisions?: FindingsRevisionRow[] } = {}) {
    const rows = [...(opts.revisions ?? [])]
    const resolved: ResolvedResearchDefinition = {
      definition,
      contentHash: 'h1',
      origin: 'registered',
    }
    const seqs = new Map<string, number>()
    const blockRepository = {
      findById: async () => ({ workspaceId: 'ws_1', ownerId: 'prj_1', block: task }),
    }
    const ctrl = new ResearchStepController({
      blockRepository,
      projectRepository: { get: async () => project },
      researchDefinitions: {
        get: async () => resolved,
        latest: async () => resolved,
        list: async () => [resolved],
      },
      researchProjectRepository: {
        get: async () => ({
          projectId: 'prj_1',
          definitionKey: 'acme:vendor',
          definitionVersion: 1,
          definitionHash: opts.hash ?? 'h1',
          inputs: {},
        }),
        insert: async () => {},
        reserveTaskSeq: async (_projectId, taskId) => {
          if (!seqs.has(taskId)) seqs.set(taskId, seqs.size + 1 + rows.length)
          return seqs.get(taskId)!
        },
        deleteMany: async () => {},
      },
      findings: new ResearchFindingsStore({
        blockRepository,
        workspaceRepository: { accountOf: async () => 'acc_1' },
        findingsRevisionRepository: {
          insert: async (row) => {
            if (rows.some((r) => r.id === row.id)) return false
            rows.push(row)
            return true
          },
          get: async (_projectId, id) => rows.find((r) => r.id === id) ?? null,
          listByProject: async () => rows,
        },
      }),
      clock: { now: () => 5 },
    })
    return { ctrl, rows }
  }

  function storedRow(taskId: string, findings: Record<string, 'answered' | 'partial'>) {
    const body = revision(findings).body
    const json = JSON.stringify(body)
    return {
      ...revision(findings),
      id: revisionIdFor(taskId),
      taskId,
      body: { kind: 'inline', json },
      bodyBytes: json.length,
    } as FindingsRevisionRow
  }

  function reply(findings: Record<string, 'answered' | 'partial'>): AgentRunResult {
    return { output: '', custom: revision(findings).body }
  }

  it('fixes the sequence and questions on the first dispatch and reads them back on a replay', async () => {
    const { ctrl } = controller({ revisions: [storedRow('task_1', { scheme: 'answered' })] })
    const step = { agentKind: 'project-researcher' } as PipelineStep
    const first = await ctrl.prepare(step, task)
    expect(step.research).toMatchObject({
      seq: 2,
      mode: 'extend',
      questionIds: ['scopes', 'expiry'],
    })
    expect(first.priorFindings).toEqual([])
    const replay = await ctrl.prepare(step, task)
    expect(replay.questions.map((q) => q.id)).toEqual(['scopes', 'expiry'])
    expect(step.research?.seq).toBe(2)
  })

  it('refuses a run whose registered definition no longer matches the pinned hash', async () => {
    const { ctrl } = controller({ hash: 'h0' })
    const step = { agentKind: 'project-researcher' } as PipelineStep
    await expect(ctrl.prepare(step, task)).rejects.toMatchObject({
      details: { reason: 'research_definition_changed' },
    })
  })

  it('refuses a mode with nothing left to ask, before claiming a sequence number', async () => {
    const { ctrl } = controller({
      revisions: [
        storedRow('task_1', { scheme: 'answered', scopes: 'answered', expiry: 'answered' }),
      ],
    })
    const step = { agentKind: 'project-researcher' } as PipelineStep
    await expect(ctrl.prepare(step, task)).rejects.toMatchObject({
      details: { reason: 'research_nothing_to_ask' },
    })
    expect(step.research).toBeUndefined()
  })

  it('records the reply merged over the checkpoint, dropping answers it was not asked', async () => {
    const { ctrl, rows } = controller({ revisions: [storedRow('task_1', { scheme: 'answered' })] })
    const step = { agentKind: 'project-researcher' } as PipelineStep
    await ctrl.prepare(step, task)
    step.research = { ...step.research!, checkpoint: revision({ scopes: 'partial' }).body }
    const recorded = await ctrl.record(
      'ws_1',
      step,
      task.id,
      reply({ expiry: 'answered', scheme: 'answered' }),
    )
    const written = rows.find((r) => r.taskId === task.id)!
    const body = JSON.parse((written.body as { json: string }).json) as FindingsRevision['body']
    expect(body.findings.map((f) => [f.questionId, f.status])).toEqual([
      ['scopes', 'partial'],
      ['expiry', 'answered'],
    ])
    expect(recorded.output).toContain('1 answered, 1 partial')
    expect(recorded.output).toContain(
      'Dropped answers to questions this task was not asked: scheme.',
    )
    expect(step.research?.revisionId).toBe(revisionIdFor(task.id))
  })

  it('reports the revision on record when a replayed completion loses to the first write', async () => {
    const { ctrl } = controller()
    const step = { agentKind: 'project-researcher' } as PipelineStep
    await ctrl.prepare(step, task)
    await ctrl.record('ws_1', step, task.id, reply({ scheme: 'answered', scopes: 'answered' }))
    const replay = await ctrl.record('ws_1', step, task.id, reply({ scheme: 'partial' }))
    expect(replay.output).toContain('2 answered, 0 partial')
  })
})
