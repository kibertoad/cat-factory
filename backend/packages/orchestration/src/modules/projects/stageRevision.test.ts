import type { Project, ProjectStage, ProjectStageState } from '@cat-factory/contracts'
import {
  type ProjectKindModule,
  ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectTaskHandler,
  eraseTaskHandler,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { settleStageRevision } from './stageRevision.js'

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

function row(id: string, seq: number, intent: string, body: Register): ProjectOutcomeRow {
  return {
    id,
    projectId: project.id,
    stream: 'decisions',
    seq,
    intent,
    schemaVersion: 1,
    taskId: 'task_1',
    taskType: 'acme:decide',
    definitionKey: 'acme:deciding',
    definitionVersion: 1,
    artifactRefs: [],
    createdAt: seq,
    body: { kind: 'inline', json: JSON.stringify(body) },
    bodyBytes: 10,
  }
}

function harness(
  opts: { revisable?: boolean; required?: boolean; envelopes?: ProjectOutcomeRow[] } = {},
) {
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
  const proposal = row('pout_task_1', 1, 'propose', { items: [{ id: 'mode', decision: null }] })
  const envelopes = opts.envelopes ?? [proposal]
  const written: { row: Omit<ProjectOutcomeRow, 'body' | 'bodyBytes'>; json: string }[] = []
  const stored = (r: ProjectOutcomeRow) => ({
    row: r,
    json: r.body.kind === 'inline' ? r.body.json : '',
  })
  const deps = {
    records: {
      getPin: async () => ({
        projectId: project.id,
        definitionKey: 'acme:deciding',
        definitionVersion: 1,
        definitionHash: 'h',
        inputs: {},
      }),
      reserveSeq: async () => 7,
    },
    outcomes: {
      get: async (_p: unknown, id: string) => (id === proposal.id ? stored(proposal) : null),
      bodiesOf: async (_p: unknown, rows: readonly ProjectOutcomeRow[]) => rows.map(stored),
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
    latest: { id: proposal.id, seq: 1, taskId: 'task_1' },
    accepted: null,
    acceptance: null,
  } satisfies ProjectStageState
  const settle = (revision: unknown) =>
    settleStageRevision(deps, {
      homeWorkspaceId: 'ws_home',
      project,
      stage,
      state,
      envelopes,
      revision,
      decidedBy: 'usr_1',
    })
  return { settle, written }
}

describe('settleStageRevision', () => {
  it("writes the person's settlement as a revision and names it for the acceptance", async () => {
    const h = harness()
    expect(await h.settle({ decisions: { mode: 'overwrite' } })).toBe('pout_task_1_rev7')
    expect(h.written[0]!.row).toMatchObject({
      id: 'pout_task_1_rev7',
      stream: 'decisions',
      seq: 7,
      intent: 'revise',
      taskId: 'task_1',
      taskType: 'acme:decide',
    })
    expect(JSON.parse(h.written[0]!.json)).toEqual({
      items: [{ id: 'mode', decision: 'overwrite' }],
    })
  })

  it('reuses a revision a retried acceptance already wrote with the same settlement', async () => {
    const earlier = row('pout_task_1_rev3', 3, 'revise', {
      items: [{ id: 'mode', decision: 'overwrite' }],
    })
    const h = harness({
      envelopes: [
        row('pout_task_1', 1, 'propose', { items: [{ id: 'mode', decision: null }] }),
        earlier,
      ],
    })
    expect(await h.settle({ decisions: { mode: 'overwrite' } })).toBe('pout_task_1_rev3')
    expect(h.written).toEqual([])
  })

  it('accepts as recorded with no settlement (null too) when none is required', async () => {
    const h = harness({ required: false })
    expect(await h.settle(undefined)).toBeNull()
    expect(await h.settle(null)).toBeNull()
    expect(h.written).toEqual([])
  })

  it('refuses a missing, unsupported or misfitting settlement before writing anything', async () => {
    await expect(harness().settle(null)).rejects.toMatchObject({
      details: { reason: 'project_stage_revision_required', stageId: 'decide' },
    })
    await expect(harness({ revisable: false }).settle({ decisions: {} })).rejects.toMatchObject({
      details: { reason: 'project_stage_revision_unsupported' },
    })
    const misfit = harness()
    await expect(misfit.settle({ decisions: {} })).rejects.toMatchObject({
      message: expect.stringContaining('mode: undecided'),
      details: { reason: 'project_stage_revision_invalid', problems: ['mode: undecided'] },
    })
    expect(misfit.written).toEqual([])
  })
})
