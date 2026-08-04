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
    registerAdmissionTests(harness)
    registerAnsweringTests(harness)
    registerScopeAndCancelTests(harness)
  })
}

/**
 * Public-API ADMISSION over the wire: which key may set which parks in motion. The policy itself
 * is pure logic unit-tested in `publicApiAdmission.test.ts`; what belongs here is that each facade
 * wires the registry, the pipeline read and the task read the checks run against.
 */
function registerAdmissionTests(harness: ConformanceHarness): void {
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
    const uiPipeline = await app.call<Pipeline>('POST', `/workspaces/${uiWorkspace.id}/pipelines`, {
      name: 'Coder only',
      agentKinds: ['coder'],
    })
    const uiStart = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${uiWorkspace.id}/blocks/task_login/executions`,
      { pipelineId: uiPipeline.body.id },
    )
    expect(uiStart.status).toBe(201)
    const uiRun = await app.executionRepository().getByBlock(uiWorkspace.id, 'task_login')
    expect(uiRun?.intakeOrigin).toBeUndefined()
  })

  it('requires a decide-scope key to start a board task on a parking pipeline', async () => {
    // The SAME rule as `POST /api/v1/jobs`, now on the board start too: the `decide` scope is
    // the operator asserting "this integration answers this workspace's parked decisions", and
    // a plain `write` key must not be able to set a park in motion it is by definition not
    // trusted to answer. This start path used to apply no pipeline admission at all; the wire
    // test lives here (not only in publicApiAdmission.test.ts) because each facade wires the
    // pipeline read the check runs against.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    // An approval gate on an enabled step is the simplest park: no review module involved.
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Gated coder',
      agentKinds: ['coder'],
      gates: [true],
    })

    const writeAuth = await mintKey(app, wsId, 'write')
    const refused = await app.call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: pipeline.body.id },
      writeAuth,
    )
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('pipeline_requires_decide_scope')
    // The refusal names the exit route of THIS surface, not the jobs cancel.
    expect(refused.body.error.message).toContain('POST /api/v1/tasks/:taskId/stop')

    const decideAuth = await mintKey(app, wsId, 'decide')
    const started = await app.call(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: pipeline.body.id },
      decideAuth,
    )
    expect(started.status).toBe(202)
  })

  it('refuses a write key on a human-review pipeline, and admits a non-parking one', async () => {
    // The third park mechanism, over the wire. `human-review` is a polling GATE, not an approval
    // flag and not an inline review kind: it carries no `gates[i]`, so the two checks the rule
    // shipped with both looked straight past it. What parks the run is its own poll loop, which
    // never times out because it is waiting for a person to review the PR.
    //
    // It matters more than a synthetic case because `pl_full` (the shipped Adaptive build preset)
    // carries a risk-gated `human-review`: while this was unseen, a `write` key could start the
    // platform's flagship board pipeline and have the run park indefinitely on the ONE surface
    // `/api/v1/runs/:runId/decisions` cannot answer at all.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const writeAuth = await mintKey(app, wsId, 'write')

    const parking = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Coder then human review',
      agentKinds: ['coder', 'human-review'],
    })
    const refused = await app.call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: parking.body.id },
      writeAuth,
    )
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('pipeline_requires_decide_scope')
    // The refusal must NAME the surface, or an operator cannot tell which step to drop.
    expect(refused.body.error.message).toContain('human-review')

    // The control, in the same test so the two can never drift apart: the identical chain minus
    // the gate is still startable by a plain `write` key. Widening the park enumeration must not
    // quietly re-scope ordinary board work, which is the failure mode that would hurt most.
    const plain = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Coder only',
      agentKinds: ['coder'],
    })
    const started = await app.call(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: plain.body.id },
      writeAuth,
    )
    expect(started.status).toBe(202)
  })
}

/**
 * Answering a park through the public surface, and the input gate's own admission + resolve. The
 * gate is the one park that turns on the shape of the TASK rather than the pipeline, so it needs
 * both halves proved per facade: the refusal a `write` key gets, and the `decide`-scope loop that
 * actually releases the run.
 */
function registerAnsweringTests(harness: ConformanceHarness): void {
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

  it('refuses a write key on a task the INPUT GATE would park, whatever the pipeline', async () => {
    // The gate is the one park that turns on the shape of the TASK, so it can hold a run whose
    // pipeline parks nowhere at all. Before this was composed into admission, a `write` key
    // could start a title-only task on a perfectly unparking pipeline and get a run stopped
    // before its first dispatch, with `GET .../decisions` reporting `parked: true`, nothing to
    // answer, and `stop` as the only way out.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Unparking estimator',
      agentKinds: ['task-estimator'],
    })
    // A title-only task: nothing an agent could act on.
    const task = await app.call<{ id: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/blk_auth/tasks`,
      {
        title: 'Make the login better',
      },
    )

    const writeAuth = await mintKey(app, wsId, 'write')
    const refused = await app.call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/v1/tasks/${task.body.id}/start`,
      { pipelineId: pipeline.body.id },
      writeAuth,
    )
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('pipeline_requires_decide_scope')
    expect(refused.body.error.message).toContain('input-gate')
    // The gate IS answerable over the public surface, so the refusal must steer there rather
    // than describing the park as cancel-only.
    expect(refused.body.error.message).toContain('/api/v1/runs/:runId/decisions')

    // The same task with a real description is not a park at all, so a `write` key runs it.
    await app.call('PATCH', `/workspaces/${wsId}/blocks/${task.body.id}`, {
      description: 'Keep the typed email in the login form when a sign-in attempt fails.',
    })
    const started = await app.call(
      'POST',
      `/api/v1/tasks/${task.body.id}/start`,
      { pipelineId: pipeline.body.id },
      writeAuth,
    )
    expect(started.status).toBe(202)
  })

  it('lists a run parked on the input gate and answers it over the public surface', async () => {
    // The whole point of the surface: a headless caller fixes the task over `PATCH /api/v1/tasks`
    // and rechecks, or waives. Without this route such a run sat parked forever with cancel as
    // its only exit, which is exactly what the admission rule above exists to prevent setting in
    // motion. Asserted per facade because the verdict rides the run's `detail` JSON (D1 ⇄
    // Drizzle) and the resolve wakes each facade's own durable driver.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const decideAuth = await mintKey(app, wsId, 'decide')
    const task = await app.call<{ id: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/blk_auth/tasks`,
      {
        title: 'Make the login better',
      },
    )
    const taskId = task.body.id
    expect(
      (
        await app.call(
          'POST',
          `/api/v1/tasks/${taskId}/start`,
          { pipelineId: 'pl_simple' },
          decideAuth,
        )
      ).status,
    ).toBe(202)
    await app.drive(wsId)

    const exec = (await app.drive(wsId)).find((e) => e.blockId === taskId)!
    const runId = exec.id
    const parked = await app.call<{
      parked: boolean
      decisions: { kind: string; status: string; issues: { code: string }[] }[]
    }>('GET', `/api/v1/runs/${runId}/decisions`, undefined, decideAuth)
    expect(parked.status).toBe(200)
    expect(parked.body.parked).toBe(true)
    const gate = parked.body.decisions.find((d) => d.kind === 'input-gate')!
    expect(gate.status).toBe('blocked')
    expect(gate.issues.map((i) => i.code)).toEqual(['description_missing'])

    // A recheck against the STILL-broken task keeps the park: the fix is verified, never taken
    // on the caller's word, and a still-blocked verdict is a 200 because nothing went wrong.
    const still = await app.call<{ decisions: { kind: string; status: string }[] }>(
      'POST',
      `/api/v1/runs/${runId}/decisions/input-gate/resolve`,
      { choice: 'recheck' },
      decideAuth,
    )
    expect(still.status).toBe(200)
    expect(still.body.decisions.find((d) => d.kind === 'input-gate')?.status).toBe('blocked')

    // Fix it through the public task patch, then recheck: the run is released and finishes.
    await app.call(
      'PATCH',
      `/api/v1/tasks/${taskId}`,
      { description: 'Keep the typed email in the login form when a sign-in attempt fails.' },
      decideAuth,
    )
    const cleared = await app.call<{ parked: boolean; decisions: { kind: string }[] }>(
      'POST',
      `/api/v1/runs/${runId}/decisions/input-gate/resolve`,
      { choice: 'recheck' },
      decideAuth,
    )
    expect(cleared.status).toBe(200)
    // Released: the gate is settled, so it is no longer a decision anybody has to answer.
    expect(cleared.body.decisions.some((d) => d.kind === 'input-gate')).toBe(false)

    const done = (await app.drive(wsId)).find((e) => e.blockId === taskId)!
    expect(done.status).toBe('done')
    expect(done.inputGate?.status).toBe('passed')
  })
}

