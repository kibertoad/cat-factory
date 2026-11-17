import type { Project, ProjectStage, ProjectStageState } from '@cat-factory/contracts'
import {
  type ProjectKindModule,
  ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectTaskHandler,
  eraseTaskHandler,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { recordStageRevision } from './stageRevision.js'

interface Register {
  items: { id: string; decision: string | null }[]
}

const project: Project = {
  id: 'prj_1',
  accountId: 'acc_1',
  kind: 'deciding',
  rootBlockId: 'root_1',
  serviceIds: [],
  createdAt: 0,
}

function handler(required: boolean): ProjectTaskHandler<Register> {
  return {
    taskType: 'acme:decide',
    agentKind: 'decider',
    outcomeSchemaVersion: 1,
    parseOutcome: (_v, value) => value as Register,
    planTask: () => ({ intent: 'propose', stream: 'main', plan: {} }),
    brief: () => ({}),
    mergeCheckpoint: (_a, b) => b,
    finish: ({ reply }) => ({ body: reply, output: '' }),
    describe: () => '',
    artifactRefs: () => [],
    checkpointRevision: {
      required,
      revise: ({ body, revision }) => {
        const decided = (revision as { decisions?: Record<string, string> }).decisions ?? {}
        const missing = body.items.filter((i) => !decided[i.id]).map((i) => i.id)
        return missing.length
          ? { ok: false, issues: missing.map((id) => `${id}: undecided`) }
          : {
              ok: true,
              value: { items: body.items.map((i) => ({ ...i, decision: decided[i.id]! })) },
            }
      },
    },
  }
}

function harness(opts: { revisable?: boolean; required?: boolean } = {}) {
  const decide = handler(opts.required ?? true)
  const { checkpointRevision: _none, ...plain } = decide
  const module: ProjectKindModule = {
    kind: 'deciding',
    handlers: [eraseTaskHandler<Register>(opts.revisable === false ? plain : decide)],
    parseSpec: (d) => ({ ok: true, value: d.spec }),
    definitionSummary: (d) => d.title,
  }
  const modules = new ProjectKindModuleRegistry()
  modules.register(module)
  const proposal: Register = { items: [{ id: 'mode', decision: null }] }
  const row: ProjectOutcomeRow = {
    id: 'pout_task_1',
    projectId: project.id,
    stream: 'decisions',
    seq: 1,
    intent: 'propose',
    schemaVersion: 1,
    taskId: 'task_1',
    taskType: 'acme:decide',
    definitionKey: 'acme:deciding',
    definitionVersion: 1,
    artifactRefs: [],
    createdAt: 1,
    body: { kind: 'inline', json: JSON.stringify(proposal) },
    bodyBytes: 10,
  }
  const written: { row: Omit<ProjectOutcomeRow, 'body' | 'bodyBytes'>; json: string }[] = []
  const deps = {
    records: {
      listOutcomes: async () => [row],
      getPin: async () => ({
        projectId: project.id,
        definitionKey: 'acme:deciding',
        definitionVersion: 1,
        definitionHash: 'h',
        inputs: {},
      }),
      reserveSeq: async () => 2,
    },
    outcomes: {
      bodiesOf: async (_p: unknown, rows: readonly ProjectOutcomeRow[]) =>
        rows.map((r) => ({ row: r, json: JSON.stringify(proposal) })),
      write: async (input: {
        row: Omit<ProjectOutcomeRow, 'body' | 'bodyBytes'>
        json: string
      }) => {
        written.push({ row: input.row, json: input.json })
        return { written: true, json: input.json }
      },
    },
    modules,
    clock: { now: () => 9 },
  }
  const stage = {
    id: 'decide',
    title: 'Decide',
    taskType: 'acme:decide',
    after: [],
    consumes: [],
    produces: 'decisions',
    start: 'manual',
    checkpoint: true,
    repeatable: false,
  } as ProjectStage
  const state = {
    stageId: 'decide',
    status: 'awaiting-checkpoint',
    stale: false,
    waitingOn: [],
    activeTaskId: null,
    latest: { id: 'pout_task_1', seq: 1, taskId: 'task_1' },
    accepted: null,
  } satisfies ProjectStageState
  const run = (revision: unknown) =>
    recordStageRevision(deps, {
      workspaceId: 'ws_1',
      project,
      stage,
      state,
      revision,
      decidedBy: 'usr_1',
    })
  return { run, written }
}

describe('recordStageRevision', () => {
  it("records the person's settlement as a new revision beside the proposal", async () => {
    const h = harness()
    await h.run({ decisions: { mode: 'overwrite' } })
    expect(h.written).toHaveLength(1)
    expect(h.written[0]!.row).toMatchObject({
      id: 'pout_task_1_revised',
      stream: 'decisions',
      seq: 2,
      intent: 'revise',
      taskId: 'task_1',
      taskType: 'acme:decide',
      definitionKey: 'acme:deciding',
    })
    expect(JSON.parse(h.written[0]!.json)).toEqual({
      items: [{ id: 'mode', decision: 'overwrite' }],
    })
  })

  it('refuses an acceptance with no settlement when the task type requires one', async () => {
    await expect(harness().run(undefined)).rejects.toMatchObject({
      details: { reason: 'project_stage_revision_required', stageId: 'decide' },
    })
  })

  it('accepts as recorded when the task type takes a revision but does not require one', async () => {
    const h = harness({ required: false })
    await h.run(undefined)
    expect(h.written).toEqual([])
  })

  it('refuses a revision the task type does not take, and one that does not fit', async () => {
    await expect(harness({ revisable: false }).run({ decisions: {} })).rejects.toMatchObject({
      details: { reason: 'project_stage_revision_unsupported' },
    })
    await expect(harness().run({ decisions: {} })).rejects.toMatchObject({
      details: { reason: 'project_stage_revision_invalid', problems: ['mode: undecided'] },
    })
  })
})
