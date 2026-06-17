import type { Block, DocumentBoardPlan, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'

const notionCreds = { apiToken: 'ntn_secret' }

// A page whose Markdown heading outline maps to one service, two modules and
// three tasks. Providers normalize bodies to Markdown, so the planner is
// source-agnostic — this exercises a Notion document.
const BILLING_BODY = [
  '# Billing Service',
  '## Invoices',
  '### Create invoice',
  '### Void invoice',
  '## Payments',
  '### Charge card',
].join('\n')

async function setup() {
  const notion = new FakeDocumentSourceProvider('notion', {
    '777': { title: 'Billing PRD', body: BILLING_BODY },
  })
  const app = makeApp(new FakeAgentExecutor(), documentsDeps({ providers: [notion] }))
  const { workspace } = await app.createWorkspace({ seed: false })
  await app.call('POST', `/workspaces/${workspace.id}/document-sources/notion/connect`, {
    credentials: notionCreds,
  })
  await app.call('POST', `/workspaces/${workspace.id}/document-sources/notion/import`, {
    ref: '777',
  })
  return { app, workspaceId: workspace.id }
}

describe('document spawn', () => {
  it('plans the heading outline deterministically when no LLM is configured', async () => {
    const { app, workspaceId } = await setup()
    const planned = await app.call<DocumentBoardPlan>(
      'POST',
      `/workspaces/${workspaceId}/document-sources/notion/plan`,
      { externalId: '777' },
    )
    expect(planned.status).toBe(200)
    expect(planned.body.source).toBe('notion')
    expect(planned.body.planner).toBe('headings')
    expect(planned.body.frames).toHaveLength(1)
    const frame = planned.body.frames[0]!
    expect(frame.title).toBe('Billing Service')
    expect(frame.modules.map((m) => m.name)).toEqual(['Invoices', 'Payments'])
    expect(frame.modules[0]!.tasks.map((t) => t.title)).toEqual(['Create invoice', 'Void invoice'])
  })

  it('spawns the planned structure as new board blocks', async () => {
    const { app, workspaceId } = await setup()
    const spawned = await app.call<{ result: { frames: number; modules: number; tasks: number } }>(
      'POST',
      `/workspaces/${workspaceId}/document-sources/notion/spawn`,
      { externalId: '777' },
    )
    expect(spawned.status).toBe(201)
    expect(spawned.body.result).toEqual({ frames: 1, modules: 2, tasks: 3 })

    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const blocks = snapshot.body.blocks
    const frames = blocks.filter((b: Block) => b.level === 'frame')
    const modules = blocks.filter((b: Block) => b.level === 'module')
    const tasks = blocks.filter((b: Block) => b.level === 'task')
    expect(frames.map((b: Block) => b.title)).toEqual(['Billing Service'])
    expect(modules.map((b: Block) => b.title).sort()).toEqual(['Invoices', 'Payments'])
    expect(tasks.map((b: Block) => b.title).sort()).toEqual([
      'Charge card',
      'Create invoice',
      'Void invoice',
    ])
  })

  it('spawns modules and tasks into an existing frame when frameId is given', async () => {
    const { app, workspaceId } = await setup()
    const frame = await app.call<Block>('POST', `/workspaces/${workspaceId}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })

    const spawned = await app.call(
      'POST',
      `/workspaces/${workspaceId}/document-sources/notion/spawn`,
      {
        externalId: '777',
        frameId: frame.body.id,
      },
    )
    expect(spawned.status).toBe(201)

    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const blocks = snapshot.body.blocks
    // No new frame was created; the modules hang off the existing one.
    expect(blocks.filter((b: Block) => b.level === 'frame')).toHaveLength(1)
    const modules = blocks.filter((b: Block) => b.level === 'module')
    expect(modules.every((m: Block) => m.parentId === frame.body.id)).toBe(true)
    expect(modules).toHaveLength(2)
  })
})
