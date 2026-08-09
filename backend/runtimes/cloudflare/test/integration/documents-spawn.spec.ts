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
    expect(spawned.body.result).toEqual({ frames: 1, modules: 2, tasks: 3, reusedModules: 0 })

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

  it('plans INTO a service when frameId is given: the target is the frame, not a proposed one', async () => {
    const { app, workspaceId } = await setup()
    const frame = await app.call<Block>('POST', `/workspaces/${workspaceId}/blocks`, {
      type: 'frontend',
      position: { x: 0, y: 0 },
    })
    await app.call('PATCH', `/workspaces/${workspaceId}/blocks/${frame.body.id}`, {
      title: 'Storefront',
    })

    const planned = await app.call<DocumentBoardPlan>(
      'POST',
      `/workspaces/${workspaceId}/document-sources/notion/plan`,
      { externalId: '777', frameId: frame.body.id },
    )
    expect(planned.status).toBe(200)
    // The plan NAMES its target, which is what lets the preview say "three modules inside
    // Storefront" instead of announcing a service the spawn will not create.
    expect(planned.body.targetFrameId).toBe(frame.body.id)
    const [only] = planned.body.frames
    expect(planned.body.frames).toHaveLength(1)
    expect({ title: only!.title, type: only!.type }).toEqual({
      title: 'Storefront',
      type: 'frontend',
    })
    // The document's own h1 is consumed by the target; its h2s are the modules.
    expect(only!.modules.map((m) => m.name)).toEqual(['Invoices', 'Payments'])
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

  // The targeted plan is authored against the modules the frame already has, and its prompt asks
  // the model to REUSE those names for work that belongs in them. Until the write acted on that,
  // obeying the instruction was the thing that produced the duplicate: the plan said "Invoices"
  // and the spawn made a second module called "Invoices" beside the one it had been shown. A
  // model's cooperation is not an implementation, so the reuse is computed here.
  it('adds into a module the frame already has instead of creating a second one', async () => {
    const { app, workspaceId } = await setup()
    const frame = await app.call<Block>('POST', `/workspaces/${workspaceId}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    // Deliberately NOT the plan's exact spelling: the planner is told to reuse a name, not to
    // preserve its case, and "Invoices" beside "invoices" is a duplicate module on the board.
    const existing = await app.call<Block>(
      'POST',
      `/workspaces/${workspaceId}/blocks/${frame.body.id}/modules`,
      { name: 'invoices' },
    )

    const spawned = await app.call<{
      result: { frames: number; modules: number; tasks: number; reusedModules: number }
    }>('POST', `/workspaces/${workspaceId}/document-sources/notion/spawn`, {
      externalId: '777',
      frameId: frame.body.id,
    })
    expect(spawned.status).toBe(201)
    // One module created (Payments), one reused (invoices). A reuse is counted apart from a
    // creation rather than folded into it: it is not a block this spawn wrote.
    expect(spawned.body.result.modules).toBe(1)
    expect(spawned.body.result.reusedModules).toBe(1)

    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const blocks = snapshot.body.blocks
    const modules = blocks.filter((b: Block) => b.level === 'module')
    // The board holds two modules, not three, and the pre-existing one kept its own title.
    expect(modules.map((m: Block) => m.title).sort()).toEqual(['Payments', 'invoices'])
    // And the plan's Invoices tasks landed INSIDE the module that was already there, which is the
    // half a name-only dedupe would still get wrong.
    const inExisting = blocks
      .filter((b: Block) => b.level === 'task' && b.parentId === existing.body.id)
      .map((b: Block) => b.title)
      .sort()
    expect(inExisting).toEqual(['Create invoice', 'Void invoice'])
  })
})
