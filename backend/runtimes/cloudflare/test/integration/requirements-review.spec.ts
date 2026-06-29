import type { Block, RequirementReview } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'
import { D1RequirementReviewRepository } from '../../src/infrastructure/repositories/D1RequirementReviewRepository'

// The requirements reviewer's HTTP surface for the deterministic (non-LLM) paths:
// reading the current review, answering / settling items, and the incorporate
// gate. The review/incorporate generation paths call an LLM through the model
// provider (faked elsewhere only via the AgentExecutor port), so here we seed a
// review directly through its D1 repository — the same one the worker wires — and
// drive the mutations the human performs.

function seedReview(workspaceId: string, blockId: string): RequirementReview {
  return {
    id: 'rrv_test',
    blockId,
    status: 'ready',
    model: 'mock:mock',
    incorporatedRequirements: null,
    iteration: 1,
    maxIterations: 3,
    recommendations: [],
    createdAt: 1,
    updatedAt: 1,
    items: [
      {
        id: 'rri_1',
        category: 'gap',
        severity: 'high',
        title: 'Token expiry?',
        detail: 'How long do sessions last?',
        status: 'open',
        reply: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'rri_2',
        category: 'risk',
        severity: 'low',
        title: 'Brute force?',
        detail: 'Any lockout policy?',
        status: 'open',
        reply: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
}

async function setup() {
  const app = makeApp()
  const { workspace } = await app.createWorkspace({ seed: false })
  const ws = workspace.id
  const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
    type: 'service',
    position: { x: 0, y: 0 },
  })
  const blockId = frame.body.id
  const repo = new D1RequirementReviewRepository({ db: env.DB })
  await repo.upsert(ws, seedReview(ws, blockId))
  return { app, ws, blockId }
}

describe('requirements review HTTP surface', () => {
  it('returns the current review for a block', async () => {
    const { app, ws, blockId } = await setup()
    const res = await app.call<RequirementReview>(
      'GET',
      `/workspaces/${ws}/blocks/${blockId}/requirement-review`,
    )
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('rrv_test')
    expect(res.body.items).toHaveLength(2)
  })

  it('records an answer and flips the item to answered', async () => {
    const { app, ws } = await setup()
    const res = await app.call<RequirementReview>(
      'POST',
      `/workspaces/${ws}/requirement-reviews/rrv_test/items/rri_1/reply`,
      { reply: '24 hours' },
    )
    expect(res.status).toBe(200)
    const item = res.body.items.find((i) => i.id === 'rri_1')!
    expect(item.reply).toBe('24 hours')
    expect(item.status).toBe('answered')
  })

  it('settles an item via the status endpoint', async () => {
    const { app, ws } = await setup()
    const res = await app.call<RequirementReview>(
      'PATCH',
      `/workspaces/${ws}/requirement-reviews/rrv_test/items/rri_2`,
      { status: 'dismissed' },
    )
    expect(res.status).toBe(200)
    expect(res.body.items.find((i) => i.id === 'rri_2')!.status).toBe('dismissed')
  })

  it('gates incorporation until every item is settled', async () => {
    const { app, ws, blockId } = await setup()
    // One item still open → incorporate is rejected with a validation error. Send the empty
    // JSON body the real client sends (`{}`); the contract requires a JSON body, so the guard
    // (422) is what we're asserting, not the empty-body request rejection (400).
    const blocked = await app.call(
      'POST',
      `/workspaces/${ws}/blocks/${blockId}/requirement-review/incorporate`,
      {},
    )
    expect(blocked.status).toBe(422)
    expect(JSON.stringify(blocked.body)).toContain('Answer or dismiss')
  })

  it('reports a missing item as a validation error', async () => {
    const { app, ws } = await setup()
    const res = await app.call(
      'POST',
      `/workspaces/${ws}/requirement-reviews/rrv_test/items/nope/reply`,
      { reply: 'x' },
    )
    expect(res.status).toBe(422)
  })
})
