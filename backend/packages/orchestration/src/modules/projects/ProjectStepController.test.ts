import type {
  FindingsRevisionBody,
  Project,
  ProjectDefinition,
  ProjectPin,
} from '@cat-factory/contracts'
import {
  ProjectKindModuleRegistry,
  researchKindModule,
  ValidationError,
  type AgentRunResult,
  type Block,
  type PipelineStep,
  type ProjectKindModule,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  type ResolvedProjectDefinition,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { ProjectStepController, outcomeIdFor } from './ProjectStepController.js'

const definition: ProjectDefinition = {
  kind: 'research',
  key: 'acme:vendor',
  version: 1,
  title: 'Vendor',
  spec: {
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
  },
  credentials: [],
  targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  inputs: [],
  promptAdditions: {},
}

/** A second kind with no definition and a body of a different shape: one note per task. */
const notesModule: ProjectKindModule<{ note: string }> = {
  kind: 'notes',
  agentKind: 'note-taker',
  outcomeSchemaVersion: 1,
  parseSpec: (d) => ({ ok: true, value: d.spec }),
  parseOutcome: (_v, value) =>
    typeof (value as { note?: unknown })?.note === 'string'
      ? (value as { note: string })
      : undefined,
  planTask: ({ outcomes }) => {
    if (outcomes.length >= 2) {
      throw new ValidationError('Two notes are enough', { reason: 'notes_full' })
    }
    return { intent: 'write', stream: 'notes', plan: { nth: outcomes.length + 1 } }
  },
  brief: ({ plan }) => ({ nth: (plan as { nth: number }).nth }),
  mergeCheckpoint: (_earlier, later) => later,
  finish: ({ reply }) => ({ body: reply, output: `noted: ${reply.note}` }),
  describe: ({ body }) => `noted: ${body.note}`,
  artifactRefs: () => [],
  definitionSummary: (definition) => definition.title,
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

function outcomeRow(
  taskId: string,
  seq: number,
  value: unknown,
  stream = 'main',
): ProjectOutcomeRow {
  const json = JSON.stringify(value)
  return {
    id: outcomeIdFor(taskId),
    projectId: 'prj_1',
    stream,
    seq,
    intent: 'initial',
    schemaVersion: 1,
    taskId,
    definitionKey: null,
    definitionVersion: null,
    artifactRefs: [],
    createdAt: 1,
    body: { kind: 'inline', json },
    bodyBytes: json.length,
  }
}

function harness(opts: {
  kind: string
  pin?: Partial<ProjectPin> | null
  rows?: ProjectOutcomeRow[]
}) {
  const project: Project = {
    id: 'prj_1',
    accountId: 'acc_1',
    kind: opts.kind,
    rootBlockId: 'root_1',
    serviceIds: [],
    createdAt: 0,
  }
  const task = { id: 'task_2', taskTypeFields: {} } as unknown as Block
  const rows = [...(opts.rows ?? [])]
  const resolved: ResolvedProjectDefinition = {
    definition,
    contentHash: 'h1',
    origin: 'registered',
  }
  const seqs = new Map<string, number>()
  const modules = new ProjectKindModuleRegistry()
  modules.register(researchKindModule)
  modules.register(notesModule)
  const pin: ProjectPin | null =
    opts.pin === null
      ? null
      : {
          projectId: 'prj_1',
          definitionKey: 'acme:vendor',
          definitionVersion: 1,
          definitionHash: 'h1',
          inputs: {},
          ...opts.pin,
        }
  const blockRepository = {
    findById: async () => ({ workspaceId: 'ws_1', ownerId: 'prj_1', block: task }),
  }
  const definitions = {
    get: async () => resolved,
    latest: async () => resolved,
    list: async () => [resolved],
  }
  const records: ProjectRecordRepository = {
    getPin: async () => pin,
    insertPin: async () => {},
    reserveSeq: async () => seqs.size + 1 + rows.length,
    reserveTaskSeq: async (_projectId: string, taskId: string) => {
      if (!seqs.has(taskId)) seqs.set(taskId, seqs.size + 1 + rows.length)
      return seqs.get(taskId)!
    },
    insertOutcome: async (row: ProjectOutcomeRow) => {
      if (rows.some((r) => r.id === row.id)) return false
      rows.push(row)
      return true
    },
    getOutcome: async (_projectId: string, id: string) => rows.find((r) => r.id === id) ?? null,
    listOutcomes: async () => rows,
    deleteByProjects: async () => {},
  }
  const ctrl = new ProjectStepController({
    blockRepository,
    projectRepository: { get: async () => project },
    definitions,
    records,
    outcomes: new ProjectOutcomeStore({
      blockRepository,
      workspaceRepository: { accountOf: async () => 'acc_1' },
      records,
    }),
    modules,
    clock: { now: () => 5 },
  })
  return { ctrl, rows, task }
}

const reply = (custom: unknown): AgentRunResult => ({ output: '', custom })

describe('ProjectStepController with the research kind', () => {
  const researching = { agentKind: 'project-researcher' } as PipelineStep

  it('fixes the sequence and plan on the first dispatch and reads them back on a replay', async () => {
    const { ctrl, task } = harness({
      kind: 'research',
      rows: [outcomeRow('task_1', 1, body({ scheme: 'answered' }))],
    })
    const step = { ...researching }
    const first = await ctrl.prepare(step, task)
    expect(step.project).toMatchObject({
      kind: 'research',
      seq: 2,
      intent: 'extend',
      stream: 'main',
      plan: { questionIds: ['scopes', 'expiry'] },
    })
    expect(first.brief).toMatchObject({ mode: 'extend', priorFindings: [] })
    const replay = await ctrl.prepare(step, task)
    expect((replay.brief as { questions: { id: string }[] }).questions.map((q) => q.id)).toEqual([
      'scopes',
      'expiry',
    ])
    expect(step.project?.seq).toBe(2)
  })

  it('refuses a run whose registered definition no longer matches the pinned hash', async () => {
    const { ctrl, task } = harness({ kind: 'research', pin: { definitionHash: 'h0' } })
    await expect(ctrl.prepare({ ...researching }, task)).rejects.toMatchObject({
      details: { reason: 'project_definition_changed' },
    })
  })

  it("refuses the kind's own nothing-to-do before claiming a sequence number", async () => {
    const { ctrl, task } = harness({
      kind: 'research',
      rows: [
        outcomeRow(
          'task_1',
          1,
          body({ scheme: 'answered', scopes: 'answered', expiry: 'answered' }),
        ),
      ],
    })
    const step = { ...researching }
    await expect(ctrl.prepare(step, task)).rejects.toMatchObject({
      details: { reason: 'research_nothing_to_ask' },
    })
    expect(step.project).toBeUndefined()
  })

  it('records the reply folded over the checkpoint by the kind, dropping what it was not asked', async () => {
    const { ctrl, rows, task } = harness({
      kind: 'research',
      rows: [outcomeRow('task_1', 1, body({ scheme: 'answered' }))],
    })
    const step = { ...researching }
    await ctrl.prepare(step, task)
    step.project = { ...step.project!, checkpoint: body({ scopes: 'partial' }) }
    const recorded = await ctrl.record(
      'ws_1',
      step,
      task.id,
      reply(body({ expiry: 'answered', scheme: 'answered' })),
    )
    const written = rows.find((r) => r.taskId === task.id)!
    const stored = JSON.parse((written.body as { json: string }).json) as FindingsRevisionBody
    expect(stored.findings.map((f) => [f.questionId, f.status])).toEqual([
      ['scopes', 'partial'],
      ['expiry', 'answered'],
    ])
    expect(written).toMatchObject({
      intent: 'extend',
      stream: 'main',
      definitionKey: 'acme:vendor',
    })
    expect(recorded.output).toContain('1 answered, 1 partial')
    expect(recorded.output).toContain(
      'Dropped answers to questions this task was not asked: scheme.',
    )
    expect(step.project?.outcomeId).toBe(outcomeIdFor(task.id))
  })

  it('reports the outcome on record when a replayed completion loses to the first write', async () => {
    const { ctrl, task } = harness({ kind: 'research' })
    const step = { ...researching }
    await ctrl.prepare(step, task)
    await ctrl.record(
      'ws_1',
      step,
      task.id,
      reply(body({ scheme: 'answered', scopes: 'answered' })),
    )
    const replay = await ctrl.record('ws_1', step, task.id, reply(body({ scheme: 'partial' })))
    expect(replay.output).toContain('2 answered, 0 partial')
  })
})

describe('ProjectStepController with a pinless kind', () => {
  const noting = { agentKind: 'note-taker' } as PipelineStep

  it('runs a kind with no definition through the same plan, brief and record', async () => {
    const { ctrl, rows, task } = harness({ kind: 'notes', pin: null })
    const step = { ...noting }
    const run = await ctrl.prepare(step, task)
    expect(run).toMatchObject({ kind: 'notes', definition: null, brief: { nth: 1 } })
    expect(step.project).toMatchObject({ stream: 'notes', intent: 'write', definitionKey: null })
    const recorded = await ctrl.record('ws_1', step, task.id, reply({ note: 'use webhooks' }))
    expect(recorded.output).toBe('noted: use webhooks')
    expect(rows[0]).toMatchObject({ stream: 'notes', definitionKey: null, definitionVersion: null })
  })

  it("refuses a step under a project of another kind, and the kind's own refusal", async () => {
    const { ctrl, task } = harness({ kind: 'notes', pin: null })
    await expect(
      ctrl.prepare({ agentKind: 'project-researcher' } as PipelineStep, task),
    ).rejects.toMatchObject({ details: { reason: 'task_type_requires_project' } })
    const full = harness({
      kind: 'notes',
      pin: null,
      rows: [
        outcomeRow('a', 1, { note: 'x' }, 'notes'),
        outcomeRow('b', 2, { note: 'y' }, 'notes'),
      ],
    })
    await expect(full.ctrl.prepare({ ...noting }, full.task)).rejects.toMatchObject({
      details: { reason: 'notes_full' },
    })
  })
})
