import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  Block,
  RequirementReview,
} from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'
import { D1RequirementReviewRepository } from '../../src/infrastructure/repositories/D1RequirementReviewRepository'

// Once a block's requirements have been reworked ("incorporated"), that
// standard-format document — not the original description + linked docs/tasks — is
// what every agent step (and the spec-writer) consumes. These specs drive
// real executions through a recording agent to assert the substitution.

const REWORKED = '# Login — Requirements\n\n## Overview\nThe system SHALL keep sessions for 24h.'

/** Captures every context the engine hands it, so we can assert what agents see. */
class RecordingAgentExecutor implements AgentExecutor {
  readonly contexts: AgentRunContext[] = []
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    this.contexts.push(context)
    return { output: 'ok', model: 'recording', confidence: context.isFinalStep ? 1 : undefined }
  }
}

function incorporatedReview(blockId: string): RequirementReview {
  return {
    id: 'rrv_ctx',
    blockId,
    status: 'incorporated',
    model: 'mock:mock',
    incorporatedRequirements: REWORKED,
    iteration: 2,
    maxIterations: 3,
    createdAt: 1,
    updatedAt: 2,
    items: [],
  }
}

describe('reworked requirements as agent context', () => {
  it('replaces the description with the reworked text and suppresses linked docs', async () => {
    const notion = new FakeDocumentSourceProvider('notion', {
      '4242': { title: 'Rate Limiter RFC', body: 'Token bucket, 100 rps per tenant.' },
    })
    const recorder = new RecordingAgentExecutor()
    const app = makeApp(recorder, documentsDeps({ providers: [notion] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await app.call<Block>('POST', `/workspaces/${ws}/blocks/${frame.body.id}/tasks`, {
      title: 'Implement limiter',
      description: 'ORIGINAL task description',
    })

    // Link a document so we can prove it is suppressed once reworked.
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/connect`, {
      credentials: { apiToken: 'ntn_secret' },
    })
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/import`, { ref: '4242' })
    await app.call('POST', `/workspaces/${ws}/documents/link`, {
      source: 'notion',
      externalId: '4242',
      blockId: task.body.id,
    })

    // Seed an incorporated review for the task (the reworked requirements live here).
    await new D1RequirementReviewRepository({ db: env.DB }).upsert(
      ws,
      incorporatedReview(task.body.id),
    )

    const pipeline = await app.call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
      name: 'Build',
      agentKinds: ['coder'],
    })
    await app.call('POST', `/workspaces/${ws}/blocks/${task.body.id}/executions`, {
      pipelineId: pipeline.body.id,
    })
    await app.drive(ws)

    const ctx = recorder.contexts.find((c) => c.block.title === 'Implement limiter')
    expect(ctx).toBeDefined()
    // The reworked document replaces the original description…
    expect(ctx!.block.description).toBe(REWORKED)
    expect(ctx!.block.description).not.toContain('ORIGINAL task description')
    // …and the linked docs/tasks are dropped (already folded into the rework).
    expect(ctx!.block.contextDocs).toBeUndefined()
    expect(ctx!.block.contextTasks).toBeUndefined()
  })

  it('feeds the reworked text (not the description) to the spec-writer', async () => {
    const recorder = new RecordingAgentExecutor()
    const app = makeApp(recorder)
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await app.call<Block>('POST', `/workspaces/${ws}/blocks/${frame.body.id}/tasks`, {
      title: 'Implement limiter',
      description: 'ORIGINAL task description',
    })
    await new D1RequirementReviewRepository({ db: env.DB }).upsert(
      ws,
      incorporatedReview(task.body.id),
    )

    const pipeline = await app.call<{ id: string }>('POST', `/workspaces/${ws}/pipelines`, {
      name: 'Spec',
      agentKinds: ['spec-writer'],
    })
    await app.call('POST', `/workspaces/${ws}/blocks/${task.body.id}/executions`, {
      pipelineId: pipeline.body.id,
    })
    await app.drive(ws)

    const ctx = recorder.contexts.find((c) => c.agentKind === 'spec-writer')
    expect(ctx).toBeDefined()
    const aggregated = ctx!.serviceTasks ?? []
    const seeded = aggregated.find((t) => t.id === task.body.id)
    expect(seeded).toBeDefined()
    expect(seeded!.description).toBe(REWORKED)
  })
})
