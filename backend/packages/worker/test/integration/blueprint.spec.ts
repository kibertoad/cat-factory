import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// The `blueprints` pipeline step: after the engine runs it, the decomposition
// tree it returns is strictly validated and reconciled onto the run block's
// service frame — in place, by name, without deleting existing blocks. Driven
// here with the fake executor (which stands in for the container Blueprinter), so
// the engine's ingest + reconcile is asserted without GitHub or a real container.

const tree = {
  type: 'service',
  name: 'Auth',
  summary: 'Authentication service.',
  references: ['package.json'],
  modules: [
    {
      name: 'Telemetry',
      summary: 'Metrics + tracing.',
      references: ['src/telemetry', 'src/telemetry/metrics.ts'],
    },
  ],
}

describe('blueprint pipeline step', () => {
  it('reconciles the returned tree onto the service frame without deleting existing blocks', async () => {
    const app = makeApp(new FakeAgentExecutor({ confidence: 1, blueprintService: tree }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    // pl_quick is coder → blueprints → tester; task_login sits under frame blk_auth.
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: 'pl_quick' },
    )
    expect(start.status).toBe(201)

    await app.drive(wsId)

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body

    // The blueprint's module was materialised under the service frame, carrying its
    // code references in the description (the map tracks services and modules only —
    // no feature-level tasks are auto-created).
    const telemetry = snap.blocks.find(
      (b) => b.parentId === 'blk_auth' && b.level === 'module' && b.title === 'Telemetry',
    )
    expect(telemetry).toBeTruthy()
    expect(telemetry!.description).toContain('src/telemetry/metrics.ts')

    // Existing structure is untouched (reconcile never deletes).
    expect(snap.blocks.find((b) => b.id === 'mod_sessions')).toBeTruthy()
    expect(snap.blocks.find((b) => b.id === 'task_login')).toBeTruthy()
  })

  it('is idempotent: re-running the blueprint adds no duplicate modules', async () => {
    const app = makeApp(new FakeAgentExecutor({ confidence: 1, blueprintService: tree }))
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    for (let i = 0; i < 2; i++) {
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: 'pl_quick',
      })
      await app.drive(wsId)
    }

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    const telemetry = snap.blocks.filter(
      (b) => b.parentId === 'blk_auth' && b.level === 'module' && b.title === 'Telemetry',
    )
    expect(telemetry).toHaveLength(1)
  })
})
