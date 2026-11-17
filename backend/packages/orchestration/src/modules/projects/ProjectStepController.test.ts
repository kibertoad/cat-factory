import type {
  FindingsRevisionBody,
  Project,
  ProjectDefinition,
  ProjectPin,
  ProjectStage,
  ProjectStageTask,
} from '@cat-factory/contracts'
import {
  ProjectKindModuleRegistry,
  researchKindModule,
  ValidationError,
  type AgentRunResult,
  type Block,
  type PipelineStep,
  type ProjectOutcomeRow,
  type ProjectTaskHandler,
  eraseTaskHandler,
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
  stages: [],
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

/** A second kind's handler, for a body of a different shape: one note per task. */
const notesHandler: ProjectTaskHandler<{ note: string }> = {
  taskType: 'notes',
  agentKind: 'note-taker',
  outcomeSchemaVersion: 1,
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
}

/** A second kind with no definition. */
const notesModule = {
  kind: 'notes',
  handlers: [eraseTaskHandler(notesHandler)],
  parseSpec: (d: ProjectDefinition) => ({ ok: true as const, value: d.spec }),
  definitionSummary: (d: ProjectDefinition) => d.title,
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
    taskType: stream === 'notes' ? 'notes' : 'research',
    definitionKey: null,
    definitionVersion: null,
    artifactRefs: [],
    createdAt: 1,
    body: { kind: 'inline', json },
    bodyBytes: json.length,
  }
}

/** A kind offering both task types, so one project holds outcomes of two bodies. */
const mixedModule = {
  ...notesModule,
  kind: 'mixed',
  handlers: [...researchKindModule.handlers, ...notesModule.handlers],
}

