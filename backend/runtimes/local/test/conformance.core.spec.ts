import { type ConformanceHarness, defineCoreConformance } from '@cat-factory/conformance'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from '@cat-factory/contracts'
import { makeConformanceApp, setupTestDb } from './harness.js'

// One slice of the shared cross-runtime conformance suite against the LOCAL facade (built
// through buildLocalContainer over real Postgres). Split into per-group spec files so they
// run in parallel across vitest workers, each on its own per-worker database.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineCoreConformance(harness)

  // Local-facade regression guard for the infra-setup projection: local mode ALWAYS wires the
  // runner-pool surface (ENCRYPTION_KEY is always set) yet runs agents in per-run HOST containers,
  // so the "agent executor not configured" banner must NOT fire — the `agentExecutorRequiresRunnerPool`
  // gate keeps this `not_applicable` rather than the false-positive `not_defined` a bare
  // `!!container.runners` check produced. The shared suite only pins "valid enum", so assert the
  // exact value here where it's deterministic.
  describe('[local] infra-setup agent-executor area', () => {
    it('is not_applicable (agents run in host containers, the runner pool is optional)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snap.body.infraSetup?.agentExecutor).toBe('not_applicable')
    })
  })

  // Local-facade regression guard for the ephemeral-environments area: local mode ALWAYS wires the
  // environment integration (ENCRYPTION_KEY is always set) yet the Docker-family runtime the test
  // harness targets advertises `local-compose` as a zero-config test-env default, so a missing
  // ephemeral-environment PROVIDER connection must NOT nag "test environment not configured" — the
  // `ephemeralEnvironmentsRequireProvider` gate keeps this `not_applicable` rather than the
  // false-positive `not_defined` a bare `!!container.environments` check produced.
  describe('[local] infra-setup ephemeral-environments area', () => {
    it('is not_applicable (docker-compose is the zero-config default, no provider required)', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace({ seed: false })
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snap.body.infraSetup?.ephemeralEnvironments).toBe('not_applicable')
    })
  })
} else {
  describe.skip('[local] conformance core (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
