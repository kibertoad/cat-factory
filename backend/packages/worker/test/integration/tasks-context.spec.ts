import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { tasksDeps, makeApp } from '../helpers'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'

/** Captures every context the engine hands it, so we can assert what agents see. */
class RecordingAgentExecutor implements AgentExecutor {
  readonly contexts: AgentRunContext[] = []
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    this.contexts.push(context)
    return { output: 'ok', model: 'recording', confidence: context.isFinalStep ? 1 : undefined }
  }
}

describe('task context injection', () => {
  it('feeds a linked issue to the agent running the block', async () => {
    const jira = new FakeTaskSourceProvider('jira', {
      'PROJ-9': {
        title: 'Rate limiter',
        status: 'In Progress',
        type: 'Story',
        assignee: 'Jane Doe',
        description: 'Token bucket, 100 rps per tenant.',
        comments: [{ author: 'John', createdAt: '2026-06-10T09:00:00.000Z', body: 'use Redis' }],
      },
    })
    const recorder = new RecordingAgentExecutor()
    const app = makeApp(recorder, tasksDeps({ providers: [jira] }))
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

    // Connect, import the issue and attach it to the task as context.
    await app.call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 't' },
    })
    await app.call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-9' })
    const linked = await app.call('POST', `/workspaces/${ws}/tasks/link`, {
      source: 'jira',
      externalId: 'PROJ-9',
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
    expect(ctx!.block.contextTasks).toBeDefined()
    const issue = ctx!.block.contextTasks!.find((t) => t.key === 'PROJ-9')
    expect(issue).toBeDefined()
    expect(issue!.status).toBe('In Progress')
    expect(issue!.assignee).toBe('Jane Doe')
    expect(issue!.description).toContain('Token bucket')
    expect(issue!.comments.map((c) => c.body)).toContain('use Redis')
  })
})
