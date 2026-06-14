import type { Block, ConfluenceBoardPlan, WorkspaceSnapshot } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { confluenceDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeConfluenceClient } from '../fakes/FakeConfluenceClient'

const creds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

// A page whose heading outline maps to one service, two modules and three tasks.
const BILLING_BODY =
  '<h1>Billing Service</h1>' +
  '<h2>Invoices</h2><h3>Create invoice</h3><h3>Void invoice</h3>' +
  '<h2>Payments</h2><h3>Charge card</h3>'

async function setup() {
  const client = new FakeConfluenceClient({
    '777': { title: 'Billing PRD', body: BILLING_BODY },
  })
  const app = makeApp(new FakeAgentExecutor(), confluenceDeps({ client }))
  const { workspace } = await app.createWorkspace({ seed: false })
  await app.call('POST', `/workspaces/${workspace.id}/confluence/connect`, creds)
  await app.call('POST', `/workspaces/${workspace.id}/confluence/import`, { page: '777' })
  return { app, workspaceId: workspace.id }
}

describe('confluence spawn', () => {
  it('plans the heading outline deterministically when no LLM is configured', async () => {
    const { app, workspaceId } = await setup()
    const planned = await app.call<ConfluenceBoardPlan>(
      'POST',
      `/workspaces/${workspaceId}/confluence/plan`,
      { pageId: '777' },
    )
    expect(planned.status).toBe(200)
    expect(planned.body.source).toBe('headings')
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
      `/workspaces/${workspaceId}/confluence/spawn`,
      { pageId: '777' },
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

    const spawned = await app.call('POST', `/workspaces/${workspaceId}/confluence/spawn`, {
      pageId: '777',
      frameId: frame.body.id,
    })
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