function harness(opts: {
  kind: string
  taskType?: string
  pin?: Partial<ProjectPin> | null
  rows?: ProjectOutcomeRow[]
  stages?: ProjectStage[]
  stageTasks?: ProjectStageTask[]
}) {
  const project: Project = {
    id: 'prj_1',
    accountId: 'acc_1',
    kind: opts.kind,
    rootBlockId: 'root_1',
    serviceIds: [],
    createdAt: 0,
  }
  const task = {
    id: 'task_2',
    taskType: opts.taskType ?? (opts.kind === 'notes' ? 'notes' : 'research'),
    taskTypeFields: {},
  } as unknown as Block
  const rows = [...(opts.rows ?? [])]
  const stageTasks = [...(opts.stageTasks ?? [])]
  const resolved: ResolvedProjectDefinition = {
    definition: { ...definition, stages: opts.stages ?? [] },
    contentHash: 'h1',
    origin: 'registered',
  }
  const seqs = new Map<string, number>()
  const modules = new ProjectKindModuleRegistry()
  modules.register(researchKindModule)
  modules.register(notesModule)
  modules.register(mixedModule)
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
    findByIds: async () => [],
  }
  const definitions = {
    get: async () => resolved,
    latest: async () => resolved,
    list: async () => [resolved],
  }
  const records: ProjectRecordRepository = {
    getPin: async () => pin,
    listPins: async () => (pin ? [pin] : []),
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
    listOutcomesOfProjects: async () => rows,
    projectsWithOutcomes: async () => (rows.length ? ['prj_1'] : []),
    insertStageTask: async (row: ProjectStageTask) => {
      stageTasks.push(row)
      return true
    },
    listStageTasks: async () => stageTasks,
    markStageTaskRecorded: async (_projectId: string, taskId: string, recordedAt: number) => {
      const found = stageTasks.find((t) => t.taskId === taskId)
      if (found && found.recordedAt === null) found.recordedAt = recordedAt
    },
    clearStageCheckpoint: async () => false,
    deleteStageTasks: async () => {},
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
  return { ctrl, rows, task, stageTasks }
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

describe('ProjectStepController with outcomes that record no task type', () => {
  it("attributes them to a one-handler kind's handler, so research still folds them", async () => {
    const { ctrl, task } = harness({
      kind: 'research',
      rows: [{ ...outcomeRow('task_1', 1, body({ scheme: 'answered' })), taskType: null }],
    })
    const step = { agentKind: 'project-researcher' } as PipelineStep
    await ctrl.prepare(step, task)
    expect(step.project).toMatchObject({
      intent: 'extend',
      plan: { questionIds: ['scopes', 'expiry'] },
    })
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
    expect(rows[0]).toMatchObject({
      stream: 'notes',
      taskType: 'notes',
      definitionKey: null,
      definitionVersion: null,
    })
  })

  it("plans a task from its own handler's outcomes only, in a kind offering two", async () => {
    const { ctrl, task } = harness({
      kind: 'mixed',
      taskType: 'notes',
      pin: null,
      rows: [
        outcomeRow('r', 1, body({ scheme: 'answered' })),
        outcomeRow('a', 2, { note: 'x' }, 'notes'),
      ],
    })
    const run = await ctrl.prepare({ ...noting }, task)
    expect(run.brief).toEqual({ nth: 2 })
  })

  it('refuses a task type its project kind does not offer, naming both', async () => {
    const { ctrl, task } = harness({ kind: 'notes', taskType: 'research', pin: null })
    await expect(
      ctrl.prepare({ agentKind: 'project-researcher' } as PipelineStep, task),
    ).rejects.toMatchObject({
      details: { reason: 'task_type_not_offered_by_project', kind: 'notes', taskType: 'research' },
    })
  })

  it("never reads another task type's outcomes, so an unreadable one cannot stop a task", async () => {
    const { ctrl, task } = harness({
      kind: 'mixed',
      taskType: 'notes',
      pin: null,
      rows: [
        { ...outcomeRow('r', 1, {}), body: { kind: 'inline', json: 'not json' } },
        outcomeRow('a', 2, { note: 'x' }, 'notes'),
      ],
    })
    const run = await ctrl.prepare({ ...noting }, task)
    expect(run.brief).toEqual({ nth: 2 })
  })

  it('records the task type on the step and refuses a replay after the type changed', async () => {
    const { ctrl, task } = harness({ kind: 'mixed', taskType: 'notes', pin: null })
    const step = { ...noting }
    await ctrl.prepare(step, task)
    expect(step.project?.taskType).toBe('notes')
    Object.assign(task, { taskType: 'research' })
    await expect(
      ctrl.prepare({ ...step, agentKind: 'project-researcher' }, task),
    ).rejects.toMatchObject({ details: { reason: 'project_task_type_changed' } })
  })

  it("refuses a step under a project of another kind, and the kind's own refusal", async () => {
    const { ctrl, task } = harness({ kind: 'notes', pin: null })
    await expect(
      ctrl.prepare({ agentKind: 'project-researcher' } as PipelineStep, task),
    ).rejects.toMatchObject({ details: { reason: 'task_type_not_offered_by_project' } })
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

describe('ProjectStepController with a staged project', () => {
  const researching = { agentKind: 'project-researcher' } as PipelineStep
  const config = (id: string, question: string) => ({
    brief: `Stage ${id}.`,
    topics: [{ id: 'main', title: 'Main', questions: [{ id, question }] }],
  })
  const stages: ProjectStage[] = [
    {
      id: 'discover',
      title: 'Discover',
      taskType: 'research',
      after: [],
      consumes: [],
      produces: 'discovery',
      start: 'manual',
      checkpoint: false,
      repeatable: false,
      writes: false,
      config: config('scheme', 'Which auth scheme?'),
    },
    {
      id: 'deepen',
      title: 'Deepen',
      taskType: 'research',
      after: ['discover'],
      consumes: [],
      produces: 'deepening',
      start: 'manual',
      checkpoint: false,
      repeatable: false,
      writes: false,
      config: config('depth', 'How deep does pagination go?'),
    },
  ]
  const bound = (stageId: string): ProjectStageTask => ({
    taskId: 'task_2',
    projectId: 'prj_1',
    stageId,
    createdAt: 1,
    basis: {},
    recordedAt: null,
    clearedAt: null,
    clearedBy: null,
    acceptedOutcomeId: null,
  })

  it("plans from its stage's config and history and writes the stage's stream", async () => {
    const { ctrl, task } = harness({
      kind: 'research',
      stages,
      stageTasks: [bound('deepen')],
      rows: [outcomeRow('task_1', 1, body({ scheme: 'answered' }), 'discovery')],
    })
    const step = { ...researching }
    const run = await ctrl.prepare(step, task)
    expect(step.project).toMatchObject({
      stageId: 'deepen',
      stream: 'deepening',
      intent: 'initial',
      plan: { questionIds: ['depth'] },
    })
    expect(run.brief).toMatchObject({ brief: 'Stage depth.', priorFindings: [] })
  })

  it('refuses a task its project started from no stage', async () => {
    const { ctrl, task } = harness({ kind: 'research', stages })
    await expect(ctrl.prepare({ ...researching }, task)).rejects.toMatchObject({
      details: { reason: 'project_task_has_no_stage' },
    })
  })

  it('frees its stage when a redispatch finds the outcome landed but the stage was never told', async () => {
    const { ctrl, task, stageTasks } = harness({
      kind: 'research',
      stages,
      stageTasks: [bound('discover')],
      rows: [outcomeRow('task_2', 1, body({ scheme: 'answered' }), 'discovery')],
    })
    await expect(ctrl.prepare({ ...researching }, task)).rejects.toMatchObject({
      details: { reason: 'project_task_already_recorded' },
    })
    expect(stageTasks[0]!.recordedAt).toBe(5)
  })

  it('reads each consumed stage up to the result it started from, and records what it read', async () => {
    const reading = stages.map((s) =>
      s.id === 'deepen' ? { ...s, consumes: [{ stage: 'discover' }] } : s,
    )
    const discovered = (taskId: string): ProjectStageTask => ({
      ...bound('discover'),
      taskId,
      recordedAt: 2,
    })
    const { ctrl, task } = harness({
      kind: 'research',
      stages: reading,
      stageTasks: [
        discovered('task_1'),
        discovered('task_3'),
        { ...bound('deepen'), basis: { discover: 'pout_task_1' } },
      ],
      rows: [
        outcomeRow('task_1', 1, body({ scheme: 'answered' }), 'discovery'),
        // Recorded after the deepen task started, so it is not what that task reads.
        outcomeRow('task_3', 3, body({ scheme: 'partial' }), 'discovery'),
      ],
    })
    const step = { ...researching }
    const run = await ctrl.prepare(step, task)
    expect(run.upstream).toHaveLength(1)
    expect(run.upstream[0]).toMatchObject({
      stageId: 'discover',
      title: 'Stage Discover',
      revision: { id: 'pout_task_1', seq: 1 },
      coverage: '1 of 1 questions answered, 0 partial, 0 blocked, 0 unanswered',
    })
    expect(run.upstream[0]!.body).toContain('Research stage: Discover')
    expect(step.project?.upstream).toEqual([
      { stageId: 'discover', outcomeId: 'pout_task_1', seq: 1 },
    ])
  })

  it('states a consumed stage that had no accepted result rather than leaving it out', async () => {
    const reading = stages.map((s) =>
      s.id === 'deepen' ? { ...s, consumes: [{ stage: 'discover' }] } : s,
    )
    const { ctrl, task } = harness({
      kind: 'research',
      stages: reading,
      stageTasks: [{ ...bound('deepen'), basis: { discover: null } }],
    })
    const step = { ...researching }
    const run = await ctrl.prepare(step, task)
    expect(run.upstream).toEqual([
      expect.objectContaining({
        stageId: 'discover',
        revision: null,
        coverage: 'no accepted result',
      }),
    ])
    expect(step.project?.upstream).toEqual([{ stageId: 'discover', outcomeId: null, seq: null }])
  })

  it('refuses, naming the stage, when the result it started from cannot be read', async () => {
    const reading = stages.map((s) =>
      s.id === 'deepen' ? { ...s, consumes: [{ stage: 'discover' }] } : s,
    )
    const gone = harness({
      kind: 'research',
      stages: reading,
      stageTasks: [{ ...bound('deepen'), basis: { discover: 'pout_vanished' } }],
    })
    await expect(gone.ctrl.prepare({ ...researching }, gone.task)).rejects.toMatchObject({
      details: {
        reason: 'project_stage_upstream_unreadable',
        stageId: 'discover',
        outcomeId: 'pout_vanished',
      },
    })
    const garbled = harness({
      kind: 'mixed',
      taskType: 'research',
      stages: reading.map((s) => (s.id === 'discover' ? { ...s, taskType: 'notes' } : s)),
      stageTasks: [
        { ...bound('discover'), taskId: 'task_1', recordedAt: 2 },
        { ...bound('deepen'), basis: { discover: 'pout_task_1' } },
      ],
      rows: [{ ...outcomeRow('task_1', 1, {}, 'discovery'), taskType: 'notes' }],
    })
    await expect(garbled.ctrl.prepare({ ...researching }, garbled.task)).rejects.toMatchObject({
      details: { reason: 'project_stage_upstream_unreadable', stageId: 'discover' },
    })
  })

  it('reads no upstream on a re-attach, and keeps what the dispatch recorded', async () => {
    const reading = stages.map((s) =>
      s.id === 'deepen' ? { ...s, consumes: [{ stage: 'discover' }] } : s,
    )
    const { ctrl, task } = harness({
      kind: 'research',
      stages: reading,
      stageTasks: [{ ...bound('deepen'), basis: { discover: 'pout_vanished' } }],
    })
    const recorded = [{ stageId: 'discover', outcomeId: 'pout_task_1', seq: 1 }]
    const step = { ...researching }
    await expect(ctrl.prepare(step, task)).rejects.toBeDefined()
    step.project = { ...step.project!, upstream: recorded }
    const run = await ctrl.prepare(step, task, { reattach: true })
    expect(run.upstream).toEqual([])
    expect(step.project?.upstream).toEqual(recorded)
  })

  it("frees its stage once the outcome is recorded, on the stage's stream", async () => {
    const { ctrl, rows, task, stageTasks } = harness({
      kind: 'research',
      stages,
      stageTasks: [bound('discover')],
    })
    const step = { ...researching }
    await ctrl.prepare(step, task)
    await ctrl.record('ws_1', step, task.id, reply(body({ scheme: 'answered' })))
    expect(rows.find((r) => r.taskId === task.id)).toMatchObject({ stream: 'discovery' })
    expect(stageTasks[0]!.recordedAt).toBe(5)
  })
})
