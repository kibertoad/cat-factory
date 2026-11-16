import type { Project, ProjectDefinition } from '@cat-factory/contracts'
import {
  type ProjectKindModule,
  ProjectKindModuleRegistry,
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

const definition: ProjectDefinition = {
  kind: 'research',
  key: 'acme:vendor',
  version: 1,
  title: 'Vendor',
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
    taskId: null,
    definitionKey: projectId === research.id ? 'acme:vendor' : null,
    definitionVersion: projectId === research.id ? 1 : null,
    artifactRefs: [],
    createdAt: seq,
    body: { kind: 'inline', json },
    bodyBytes: json.length,
  }
  return { row: outcome, json }
}

const notesModule: ProjectKindModule<unknown> = {
  kind: 'notes',
  agentKind: 'note-taker',
  outcomeSchemaVersion: 1,
  parseSpec: (d) => ({ ok: true, value: d.spec }),
  parseOutcome: (_v, value) => value,
  planTask: () => ({ intent: 'draft', stream: 'main', plan: {} }),
  brief: () => ({}),
  mergeCheckpoint: (_a, b) => b,
  finish: ({ reply }) => ({ body: reply, output: '' }),
  describe: () => '',
  artifactRefs: () => [],
  definitionSummary: (d) => d.title,
}

function contributor() {
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
        {
          projectId: research.id,
          definitionKey: 'acme:vendor',
          definitionVersion: 1,
          definitionHash: 'h',
          inputs: {},
        },
      ],
      projectsWithOutcomes: async (ids) => ids.filter((id) => stored.has(id)),
    },
    outcomes: { listOfProjects: async () => stored },
    definitions: {
      get: async () => null,
      latest: async () => null,
      list: async (_account, kind) =>
        kind === 'research'
          ? [{ definition, contentHash: 'h', origin: 'registered' as const }]
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

  it('counts a project with any outcome as having a result', async () => {
    const empty = { ...notes, id: 'prj_empty' }
    expect(await contributor().withResult([research, notes, empty])).toEqual(
      new Set([research.id, notes.id]),
    )
  })
})
