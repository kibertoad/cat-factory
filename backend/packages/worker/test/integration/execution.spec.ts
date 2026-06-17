import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

describe('execution engine', () => {
  it('runs a task pipeline to auto-merge and materialises its module', async () => {
    const app = makeApp(new FakeAgentExecutor({ confidence: 1 }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: 'pl_quick' },
    )
    expect(start.status).toBe(201)
    expect(start.body.status).toBe('running')

    const ticked = await app.drive(wsId)
    const exec = ticked.find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('done')
    expect(exec.steps.every((s) => s.state === 'done')).toBe(true)
    expect(exec.steps[0]!.output).toContain('[coder]')
    expect(exec.steps[0]!.model).toBe('fake')

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    const task = snap.blocks.find((b) => b.id === 'task_login')!
    expect(task.status).toBe('done')
    expect(task.confidence).toBe(1)
    // task_login is assigned to the existing "Sessions" module → moved inside it.
    expect(task.parentId).toBe('mod_sessions')
  })

  it('opens a PR when confidence is below threshold, then merges on demand', async () => {
    const app = makeApp(new FakeAgentExecutor({ confidence: 0.5 }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_quick',
    })
    await app.drive(wsId)

    let task = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body.blocks.find(
      (b) => b.id === 'task_login',
    )!
    expect(task.status).toBe('pr_ready')
    expect(task.confidence).toBe(0.5)

    const merge = await app.call<{ status: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/merge`,
    )
    expect(merge.status).toBe(200)
    expect(merge.body.status).toBe('done')
  })

  it('records the PR the implementer agent opened on the block', async () => {
    const pullRequest = {
      url: 'https://github.com/octo/app/pull/7',
      number: 7,
      branch: 'cat-factory/task_login-abcd1234',
    }
    const app = makeApp(new FakeAgentExecutor({ confidence: 0.5, pullRequest }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_quick',
    })
    await app.drive(wsId)

    const task = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body.blocks.find(
      (b) => b.id === 'task_login',
    )!
    expect(task.status).toBe('pr_ready')
    expect(task.pullRequest).toEqual(pullRequest)
  })

  it('rejects merging a block with no open PR', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace()
    const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/merge`)
    expect(res.status).toBe(409)
  })

  it('pauses for a human decision and resumes after it is resolved', async () => {
    const app = makeApp(new FakeAgentExecutor({ decisionOnSteps: [0], confidence: 1 }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_quick',
    })

    const blocked = await app.drive(wsId)
    const exec = blocked.find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('blocked')
    const step = exec.steps[0]!
    expect(step.state).toBe('waiting_decision')
    expect(step.decision).toBeTruthy()

    const taskBlocked = (
      await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    ).body.blocks.find((b) => b.id === 'task_login')!
    expect(taskBlocked.status).toBe('blocked')

    const choice = step.decision!.options[0]!
    const resolve = await app.call(
      'POST',
      `/workspaces/${wsId}/executions/${exec.id}/decisions/${step.decision!.id}`,
      { choice },
    )
    expect(resolve.status).toBe(200)

    const resumed = await app.drive(wsId)
    const finished = resumed.find((e) => e.blockId === 'task_login')!
    expect(finished.status).toBe('done')
    expect(finished.steps[0]!.decision!.chosen).toBe(choice)
  })

  it('runs a pipeline on a frame straight to done', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/blk_api/executions`, {
      pipelineId: 'pl_quick',
    })
    await app.drive(wsId)

    const block = (
      await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    ).body.blocks.find((b) => b.id === 'blk_api')!
    expect(block.status).toBe('done')
  })

  it('cancels a running execution and resets the block', async () => {
    const app = makeApp()
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/blocks/blk_api/executions`, {
      pipelineId: 'pl_full',
    })
    const cancel = await app.call<{ status: string }>(
      'DELETE',
      `/workspaces/${wsId}/blocks/blk_api/executions`,
    )
    expect(cancel.status).toBe(200)
    expect(cancel.body.status).toBe('planned')

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    expect(snap.executions.find((e) => e.blockId === 'blk_api')).toBeUndefined()
  })
})