/**
 * Scope and workspace isolation on the decision surface, plus the cancel that frees an abandoned
 * park's in-flight slot.
 */
function registerScopeAndCancelTests(harness: ConformanceHarness): void {
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

  it('cancels a headless job, freeing the in-flight slot its park was holding', async () => {
    // This route is what makes admitting a PARKING pipeline safe at all: a parked run waits for
    // a human indefinitely (there is deliberately no run-killing timeout — decision D1) while
    // its anchor holds one of the workspace's MAX_ACTIVE_JOB_RUNS slots. Without a way to
    // give up, the concurrency cap is a wall with no door.
    //
    // It belongs in conformance rather than a unit test because cancelling is per-runtime work:
    // `stopRun` tears down the facade's own durable driver (Workflows ⇄ pg-boss) and writes the
    // terminal row through its own store. A facade that mounted the route but left the run live
    // would keep leaking slots, and the caller would see a `failed` job either way.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const auth = await mintKey(app, workspace.id, 'write')

    const created = await app.call<{ jobId: string }>(
      'POST',
      '/api/v1/jobs',
      { pipelineId: 'pl_initiative_breakdown', input: 'Ship a headless clarification loop.' },
      auth,
    )
    expect(created.status).toBe(202)

    // `write`, not `decide`: giving up on your own run is an ordinary mutation, and a caller
    // must never be locked out of cleaning up work it started.
    const cancelled = await app.call<{ id: string; status: string }>(
      'POST',
      `/api/v1/jobs/${created.body.jobId}/cancel`,
      undefined,
      auth,
    )
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('failed')

    // Idempotent — a terminal run comes back as-is rather than erroring, so a caller retrying
    // through a dropped connection doesn't have to distinguish the two.
    const again = await app.call<{ status: string }>(
      'POST',
      `/api/v1/jobs/${created.body.jobId}/cancel`,
      undefined,
      auth,
    )
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('failed')

    // The job stays READABLE afterwards: cancelling records a terminal state, it does not delete
    // the run, so a caller can still fetch what happened.
    const polled = await app.call<{ status: string }>(
      'GET',
      `/api/v1/jobs/${created.body.jobId}`,
      undefined,
      auth,
    )
    expect(polled.status).toBe(200)
  })

  it('refuses to cancel a job belonging to another workspace', async () => {
    // Same scoping rule as the decision routes — and the route mutates, so a gap here is worse
    // than a read leak: a foreign key could terminate a tenant's running work.
    const app = harness.makeApp()
    const { workspace: a } = await app.createOrgWorkspace({ seed: true })
    const { workspace: b } = await app.createOrgWorkspace({ seed: true })
    const ownerAuth = await mintKey(app, a.id, 'write')
    const foreignAuth = await mintKey(app, b.id, 'admin')

    const created = await app.call<{ jobId: string }>(
      'POST',
      '/api/v1/jobs',
      { pipelineId: 'pl_initiative_breakdown', input: 'A run another tenant must not touch.' },
      ownerAuth,
    )
    expect(created.status).toBe(202)

    // 404, not 403 — a 403 would confirm the run exists. Even an `admin` key gets nothing.
    const denied = await app.call<{ error: { code: string } }>(
      'POST',
      `/api/v1/jobs/${created.body.jobId}/cancel`,
      undefined,
      foreignAuth,
    )
    expect(denied.status).toBe(404)
    expect(denied.body.error.code).toBe('not_found')
  })
}
