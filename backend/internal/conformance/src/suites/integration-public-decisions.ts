import type { ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the PUBLIC parked-decision surface (`/api/v1/runs/:runId/…`) and
// the intake-origin marker that slice 2 keys off.
//
// The clarification loop was previously SPA-only, so a headless (`/api/v1`) run could not include
// it at all — the public surface refused any pipeline that could park. These assertions pin the
// relaxation and its answerer on BOTH facades, because everything the loop touches is per-runtime:
// the review store (D1 ⇄ Drizzle), the run `detail` JSON that carries `intakeOrigin`, and the
// controller wiring. A facade that mounts the decision routes but forgets the review store — or
// persists `intakeOrigin` on one runtime only — fails here instead of shipping divergent behaviour.
//
// See docs/initiatives/headless-clarification-loop.md.

/** Mint a public-API key of the given scope and return its bearer header. */
async function mintKey(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

export function definePublicDecisionsConformance(harness: ConformanceHarness): void {
  describe('public API — parked decisions', () => {
    it('reports headless-startability on pipeline discovery', async () => {
      // The admission POLICY itself (inline-only is absolute; parking is a `decide`-scope question)
      // is pure shared-controller logic that cannot drift between facades, and the built-in public
      // pipeline is READ-ONLY — so there is no way to build a public-and-parking pipeline over HTTP.
      // The policy is unit-tested in `publicApiAdmission.test.ts`. What belongs HERE is that each
      // facade wires the agent-kind registry the flag is computed against: a facade with a
      // mis-wired registry would report every pipeline as non-startable (or, worse, report a
      // container pipeline as headless-startable) while the pure logic stayed green.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, workspace.id, 'read')

      const listed = await app.call<{
        pipelines: { pipelineId: string; public: boolean; headlessStartable: boolean }[]
      }>('GET', '/api/v1/pipelines', undefined, auth)
      expect(listed.status).toBe(200)

      // The built-in public pipeline is inline-only and non-parking — the one a plain `write` key
      // can drive end to end.
      const initiative = listed.body.pipelines.find(
        (p) => p.pipelineId === 'pl_initiative_breakdown',
      )!
      expect(initiative.public).toBe(true)
      expect(initiative.headlessStartable).toBe(true)

      // A container/repo pipeline is never headless-startable, whatever the caller's scope.
      const build = listed.body.pipelines.find((p) => !p.public && p.pipelineId !== 'pl_blueprint')
      expect(build?.headlessStartable).toBe(false)
    })

    it('records the headless intake origin on a run started through the public API', async () => {
      // Slice 2's question-writeback fires ONLY for a headless-origin run, so the marker has to
      // survive the round-trip through each facade's real store. It rides the `agent_runs.detail`
      // JSON via the shared mappers, so a facade that hand-rolled its own execution mapping would
      // silently drop it — and a UI-started task would then be indistinguishable from a headless
      // one, which is exactly the confusion that would post questions to a human's ticket.
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board — every
      // case here uses an org-owned, seeded workspace (the seed also brings the demo tasks).
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'write')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call(
        'POST',
        `/api/v1/tasks/task_login/start`,
        { pipelineId: pipeline.body.id },
        auth,
      )
      expect(started.status).toBe(202)

      const run = await app.executionRepository().getByBlock(wsId, 'task_login')
      expect(run?.intakeOrigin).toBe('public-api')

      // The SPA path must be untouched: a task started in-app carries no headless marker, so it
      // reads as `ui` and never triggers the slice-2 writeback. Driven in its OWN workspace so the
      // seeded dependency graph (`task_refresh` depends on `task_login`) can't turn a missing
      // marker into a start the engine refused for an unrelated reason.
      const { workspace: uiWorkspace } = await app.createOrgWorkspace({ seed: true })
      const uiPipeline = await app.call<Pipeline>(
        'POST',
        `/workspaces/${uiWorkspace.id}/pipelines`,
        { name: 'Coder only', agentKinds: ['coder'] },
      )
      const uiStart = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${uiWorkspace.id}/blocks/task_login/executions`,
        { pipelineId: uiPipeline.body.id },
      )
      expect(uiStart.status).toBe(201)
      const uiRun = await app.executionRepository().getByBlock(uiWorkspace.id, 'task_login')
      expect(uiRun?.intakeOrigin).toBeUndefined()
    })

    it('lists a parked review over the public API and answers it through the same services', async () => {
      // The end-to-end headless loop: read the run's open findings, answer one, and see the answer
      // reflected — all over `/api/v1`, all delegating to the SAME service methods the SPA calls.
      // Seeding a `ready` review into each facade's real store keeps this deterministic (no live
      // reviewer model) while still proving the routes are mounted and the review store is wired
      // on both runtimes.
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board — every
      // case here uses an org-owned, seeded workspace (the seed also brings the demo tasks).
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      await app.seedReadyReview(wsId, 'task_login')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(started.status).toBe(201)
      const runId = started.body.id

      const decideAuth = await mintKey(app, wsId, 'decide')
      const listed = await app.call<{
        runId: string
        decisions: { kind: string; findings: { itemId: string; status: string }[] }[]
      }>('GET', `/api/v1/runs/${runId}/decisions`, undefined, decideAuth)
      expect(listed.status).toBe(200)
      expect(listed.body.runId).toBe(runId)
      const review = listed.body.decisions.find((d) => d.kind === 'requirements-review')!
      expect(review).toBeDefined()
      const open = review.findings.find((f) => f.status === 'open')!
      expect(open).toBeDefined()

      // Answering goes through `RequirementReviewService.replyToItem` — the same method the SPA
      // controller calls — so the item flips to `answered` and the response carries the updated
      // list rather than requiring a follow-up read.
      const answered = await app.call<{
        decisions: { kind: string; findings: { itemId: string; status: string; reply: string }[] }[]
      }>(
        'POST',
        `/api/v1/runs/${runId}/decisions/requirements/findings/${open.itemId}/reply`,
        { reply: 'Sessions last 24 hours.' },
        decideAuth,
      )
      expect(answered.status).toBe(200)
      const updated = answered.body.decisions.find((d) => d.kind === 'requirements-review')!
      const item = updated.findings.find((f) => f.itemId === open.itemId)!
      expect(item.status).toBe('answered')
      expect(item.reply).toBe('Sessions last 24 hours.')
    })

    it('refuses to answer a decision with a write-scope key', async () => {
      // Answering injects caller-supplied prose into the requirements every downstream agent then
      // implements, so it sits a rung above ordinary task authoring. A `write` key that can start
      // and stop tasks must still get a clean 403 here, on every facade.
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board — every
      // case here uses an org-owned, seeded workspace (the seed also brings the demo tasks).
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      await app.seedReadyReview(wsId, 'task_login')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      const writeAuth = await mintKey(app, wsId, 'write')
      const refused = await app.call<{ error: { code: string } }>(
        'POST',
        `/api/v1/runs/${started.body.id}/decisions/requirements/proceed`,
        undefined,
        writeAuth,
      )
      expect(refused.status).toBe(403)
      expect(refused.body.error.code).toBe('insufficient_scope')
    })

    it("scopes a run's decisions to the key's workspace", async () => {
      // The surface is keyed by RUN id, so the workspace scoping is the only thing standing
      // between one tenant's key and another tenant's parked run. A foreign run must be a 404
      // (never a 403, which would confirm it exists) on every facade.
      const app = harness.makeApp()
      const { workspace: a } = await app.createOrgWorkspace({ seed: true })
      const { workspace: b } = await app.createOrgWorkspace({ seed: true })

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${a.id}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${a.id}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(started.status).toBe(201)

      const foreignAuth = await mintKey(app, b.id, 'decide')
      const denied = await app.call<{ error: { code: string } }>(
        'GET',
        `/api/v1/runs/${started.body.id}/decisions`,
        undefined,
        foreignAuth,
      )
      expect(denied.status).toBe(404)
      expect(denied.body.error.code).toBe('not_found')
    })
  })
}
