import type {
  MonorepoAdoptionExplorer,
  MonorepoAdoptionSide,
  MonorepoExplorationAnswer,
  MonorepoExplorationRequest,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { monorepoExplorationTools } from './monorepo-exploration-tools.js'

/** An explorer recording what it was asked, answering whatever the test scripted. */
function explorer(
  sides: MonorepoAdoptionSide[],
  answer: (request: MonorepoExplorationRequest) => MonorepoExplorationAnswer,
): { explorer: MonorepoAdoptionExplorer; calls: MonorepoExplorationRequest[] } {
  const calls: MonorepoExplorationRequest[] = []
  return {
    calls,
    explorer: {
      sides,
      async explore(request) {
        calls.push(request)
        return answer(request)
      },
    },
  }
}

const found = (key: string, body: string): MonorepoExplorationAnswer => ({
  outcome: 'read',
  body,
  note: null,
  key,
})

/**
 * Run one tool the way the AI SDK does, without standing up a model.
 *
 * `ToolSet`'s index signature erases each tool's own input type, so the cast is what a caller
 * reading the set back has to do; the shape it asserts is the one `pathInput` declares.
 */
type PathExecute = (input: { path: string }, options: unknown) => Promise<string>

async function run(tools: ReturnType<typeof monorepoExplorationTools>, name: string, path: string) {
  const execute = tools[name]?.execute as PathExecute | undefined
  if (!execute) throw new Error(`no tool named ${name}`)
  return await execute({ path }, { toolCallId: 't1', messages: [] })
}

describe('monorepoExplorationTools', () => {
  it('binds a tool per side, so a path can never name the wrong repository', () => {
    const { explorer: both } = explorer(['monorepo', 'template'], () => found('k', 'b'))
    expect(Object.keys(monorepoExplorationTools(both)).sort()).toEqual([
      'list_monorepo_directory',
      'list_template_directory',
      'read_monorepo_file',
      'read_template_file',
    ])
  })

  it('offers no template tools when the run has no reference template to read', async () => {
    // A capability that cannot be honoured is withheld rather than wired up to refuse: a model
    // offered a tool that can only ever answer "nothing here" spends budget learning that.
    const { explorer: monoOnly } = explorer(['monorepo'], () => found('k', 'b'))
    const tools = monorepoExplorationTools(monoOnly)
    expect(Object.keys(tools).sort()).toEqual(['list_monorepo_directory', 'read_monorepo_file'])
  })

  it('routes each tool to its own side and kind', async () => {
    const { explorer: both, calls } = explorer(['monorepo', 'template'], (request) =>
      found(`${request.side}:${request.path}`, 'body'),
    )
    const tools = monorepoExplorationTools(both)
    await run(tools, 'read_monorepo_file', 'package.json')
    await run(tools, 'list_template_directory', 'src')
    expect(calls).toEqual([
      { side: 'monorepo', kind: 'read', path: 'package.json' },
      { side: 'template', kind: 'list', path: 'src' },
    ])
  })

  it('returns the body under the exact key the model may cite', async () => {
    const { explorer: both } = explorer(['monorepo'], () =>
      found('monorepo:services/billing/package.json', '{"name":"@acme/billing"}'),
    )
    const text = await run(
      monorepoExplorationTools(both),
      'read_monorepo_file',
      'services/billing/package.json',
    )
    expect(text).toContain('### monorepo:services/billing/package.json')
    expect(text).toContain('@acme/billing')
  })

  it('says WHY there is no content, and that it is not citable', async () => {
    // "No such file", "the read failed" and "the platform refused" need three different next
    // moves from the model, and an empty string reads as the first whichever one happened.
    for (const outcome of ['absent', 'unreadable', 'refused'] as const) {
      const { explorer: one } = explorer(['monorepo'], () => ({
        outcome,
        body: '',
        note: `stated cause for ${outcome}`,
        key: null,
      }))
      const text = await run(monorepoExplorationTools(one), 'read_monorepo_file', 'nope.json')
      expect(text).toContain(`stated cause for ${outcome}`)
      expect(text).toContain('not a citable key')
    }
  })

  it('never throws into the loop when a read produces nothing', async () => {
    // A tool that threw would abort the whole generation, turning one unreadable file into a
    // survey that produced no plan at all.
    const { explorer: one } = explorer(['monorepo'], () => ({
      outcome: 'unreadable',
      body: '',
      note: null,
      key: null,
    }))
    await expect(
      run(monorepoExplorationTools(one), 'list_monorepo_directory', ''),
    ).resolves.toContain('No content')
  })
})
