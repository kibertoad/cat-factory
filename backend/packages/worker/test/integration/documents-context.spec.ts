import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'

/** Captures every context the engine hands it, so we can assert what agents see. */
class RecordingAgentExecutor implements AgentExecutor {
  readonly contexts: AgentRunContext[] = []
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    this.contexts.push(context)
    return { output: 'ok', model: 'recording', confidence: context.isFinalStep ? 1 : undefined }
  }
}

describe('document context injection', () => {
  it('feeds a linked document to the agent running the block', async () => {
    const notion = new FakeDocumentSourceProvider('notion', {
      '4242': { title: 'Rate Limiter RFC', body: 'Token bucket, 100 rps per tenant.' },
    })
    const recorder = new RecordingAgentExecutor()
    const app = makeApp(recorder, documentsDeps({ providers: [notion] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    // A frame with a task to run a pipeline against.
    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await app.call<Block>('POST', `/workspaces/${ws}/blocks/${frame.body.id}/tasks`, {
      title: 'Implement limiter',
    })

    // Connect, import the RFC and attach it to the task as context.
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/connect`, {
      credentials: { apiToken: 'ntn_secret' },
    })
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/import`, { ref: '4242' })
    const linked = await app.call('POST', `/workspaces/${ws}/documents/link`, {
      source: 'notion',
      externalId: '4242',
      blockId: task.body.id,
    })
    expect(linked.status).toBe(201)

    // Run a one-step pipeline on the task and drive it to completion.
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
    expect(ctx!.block.contextDocs).toBeDefined()
    expect(ctx!.block.contextDocs!.map((d) => d.title)).toContain('Rate Limiter RFC')
    expect(ctx!.block.contextDocs![0]!.excerpt).toContain('Token bucket')
  })
})
