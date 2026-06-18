import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { DEFAULT_SPEND_PRICING } from '@cat-factory/spend'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// A budget so small the very first metered call exhausts it.
const TINY_BUDGET = { ...DEFAULT_SPEND_PRICING, monthlyLimit: 0.000001 }
// A budget large enough that nothing ever pauses.
const HUGE_BUDGET = { ...DEFAULT_SPEND_PRICING, monthlyLimit: 1_000_000 }

describe('spend safeguards', () => {
  it('tracks input and output token usage in the snapshot', async () => {
    const agent = new FakeAgentExecutor({ usage: { inputTokens: 100, outputTokens: 50 } })
    const app = makeApp(agent, { spendPricing: HUGE_BUDGET })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_quick', // two steps
    })
    await app.drive(wsId)

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    expect(snap.spend).toBeTruthy()
    // Two steps × (100 input, 50 output). The ledger is org-wide and the test DB
    // is shared, so assert "at least" rather than an exact total.
    expect(snap.spend!.inputTokens).toBeGreaterThanOrEqual(200)
    expect(snap.spend!.outputTokens).toBeGreaterThanOrEqual(100)
    expect(snap.spend!.costSpent).toBeGreaterThan(0)
    expect(snap.spend!.currency).toBe('EUR')
    expect(snap.spend!.exceeded).toBe(false)
  })

  it('pauses execution and flags the snapshot once the budget is exceeded', async () => {
    const agent = new FakeAgentExecutor({ usage: { inputTokens: 1000, outputTokens: 1000 } })
    const app = makeApp(agent, { spendPricing: TINY_BUDGET })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/blk_api/executions`, {
      pipelineId: 'pl_quick', // multi-step, ungated (pl_full now has approval gates)
    })
    const ticked = await app.drive(wsId)

    const exec = ticked.find((e) => e.blockId === 'blk_api')!
    // Once the budget is exhausted the run pauses with steps still outstanding.
    // (Exactly when it pauses depends on prior spend in the shared org-wide
    // ledger, so we only assert it paused without finishing.)
    expect(exec.status).toBe('paused')
    expect(exec.steps.some((s) => s.state !== 'done')).toBe(true)

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    expect(snap.spend!.exceeded).toBe(true)
  })

  it('resumes paused runs once the budget frees up', async () => {
    // First app pauses the run under a tiny budget.
    const pausingAgent = new FakeAgentExecutor({ usage: { inputTokens: 1000, outputTokens: 1000 } })
    const pausingApp = makeApp(pausingAgent, { spendPricing: TINY_BUDGET })
    const { workspace } = await pausingApp.createWorkspace()
    const wsId = workspace.id

    await pausingApp.call('POST', `/workspaces/${wsId}/blocks/blk_api/executions`, {
      pipelineId: 'pl_quick',
    })
    await pausingApp.drive(wsId)

    // A second app over the same DB has a generous budget, so it can resume.
    const freeAgent = new FakeAgentExecutor({ usage: { inputTokens: 1, outputTokens: 1 } })
    const freeApp = makeApp(freeAgent, { spendPricing: HUGE_BUDGET })

    const resumed = await freeApp.call<ExecutionInstance[]>(
      'POST',
      `/workspaces/${wsId}/spend/resume`,
    )
    expect(resumed.status).toBe(200)
    expect(resumed.body.find((e) => e.blockId === 'blk_api')!.status).toBe('running')

    // Driving now advances the resumed run to completion.
    await freeApp.drive(wsId)
    const block = (
      await freeApp.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    ).body.blocks.find((b) => b.id === 'blk_api')!
    expect(block.status).toBe('done')
  })

  it('exposes spend status on its own endpoint', async () => {
    const app = makeApp(new FakeAgentExecutor(), { spendPricing: HUGE_BUDGET })
    const { workspace } = await app.createWorkspace()
    const spend = await app.call<{ costLimit: number; currency: string }>(
      'GET',
      `/workspaces/${workspace.id}/spend`,
    )
    expect(spend.status).toBe(200)
    expect(spend.body.costLimit).toBe(1_000_000)
    expect(spend.body.currency).toBe('EUR')
  })
})
