import { SANDBOX_UNSUPPORTED_REASONS } from '@cat-factory/contracts'
import type { SandboxExperiment, SandboxFixture, SandboxPromptVersion } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// The prompt/model Sandbox surface, asserted end to end through a real store on every facade.
//
// Its own file rather than a section of `agents.ts` because it is a self-contained surface with
// its own store (prompt versions, fixtures, experiments, runs, grades) and its own admission
// rules, and because the aggregate had reached the file-size ratchet. Called from
// `defineAgentConformance`, exactly like the fragment / tool-server / task-type groups beside it,
// so it is not a top-level group a facade has to wire separately.

/**
 * The CRUD half, the catalog's two execution answers plus its admission refusals, the builtin
 * library's reconcile against the shipped catalog, and the run/grade lifecycle settling to a
 * terminal grid.
 */
export function defineSandboxConformance(harness: ConformanceHarness): void {
  describe('sandbox (prompt/model testing surface)', () => {
    it('lists baselines, clones+versions prompts, seeds fixtures and defines experiments', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/sandbox`

      // Overview seeds the builtin fixtures on first load and exposes the testable
      // agent-kind catalog + the shipped baselines (synthetic, never persisted).
      const overview = await call<{
        agentKinds: { agentKind: string }[]
        prompts: SandboxPromptVersion[]
        fixtures: SandboxFixture[]
        experiments: SandboxExperiment[]
        maxCells: number
      }>('GET', `${base}/overview`)
      expect(overview.status).toBe(200)
      expect(overview.body.agentKinds.some((k) => k.agentKind === 'requirements-review')).toBe(true)
      expect(overview.body.prompts.some((p) => p.origin === 'baseline')).toBe(true)
      expect(overview.body.fixtures.length).toBeGreaterThan(0)
      // The cell cap is surfaced so the UI gates on the SAME limit instead of re-encoding it.
      expect(overview.body.maxCells).toBeGreaterThan(0)
      const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!
      expect(fixture).toBeTruthy()

      // Clone the requirements-review baseline into an editable candidate lineage (v1).
      const cloned = await call<SandboxPromptVersion>('POST', `${base}/prompts/clone`, {
        agentKind: 'requirements-review',
        basePromptId: 'requirement-review',
        name: 'My reviewer',
      })
      expect(cloned.status).toBe(201)
      expect(cloned.body.origin).toBe('candidate')
      expect(cloned.body.version).toBe(1)
      expect(cloned.body.systemText.length).toBeGreaterThan(0)

      // Append an edited version onto the lineage (v2 on the same lineage id).
      const v2 = await call<SandboxPromptVersion>('POST', `${base}/prompts`, {
        parentId: cloned.body.id,
        systemText: `${cloned.body.systemText}\n\nAlways check authz.`,
      })
      expect(v2.status).toBe(201)
      expect(v2.body.version).toBe(2)
      expect(v2.body.lineageId).toBe(cloned.body.lineageId)

      // Both candidate versions + the baselines come back from the prompt listing.
      const prompts = await call<SandboxPromptVersion[]>('GET', `${base}/prompts`)
      expect(prompts.body.filter((p) => p.lineageId === cloned.body.lineageId)).toHaveLength(2)

      // Define a draft experiment over the baseline prompt × one model × the fixture.
      const experiment = await call<SandboxExperiment>('POST', `${base}/experiments`, {
        name: 'Reviewer shootout',
        agentKind: 'requirements-review',
        judgeModel: 'anthropic:claude-opus-4-8',
        matrix: {
          promptVersionIds: ['baseline:requirement-review'],
          models: ['anthropic:claude-opus-4-8'],
          fixtureIds: [fixture.id],
        },
      })
      expect(experiment.status).toBe(201)
      expect(experiment.body.status).toBe('draft')
      expect(experiment.body.judgeModel.length).toBeGreaterThan(0)

      // The experiment + its (still empty) result grid read back.
      const detail = await call<{
        experiment: SandboxExperiment
        runs: unknown[]
        grades: unknown[]
      }>('GET', `${base}/experiments/${experiment.body.id}`)
      expect(detail.status).toBe(200)
      expect(detail.body.experiment.id).toBe(experiment.body.id)
      expect(detail.body.runs).toHaveLength(0)
      expect(detail.body.grades).toHaveLength(0)

      // A non-runnable matrix is rejected at create time.
      const empty = await call('POST', `${base}/experiments`, {
        name: 'Bad',
        agentKind: 'requirements-review',
        matrix: { promptVersionIds: [], models: [], fixtureIds: [] },
      })
      expect(empty.status).toBeGreaterThanOrEqual(400)

      // A zero token budget is rejected at create (it would otherwise fail every cell).
      const zeroBudget = await call('POST', `${base}/experiments`, {
        name: 'No budget',
        agentKind: 'requirements-review',
        judgeModel: 'anthropic:claude-opus-4-8',
        matrix: {
          promptVersionIds: ['baseline:requirement-review'],
          models: ['anthropic:claude-opus-4-8'],
          fixtureIds: [fixture.id],
        },
        budgetTokens: 0,
      })
      expect(zeroBudget.status).toBeGreaterThanOrEqual(400)
    })

    it('states per kind whether the Sandbox can run it, and refuses a draft it cannot', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/sandbox`

      const overview = await call<{
        agentKinds: {
          agentKind: string
          bucket: string
          sandboxRun: string
          unsupportedReason: string | null
        }[]
        fixtures: SandboxFixture[]
      }>('GET', `${base}/overview`)
      expect(overview.status).toBe(200)

      // Every entry answers both execution questions, and the un-runnable ones carry the reason
      // CODE both the API refusal and the SPA's translated note are derived from. Asserted as a
      // RELATION over the catalog rather than a count, so adding a kind does not re-pin this, and
      // against the contract's own picklist so a code the SPA has no locale key for cannot ship.
      const kinds = overview.body.agentKinds
      expect(kinds.length).toBeGreaterThan(0)
      for (const kind of kinds) {
        expect(['inline', 'container']).toContain(kind.bucket)
        expect(['inline', 'unsupported']).toContain(kind.sandboxRun)
        if (kind.sandboxRun === 'unsupported') {
          expect(SANDBOX_UNSUPPORTED_REASONS as readonly string[]).toContain(kind.unsupportedReason)
        } else expect(kind.unsupportedReason).toBeNull()
      }

      // A kind the driver cannot dispatch is refused at CREATE, not left as a draft that 400s only
      // when someone tries to launch it.
      const unsupported = kinds.find((k) => k.sandboxRun === 'unsupported')
      expect(unsupported, 'the catalog should carry at least one un-runnable kind').toBeTruthy()
      const refused = await call('POST', `${base}/experiments`, {
        name: 'Container kind',
        agentKind: unsupported!.agentKind,
        judgeModel: 'anthropic:claude-opus-4-8',
        matrix: {
          promptVersionIds: [`baseline:${unsupported!.agentKind}`],
          models: ['anthropic:claude-opus-4-8'],
          fixtureIds: [overview.body.fixtures[0]!.id],
        },
      })
      expect(refused.status).toBe(422)

      // ...and so is a matrix naming a fixture that starts from a repository seed, which only the
      // launch path used to check.
      const repoFixture = await call<SandboxFixture>('POST', `${base}/fixtures`, {
        kind: 'repo-bug',
        name: 'Seeded repo',
        repoRef: { owner: 'acme', name: 'fixtures', seedRef: 'seed/bug-1' },
      })
      expect(repoFixture.status).toBe(201)
      const repoDraft = await call('POST', `${base}/experiments`, {
        name: 'Needs a checkout',
        agentKind: 'requirements-review',
        judgeModel: 'anthropic:claude-opus-4-8',
        matrix: {
          promptVersionIds: ['baseline:requirement-review'],
          models: ['anthropic:claude-opus-4-8'],
          fixtureIds: [repoFixture.body.id],
        },
      })
      expect(repoDraft.status).toBe(422)

      // ...and so is a fixture the chosen agent kind is not exercised against. The SPA filters the
      // library by the catalog's `fixtureKinds`, but the SPA is not the only caller: accepted here,
      // the cell would send the estimator's system prompt, render a requirements payload through the
      // estimator's builder, and grade the result against the `estimation` rubric using the
      // requirements fixture's expectations. Every layer behaves and the score means nothing.
      const requirementsFixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!
      const mismatched = await call('POST', `${base}/experiments`, {
        name: 'Wrong rubric',
        agentKind: 'task-estimator',
        judgeModel: 'anthropic:claude-opus-4-8',
        matrix: {
          promptVersionIds: ['baseline:task-estimator'],
          models: ['anthropic:claude-opus-4-8'],
          fixtureIds: [requirementsFixture.id],
        },
      })
      expect(mismatched.status).toBe(422)
    })

    it('reconciles the builtin fixture library against the catalog, not just on an empty one', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/sandbox`

      // Author a custom fixture BEFORE the library has ever been listed. Seeding "only when the
      // workspace has none" then never fires, which is the same state every workspace that used
      // the Sandbox before a release is in: the kinds shipped by that release are offered in the
      // builder with an empty fixture list and a permanently disabled Run button.
      const custom = await call<SandboxFixture>('POST', `${base}/fixtures`, {
        kind: 'requirements',
        name: 'Authored first',
        payload: { block: { title: 'X', type: 'service', description: 'y' } },
      })
      expect(custom.status).toBe(201)

      const overview = await call<{
        agentKinds: { agentKind: string; sandboxRun: string; fixtureKinds: string[] }[]
        fixtures: SandboxFixture[]
      }>('GET', `${base}/overview`)
      expect(overview.status).toBe(200)
      expect(overview.body.fixtures.some((f) => f.id === custom.body.id)).toBe(true)

      // The property, over the catalog rather than a fixture count: every kind the builder OFFERS
      // has something to run.
      const kinds = new Set<string>(overview.body.fixtures.map((f) => f.kind))
      for (const kind of overview.body.agentKinds) {
        if (kind.sandboxRun !== 'inline') continue
        expect(
          kind.fixtureKinds.some((k) => kinds.has(k)),
          `${kind.agentKind} is offered with no fixture to run`,
        ).toBe(true)
      }
    })

    it('drives the run/grade lifecycle to a terminal grid identically across runtimes', async () => {
      // Force the model provider ON for both runtimes (the Worker binds `AI`, Node has no
      // binding) so `launch` reaches the run-driver identically rather than 503/400-ing at
      // provider resolution on one facade only.
      const { call, createWorkspace } = harness.makeApp(undefined, {
        cloudflareModelsEnabled: true,
      })
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/sandbox`

      const overview = await call<{ fixtures: SandboxFixture[] }>('GET', `${base}/overview`)
      const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!

      // Define a 2-cell experiment against a deliberately UNCONFIGURED provider: the
      // run-driver resolves the model per cell and the resolve throws (no key wired in
      // the suite), so every candidate fails WITHOUT any network call. This exercises the
      // whole driver path — expand→persist→run→settle, plus the relaunch delete ordering
      // (grades before runs) — identically on D1 and Postgres, which the CRUD-only block
      // above never reached. A graded happy path needs a fake judge model and is a
      // tracked follow-up.
      const created = await call<SandboxExperiment>('POST', `${base}/experiments`, {
        name: 'Driver parity',
        agentKind: 'requirements-review',
        judgeModel: 'no-such-vendor:none',
        matrix: {
          promptVersionIds: ['baseline:requirement-review'],
          models: ['no-such-vendor:a', 'no-such-vendor:b'],
          fixtureIds: [fixture.id],
        },
      })
      expect(created.status).toBe(201)

      const launched = await call<{
        experiment: SandboxExperiment
        runs: { status: string; error?: string }[]
        grades: unknown[]
      }>('POST', `${base}/experiments/${created.body.id}/launch`)
      expect(launched.status).toBe(200)
      // Every candidate failed → no cell graded → the experiment settles `failed`, never
      // a misleading `done` with an unscored grid, and never stuck `running`.
      expect(launched.body.experiment.status).toBe('failed')
      expect(launched.body.runs).toHaveLength(2)
      expect(launched.body.runs.every((r) => r.status === 'failed')).toBe(true)
      expect(launched.body.grades).toHaveLength(0)

      // A relaunch replaces the grid in place rather than accumulating cells.
      const relaunched = await call<{ runs: unknown[] }>(
        'POST',
        `${base}/experiments/${created.body.id}/launch`,
      )
      expect(relaunched.status).toBe(200)
      expect(relaunched.body.runs).toHaveLength(2)

      // Two CONCURRENT launches must not duplicate the grid: the experiment's atomic claim
      // (`claimForRun`) lets exactly one win the run at a time, so whichever interleaving the
      // real store produces, the grid still settles to exactly 2 cells (never 4) — and at
      // least one launch succeeds rather than both 409-ing.
      const [first, second] = await Promise.all([
        call('POST', `${base}/experiments/${created.body.id}/launch`),
        call('POST', `${base}/experiments/${created.body.id}/launch`),
      ])
      expect([first.status, second.status].some((s) => s === 200)).toBe(true)
      const afterRace = await call<{ runs: unknown[] }>(
        'GET',
        `${base}/experiments/${created.body.id}`,
      )
      expect(afterRace.body.runs).toHaveLength(2)
    })
  })
}
