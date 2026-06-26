import type { WorkspaceSnapshot } from '@cat-factory/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DrizzleDb } from '@cat-factory/node-server'
import { makeConformanceApp, setupTestDb } from './harness.js'

// The local-mode infrastructure-delegation default for the Tester: local mode runs tests
// on host Docker (in-container docker-compose / DinD) by DEFAULT — `delegateTestEnvToProvider`
// is off — so an un-pinned Tester task whose service declares no compose path / no-infra is
// refused at start with an actionable message, rather than silently defaulting to `ephemeral`
// (which would need an environment provider that local mode doesn't use by default). The
// SHARED conformance suite pins the neutral `ephemeral` default, so this facade-specific
// behavior gets its own test (built with `realLocalTesterDefault`).

describe('[local] Tester environment default', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  it('defaults an un-pinned Tester task to `local` and refuses a no-infra service at start', async () => {
    const app = makeConformanceApp(db, undefined, { realLocalTesterDefault: true })
    // Seeded workspace: `task_login` is a task under the `blk_auth` service frame, which
    // declares neither a docker-compose path nor "no infra dependencies".
    const snapshot = (await app.createWorkspace()) as WorkspaceSnapshot
    const wsId = snapshot.workspace.id

    // `pl_quick` includes a `tester` step. With the local default (`local`) and no test
    // infra configured on the service, the start-time gate refuses the run.
    const res = await app.call<{ error?: { details?: { reason?: string } } }>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: 'pl_quick' },
    )

    expect(res.status).toBe(409)
    expect(res.body.error?.details?.reason).toBe('tester_infra_unsupported')
  })
})
