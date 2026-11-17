import type { Project, ProjectDefinition } from '@cat-factory/contracts'
import {
  ProjectKindModuleRegistry,
  eraseTaskHandler,
  type ProjectOutcomeRow,
  researchKindModule,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { projectContextContributor } from './projectContext.js'

// Linked context is rendered by the project's kind when its module renders it, and generically
// (the newest outcome of each stream, as recorded) when it does not, so a task can link a project
// of a kind the platform has never seen.

const research: Project = {
  id: 'prj_research',
  accountId: 'acc',
  kind: 'research',
  rootBlockId: 'blk_r',
  serviceIds: [],
  createdAt: 1,
}
const notes: Project = { ...research, id: 'prj_notes', kind: 'notes', rootBlockId: 'blk_n' }
const orphan: Project = { ...research, id: 'prj_orphan', rootBlockId: 'blk_o' }
const staged: Project = { ...research, id: 'prj_staged', rootBlockId: 'blk_s' }

const definition: ProjectDefinition = {
  kind: 'research',
  key: 'acme:vendor',
  version: 1,
  title: 'Vendor',
  stages: [],
  credentials: [],
  targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  inputs: [],
  promptAdditions: {},
  spec: {
    brief: 'Learn the vendor.',
    topics: [
      {
        id: 'auth',
        title: 'Auth',
        questions: [
          { id: 'scheme', question: 'Which auth scheme?' },
          { id: 'scopes', question: 'Which scopes?' },
        ],
      },
    ],
  },
}

function row(projectId: string, id: string, seq: number, body: unknown, stream = 'main') {
  const json = JSON.stringify(body)
  const outcome: ProjectOutcomeRow = {
    id,
    projectId,
    stream,
    seq,
    intent: 'initial',
    schemaVersion: 1,
    taskId: projectId === staged.id ? 'task_discover' : null,
    taskType: projectId === notes.id ? 'notes' : 'research',
    definitionKey: projectId === notes.id ? null : 'acme:vendor',
    definitionVersion: projectId === notes.id ? null : 1,
    artifactRefs: [],
    createdAt: seq,
    body: { kind: 'inline', json },
    bodyBytes: json.length,
  }
  return { row: outcome, json }
}

const notesModule = {
  kind: 'notes',
  parseSpec: (d: ProjectDefinition) => ({ ok: true as const, value: d.spec }),
  definitionSummary: (d: ProjectDefinition) => d.title,
  handlers: [
    eraseTaskHandler({
      taskType: 'notes',
      agentKind: 'note-taker',
      outcomeSchemaVersion: 1,
      parseOutcome: (_v: number, value: unknown) => value,
      planTask: () => ({ intent: 'draft', stream: 'main', plan: {} }),
      brief: () => ({}),
      mergeCheckpoint: (_a: unknown, b: unknown) => b,
      finish: ({ reply }: { reply: unknown }) => ({ body: reply, output: '' }),
      describe: () => '',
      artifactRefs: () => [],
    }),
  ],
}

const stagedDefinition: ProjectDefinition = {
  ...definition,
  key: 'acme:staged',
  stages: [
    {
      id: 'discover',
      title: 'Discover',
      taskType: 'research',
      after: [],
      consumes: [],
      produces: 'discover',
      start: 'manual',
      checkpoint: true,
      repeatable: false,
      config: definition.spec,
    },
  ],
}

const pin = (projectId: string, definitionKey: string) => ({
  projectId,
  definitionKey,
  definitionVersion: 1,
  definitionHash: 'h',
  inputs: {},
})

function contributor(bodiesRead: string[] = []) {
  const modules = new ProjectKindModuleRegistry()
  modules.register(researchKindModule)
  modules.register(notesModule)
  const stored = new Map([
    [
      research.id,
      [
        row(research.id, 'pout_1', 1, {
          summary: 'Uses OAuth.\nMore detail.',
          findings: [
            {
              questionId: 'scheme',
              status: 'answered',
              answer: 'OAuth client credentials.',
              confidence: 'high',
            },
          ],
        }),
      ],
    ],
    [orphan.id, [row(orphan.id, 'pout_o1', 1, { summary: 'Orphaned.', findings: [] })]],
    [staged.id, [row(staged.id, 'pout_s1', 1, { summary: 'Awaiting.', findings: [] }, 'discover')]],
    [
      notes.id,
      [
        row(notes.id, 'pout_n1', 1, { heading: 'Old' }),
        row(notes.id, 'pout_n2', 2, { heading: 'Decisions ```fenced```' }),
        row(notes.id, 'pout_n3', 3, { open: ['q1'] }, 'open-questions'),
      ],
    ],
  ])
  return projectContextContributor({
    records: {
      listPins: async () => [
        pin(research.id, 'acme:vendor'),
        pin(orphan.id, 'acme:gone'),
        pin(staged.id, 'acme:staged'),
      ],
      projectsWithOutcomes: async (ids) => ids.filter((id) => stored.has(id)),
      // The discover task finished and its checkpoint is still waiting for a human.
      listStageTasksOfProjects: async (ids) =>
        ids.includes(staged.id)
          ? [
              {
                taskId: 'task_discover',
                projectId: staged.id,
                stageId: 'discover',
                createdAt: 1,
                basis: {},
                recordedAt: 2,
                clearedAt: null,
                clearedBy: null,
                acceptedOutcomeId: null,
              },
            ]
          : [],
    },
    outcomes: {
      envelopesOfProjects: async (projects) =>
        new Map(projects.map((p) => [p.id, (stored.get(p.id) ?? []).map((o) => o.row)])),
      bodiesOfProjects: async (projects, rowsOf) =>
        new Map(
          projects.map((p) => {
            const rows = rowsOf.get(p.id) ?? []
            bodiesRead.push(...rows.map((r) => r.id))
            return [p.id, rows.map((r) => stored.get(p.id)!.find((o) => o.row.id === r.id)!)]
          }),
        ),
    },
    definitions: {
      get: async () => null,
      latest: async () => null,
      list: async (_account, kind) =>
        kind === 'research'
          ? [definition, stagedDefinition].map((d) => ({
              definition: d,
              contentHash: 'h',
              origin: 'registered' as const,
            }))
          : [],
    },
    modules,
  })
}

describe('projectContextContributor', () => {
  it("renders a project through its kind's own context, with the latest outcome it read", async () => {
    const rendered = (await contributor().render([research])).get(research.id)!
    expect(rendered.summary).toBe('Uses OAuth.')
    expect(rendered.coverage).toBe('1 of 2 questions answered, 0 partial, 0 blocked, 1 unanswered')
    expect(rendered.body).toContain('### Which auth scheme?')
    expect(rendered.body).toContain('OAuth client credentials.')
    expect(rendered.revision).toEqual({ id: 'pout_1', seq: 1 })
  })

  it('renders the newest outcome of each stream for a kind that renders no context', async () => {
    const rendered = (await contributor().render([notes])).get(notes.id)!
    expect(rendered.coverage).toBe('3 outcome(s) across 2 stream(s)')
    expect(rendered.body).toContain('## main (outcome 2, initial)')
    expect(rendered.body).toContain('## open-questions (outcome 3, initial)')
    expect(rendered.body).not.toContain('"Old"')
    // A fence longer than any backtick run in the body, so the body cannot close it.
    expect(rendered.body).toContain('````json')
    expect(rendered.revision).toEqual({ id: 'pout_n3', seq: 3 })
  })

  it('counts an unstaged project with any outcome as having a result', async () => {
    const empty = { ...notes, id: 'prj_empty' }
    expect(await contributor().withResult([research, notes, empty])).toEqual(
      new Set([research.id, notes.id]),
    )
  })

  it('counts no result for a staged project whose only outcome awaits its checkpoint', async () => {
    const bodiesRead: string[] = []
    const linked = contributor(bodiesRead)
    expect(await linked.withResult([staged])).toEqual(new Set())
    const rendered = (await linked.render([staged])).get(staged.id)!
    expect(rendered.body).toContain('## Stage Discover\n\nNo accepted result yet.')
    expect(rendered.revision).toBeNull()
    expect(bodiesRead).toEqual([])
  })

  it('states a definition this deployment cannot resolve, reading no body', async () => {
    const bodiesRead: string[] = []
    const rendered = (await contributor(bodiesRead).render([orphan])).get(orphan.id)!
    expect(rendered.body).toContain("pinned to definition 'acme:gone' version 1")
    expect(rendered.coverage).toBe('definition unavailable')
    expect(rendered.revision).toBeNull()
    expect(bodiesRead).toEqual([])
  })
})
