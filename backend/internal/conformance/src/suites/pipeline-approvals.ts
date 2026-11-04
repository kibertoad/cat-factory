import { type Pipeline, type WorkspaceSnapshot, seedPipelines } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

/**
 * A built-in pipeline's human approval checkpoints: the one change a built-in row accepts, which
 * both stores have to persist on a row that otherwise only a reseed writes, and which the reseed
 * then has to keep (D1 ⇄ Postgres).
 */
export function registerPipelineApprovalTests(harness: ConformanceHarness): void {
  describe('pipeline approval checkpoints', () => {
    it('adds a checkpoint to a built-in, keeps it through a reseed, and refuses removing a shipped one', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id
      const complex = seedPipelines().find((p) => p.id === 'pl_complex')!
      const gates = complex.agentKinds.map((kind) => kind === 'architect-companion')
      const companion = gates.indexOf(true)
      const policies = complex.agentKinds.map((_, i) =>
        i === companion ? { approvers: { roles: ['admin'] }, minApprovals: 2 } : null,
      )

      const saved = await call<Pipeline>(
        'PUT',
        `/workspaces/${wsId}/pipelines/pl_complex/approvals`,
        {
          gates,
          policies,
        },
      )
      expect(saved.status).toBe(200)
      const reseeded = await call<Pipeline>(
        'POST',
        `/workspaces/${wsId}/pipelines/pl_complex/reseed`,
      )
      expect(reseeded.status).toBe(200)

      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const stored = snap.body.pipelines.find((p) => p.id === 'pl_complex')!
      expect(stored.builtin).toBe(true)
      expect(stored.agentKinds).toEqual(complex.agentKinds)
      expect(stored.gates).toEqual(gates)
      expect(stored.stepOptions?.[companion]?.gateConfig).toEqual({
        approvers: { roles: ['admin'] },
        minApprovals: 2,
      })

      // The catalog's own checkpoints ride the snapshot, so the builder can lock them.
      const bugfix = seedPipelines().find((p) => p.id === 'pl_bugfix')!
      expect(snap.body.pipelineCatalogApprovals?.pl_bugfix).toEqual({
        agentKinds: bugfix.agentKinds,
        gates: bugfix.gates,
      })
      const removal = await call('PUT', `/workspaces/${wsId}/pipelines/pl_bugfix/approvals`, {
        gates: bugfix.agentKinds.map(() => false),
      })
      expect(removal.status).toBe(422)
    })
  })
}
