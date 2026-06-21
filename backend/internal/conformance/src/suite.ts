import {
  type Block,
  type ExecutionInstance,
  type ModelDefaults,
  type Pipeline,
  type PipelineSchedule,
  type ScheduleRun,
  seedPipelines,
  type SlackMemberMappingEntry,
  type SlackNotificationSettings,
  type TrackerSettings,
  type Workspace,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'

// The cross-runtime conformance suite: the KEY backend behaviour every deployment
// facade must implement identically. It is parameterised by a `ConformanceHarness`,
// so the exact same assertions run against the Cloudflare Worker (over D1, inside
// workerd) and the Node service (over real Postgres). Any behavioural drift between
// runtimes — a repository that maps a column differently, an engine path that only
// one facade wires — fails here instead of shipping silently.
//
// It deliberately covers the runtime-neutral core only (workspaces, board, the
// execution engine driven through the deterministic FakeAgentExecutor). Facade- or
// integration-specific behaviour (GitHub, documents, durable runners, real-time
// upgrade) stays in each runtime's own suite.

export function defineConformanceSuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('workspaces', () => {
      it('creates a seeded board and returns a full snapshot', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { name: 'My board' })

        expect(res.status).toBe(201)
        expect(res.body.workspace.name).toBe('My board')
        expect(res.body.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
        // Every facade seeds a new board with the full built-in pipeline catalog.
        expect(res.body.pipelines).toEqual(seedPipelines())
        expect(res.body.executions).toHaveLength(0)
      })

      it('creates a board with no sample blocks when seed=false (pipelines always seeded)', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

        expect(res.body.blocks).toHaveLength(0)
        // The pipeline catalog is product config, not sample data — seeded regardless
        // of the sample-block flag.
        expect(res.body.pipelines).toEqual(seedPipelines())
      })

      it('lists and deletes boards', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        const list = await call<Workspace[]>('GET', '/workspaces')
        expect(list.body.map((w) => w.id)).toContain(workspace.id)

        const del = await call('DELETE', `/workspaces/${workspace.id}`)
        expect(del.status).toBe(204)

        const after = await call('GET', `/workspaces/${workspace.id}`)
        expect(after.status).toBe(404)
      })

      it('returns 404 for an unknown board', async () => {
        const { call } = harness.makeApp()
        const res = await call<{ error: { code: string } }>('GET', '/workspaces/missing')

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('not_found')
      })

      it('isolates blocks between boards', async () => {
        const { createWorkspace } = harness.makeApp()
        const a = await createWorkspace()
        const b = await createWorkspace()

        expect(a.workspace.id).not.toBe(b.workspace.id)
        expect(a.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
        expect(b.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
      })
    })

    describe('model defaults', () => {
      it('reads, replaces and surfaces per-agent-kind default models', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        // A fresh workspace pins nothing.
        const initial = await call<ModelDefaults>(
          'GET',
          `/workspaces/${workspace.id}/model-defaults`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.defaults).toEqual({})

        // Replace the whole map (any string ids — the catalog isn't validated here).
        const put = await call<ModelDefaults>('PUT', `/workspaces/${workspace.id}/model-defaults`, {
          defaults: { architect: 'strong-model', tester: 'cheap-model' },
        })
        expect(put.status).toBe(200)
        expect(put.body.defaults.architect).toBe('strong-model')

        // It persisted.
        const reread = await call<ModelDefaults>(
          'GET',
          `/workspaces/${workspace.id}/model-defaults`,
        )
        expect(reread.body.defaults).toEqual({ architect: 'strong-model', tester: 'cheap-model' })

        // And it rides along on the workspace snapshot.
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        expect(snapshot.body.modelDefaults?.defaults.architect).toBe('strong-model')
      })
    })

    describe('vendor credentials (subscription token pool)', () => {
      it('adds, lists (secret-free), and removes pooled subscription tokens', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/vendor-credentials`

        // A fresh workspace has an empty pool.
        const initial = await call<{ credentials: unknown[] }>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body.credentials).toEqual([])

        // Add two tokens for the same vendor (a pool) — the raw token is write-only.
        const first = await call<{ id: string; vendor: string; label: string }>('POST', base, {
          vendor: 'claude',
          label: 'primary',
          token: 'sk-ant-oat01-secret-one',
        })
        expect(first.status).toBe(201)
        expect(first.body.vendor).toBe('claude')
        // The secret is never echoed back.
        expect(JSON.stringify(first.body)).not.toContain('secret-one')
        const second = await call<{ id: string }>('POST', base, {
          vendor: 'codex',
          label: 'chatgpt',
          token: '{"auth_mode":"chatgpt","tokens":{"access_token":"secret-two"}}',
        })
        expect(second.status).toBe(201)
        // A Claude-Code-flavour vendor beyond claude/codex (GLM/Kimi/DeepSeek): the
        // unfiltered list MUST include it, not just the headline two vendors.
        const third = await call<{ id: string; vendor: string }>('POST', base, {
          vendor: 'glm',
          label: 'zai',
          token: 'glm-coding-plan-secret-three',
        })
        expect(third.status).toBe(201)
        expect(third.body.vendor).toBe('glm')

        // All three list back as metadata only (the unfiltered GET covers every vendor).
        const listed = await call<{ credentials: { id: string; vendor: string }[] }>('GET', base)
        expect(listed.body.credentials).toHaveLength(3)
        expect(listed.body.credentials.map((c) => c.vendor).sort()).toEqual([
          'claude',
          'codex',
          'glm',
        ])
        expect(JSON.stringify(listed.body)).not.toContain('secret-')

        // Remove one; the others survive.
        const del = await call('DELETE', `${base}/${first.body.id}`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ credentials: { id: string }[] }>('GET', base)
        expect(afterDelete.body.credentials.map((c) => c.id).sort()).toEqual(
          [second.body.id, third.body.id].sort(),
        )
      })
    })

    describe('board', () => {
      it('adds a top-level frame', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
          type: 'service',
          position: { x: 10, y: 20 },
        })
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('frame')
      })

      it('adds a user-authored task pinning a pipeline', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/tasks`,
          { title: 'Add SSO login', description: 'Support SAML and OIDC.', pipelineId: 'pl_quick' },
        )
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('task')
        expect(res.body.parentId).toBe('blk_auth')
        expect(res.body.title).toBe('Add SSO login')
        expect(res.body.pipelineId).toBe('pl_quick')
      })

      it('rejects a task without a title', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/blk_auth/tasks`, {})
        expect(res.status).toBe(400)
      })

      it('adds a module to a service but rejects one on a task', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ok = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/modules`,
          { name: 'Tokens' },
        )
        expect(ok.status).toBe(201)
        expect(ok.body.level).toBe('module')

        const bad = await app.call(
          'POST',
          `/workspaces/${workspace.id}/blocks/task_login/modules`,
          {
            name: 'Nope',
          },
        )
        expect(bad.status).toBe(422)
      })

      it('updates a block', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const patched = await app.call<Block>(
          'PATCH',
          `/workspaces/${workspace.id}/blocks/blk_auth`,
          { description: 'Updated description' },
        )
        expect(patched.status).toBe(200)
        expect(patched.body.description).toBe('Updated description')
      })
    })

    describe('execution engine', () => {
      it('runs a task pipeline to auto-merge and materialises its module', async () => {
        const app = harness.makeApp({ confidence: 1 })
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
        for (const s of exec.steps) {
          expect(typeof s.startedAt).toBe('number')
          expect(typeof s.finishedAt).toBe('number')
          expect(s.finishedAt!).toBeGreaterThanOrEqual(s.startedAt!)
        }

        // The model is surfaced up front, while the (inline) step is still querying:
        // there is an emit where the first step is `working` with its model already
        // set — not only the final `done` snapshot. Guards the early model preview so
        // it can't regress to "model appears only once the result lands".
        const querying = app
          .executionEmits('task_login')
          .find((e) => e.steps[0]?.state === 'working' && e.steps[0]?.model === 'fake')
        expect(
          querying,
          'expected an emit with the first step querying and its model set',
        ).toBeTruthy()

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
        expect(task.confidence).toBe(1)
        // task_login is assigned to the existing "Sessions" module → moved inside it.
        expect(task.parentId).toBe('mod_sessions')
      })

      it('aggregates all tasks and ingests the spec-writer document', async () => {
        // The spec-writer step runs on the implementation branch BEFORE the
        // coder, aggregating EVERY task under the service frame into the service's
        // unified spec doc. Driving it identically on both runtimes pins the
        // engine's `serviceTasks` aggregation + strict ingest so they can't drift.
        const spec = {
          service: 'Auth',
          summary: 'Authentication service',
          groups: [
            {
              name: 'Login',
              requirements: [
                {
                  id: 'req-login',
                  title: 'Login',
                  statement: 'The system SHALL let a user log in.',
                  kind: 'functional',
                  priority: 'must',
                  acceptance: [
                    {
                      id: 'ac-1',
                      given: 'a registered user',
                      when: 'they sign in',
                      outcome: 'a session starts',
                    },
                  ],
                },
              ],
            },
          ],
          rules: [],
        }
        const app = harness.makeApp({ spec })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Requirements only',
          agentKinds: ['spec-writer'],
        })
        expect(pipeline.status).toBe(201)

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'spec-writer')!
        expect(step.state).toBe('done')
        // The engine populated `serviceTasks` with at least the running task, and the
        // doc parsed + ingested cleanly (a strict-parse failure would not throw, but a
        // completed step with this output proves the happy path ran end to end).
        expect(step.output).toContain('[spec-writer]')
        expect(step.output).toMatch(/from [1-9]\d* task/)
      })

      it("substitutes a block's reworked requirements for its description in every step", async () => {
        // Once a task's requirements have been reworked ("incorporated"), that
        // standard-format document — not the raw description — is what every agent step
        // consumes. This must hold on EVERY runtime: the Cloudflare facade wires the D1
        // review store, the Node facade the Drizzle one, and both feed the engine through
        // the optional `requirementReviewRepository`. Asserting it here means a facade
        // that forgets to wire that store (the old Node gap) fails a shared test instead
        // of silently shipping divergent agent context.
        const REWORKED = '# Login — Requirements\n\nThe system SHALL keep sessions for 24h.'
        const app = harness.makeApp({ confidence: 1, echoDescription: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.seedIncorporatedReview(wsId, 'task_login', REWORKED)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Coder only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const step = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(step.state).toBe('done')
        // The agent was handed the reworked document, not the seeded task's description.
        expect(step.output).toContain(`[desc]${REWORKED}[/desc]`)
      })

      it('passes a companion gate when the rating clears the threshold', async () => {
        // A companion step grades the prior producer; at/above its threshold the run
        // proceeds. `reviewer` is the coder's companion, so ['coder','reviewer'] runs the
        // coder then grades it — a passing rating (default 1) finishes the run.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        const verdict = companionStep.companion?.verdicts.at(-1)
        expect(verdict?.rating).toBe(1)
        expect(verdict?.passed).toBe(true)
      })

      it('fails the run when a companion stays below threshold past its rework budget', async () => {
        // Below the threshold the companion loops the producer back for automatic rework;
        // once the budget is spent the run fails (`companion_rejected`) for human
        // attention. A fixed low rating drives straight to that terminal state.
        const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + strict companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        expect(exec.failure?.kind).toBe('companion_rejected')
      })

      it('reworks an earlier producer through an intermediate step, then recovers', async () => {
        // The companion reviews the NEAREST target producer, which may sit several
        // steps back: ['coder','tester','reviewer'] has `tester` between the coder and
        // its `reviewer` companion. A first failing grade loops the coder back; the
        // coder AND the intermediate `tester` re-run, then the re-grade passes and the
        // run completes — exercising the multi-step rework reset (every step from the
        // producer up to the companion is reset and re-run, not just the producer).
        const app = harness.makeApp({ confidence: 1, companionRatings: [0.4, 1] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + gap companion',
          agentKinds: ['coder', 'tester', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        // The intermediate tester re-ran after the rework and finished cleanly.
        expect(exec.steps.find((s) => s.agentKind === 'tester')!.state).toBe('done')
        // The companion recorded both cycles: the rejected first grade then the pass.
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
        // Exactly one automatic rework was consumed from the budget.
        expect(companionStep.companion?.attempts).toBe(1)
      })

      it('drives an asynchronous (polled) agent job to completion', async () => {
        // The `coder` step runs as a polled async job (startJob → awaiting_job → pollJob),
        // so this exercises the durable driver's job-poll loop — Cloudflare Workflows and
        // pg-boss — through the SAME assertion, the path most likely to drift between them.
        const app = harness.makeApp({ confidence: 1, asyncKinds: ['coder'], asyncPolls: 2 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: 'pl_quick' },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.every((s) => s.state === 'done')).toBe(true)
        // The coder step ran as a polled job but still produced its normal work product.
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.output).toContain('[coder]')
        expect(coder.model).toBe('fake')
        // The "spinning up container" phase flag is set at dispatch and must be
        // cleared once the container is up — a finished step never reads as booting.
        expect(coder.startingContainer ?? false).toBe(false)
        // The model is known at dispatch (the moment the ref resolves, before the
        // container is up), so it must ALREADY be present on the first "spinning up
        // container" emit — not only once the job's result lands. Asserting it on the
        // booting emit pins the early preview so it can't regress on either runtime.
        const booting = app
          .executionEmits('task_login')
          .map((e) => e.steps.find((s) => s.agentKind === 'coder'))
          .find((s) => s?.startingContainer === true)
        expect(booting, 'expected a "spinning up container" emit for the coder step').toBeTruthy()
        expect(booting!.model).toBe('fake')

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
      })

      it('opens a PR when confidence is below threshold, then merges on demand', async () => {
        const app = harness.makeApp({ confidence: 0.5 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })
        await app.drive(wsId)

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.confidence).toBe(0.5)

        const merge = await app.call<{ status: string }>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/merge`,
        )
        expect(merge.status).toBe(200)
        expect(merge.body.status).toBe('done')
      })

      it('rejects merging a block with no open PR', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/merge`)
        expect(res.status).toBe(409)
      })

      it('pauses for a human decision and resumes after it is resolved', async () => {
        const app = harness.makeApp({ decisionOnSteps: [0], confidence: 1 })
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

      it('pauses at an approval gate, then advances on approve', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const step = exec.steps[0]!
        expect(step.state).toBe('waiting_decision')
        expect(step.approval?.status).toBe('pending')
        expect(step.approval?.proposal).toBe(step.output)
        expect(exec.steps[1]!.state).toBe('pending')
      })

      it('re-runs a gated step with freeform feedback and per-block comments', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        const approvalId = exec.steps[0]!.approval!.id

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/request-changes`,
          {
            feedback: 'tighten the plan',
            comments: [
              { quotedSource: '## Summary', srcStart: 0, srcEnd: 1, body: 'be specific here' },
            ],
          },
        )
        expect(res.status).toBe(200)

        // The re-run folds the feedback + comment into the agent context; the fake
        // executor echoes both so we can assert they reached the agent.
        const reran = await app.drive(wsId)
        const after = reran.find((e) => e.blockId === 'task_login')!
        expect(after.steps[0]!.output).toContain('revised: tighten the plan')
        expect(after.steps[0]!.output).toContain('+1 comments')
        expect(after.steps[0]!.approval?.status).toBe('pending')
      })

      it('rejects a gated proposal, failing the run and blocking the task', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        const approvalId = exec.steps[0]!.approval!.id

        const res = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/reject`,
          { reason: 'wrong direction' },
        )
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('failed')
        expect(res.body.failure?.kind).toBe('rejected')
        expect(res.body.steps[0]!.approval?.status).toBe('rejected')

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('blocked')
      })
    })

    describe('recurring pipelines', () => {
      const recurrence = {
        intervalHours: 24,
        weekdays: [] as number[],
        windowStartHour: null,
        windowEndHour: null,
        timezone: 'UTC',
      }

      it('creates a schedule with a reused block and surfaces it on the snapshot', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: 'pl_dep_update', name: 'Weekly deps', recurrence },
        )
        expect(created.status).toBe(201)
        expect(created.body.frameId).toBe('blk_auth')
        expect(created.body.nextRunAt).toBeGreaterThan(0)

        // The schedule materialised a reused task block under the service frame.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === created.body.blockId)
        expect(block?.parentId).toBe('blk_auth')
        expect(block?.level).toBe('task')
        expect(snapshot.body.recurringPipelines?.map((s) => s.id)).toContain(created.body.id)

        // Listing + deletion (which removes the reused block too).
        const list = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(list.body).toHaveLength(1)
        const del = await app.call(
          'DELETE',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
        )
        expect(del.status).toBe(204)
        const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(after.body.blocks.find((b) => b.id === created.body.blockId)).toBeUndefined()
      })

      it('run-now starts an execution on the reused block and records run history', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A single-step inline pipeline keeps the run deterministic across runtimes.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Recurring inline',
          agentKinds: ['architect'],
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: pipeline.body.id, name: 'Nightly', recurrence },
        )

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        // A running history row pointing at a real execution on the schedule's block.
        const running = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(running.body).toHaveLength(1)
        expect(running.body[0]!.executionId).toBeTruthy()

        // Drive it to completion; the history (overlaid with live status) shows done.
        const driven = await app.drive(wsId)
        expect(driven.find((e) => e.blockId === created.body.blockId)?.status).toBe('done')
        const done = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(done.body[0]!.status).toBe('done')

        // A second run-now while the (now-finished) run exists still works; firing
        // twice in a row never starts two concurrent runs on the same block.
        const again = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(again.status).toBe(200)
      })

      it('reads and writes the workspace tracker selection', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const initial = await app.call<TrackerSettings>(
          'GET',
          `/workspaces/${wsId}/tracker-settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.tracker).toBeNull()

        const put = await app.call<TrackerSettings>('PUT', `/workspaces/${wsId}/tracker-settings`, {
          tracker: 'jira',
          jiraProjectKey: 'ENG',
        })
        expect(put.body.tracker).toBe('jira')
        expect(put.body.jiraProjectKey).toBe('ENG')

        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snapshot.body.trackerSettings?.tracker).toBe('jira')
      })
    })

    // Slack is an extra notification transport; both facades wire the same module +
    // channel. These assert the per-workspace routing and the per-account member map
    // persist + read back identically on each store (the persistence-parity concern).
    // Connecting a workspace (auth.test / OAuth) needs real Slack network, so it is
    // exercised by the integration package's unit tests, not here.
    describe('slack', () => {
      it('round-trips per-workspace notification routing', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A workspace that never configured Slack reads back the (no-op) defaults.
        const initial = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.mentionsEnabled).toBe(false)

        const put = await app.call<SlackNotificationSettings>(
          'PUT',
          `/workspaces/${wsId}/slack/settings`,
          {
            routes: { merge_review: { enabled: true, channel: '#releases' } },
            mentionsEnabled: true,
          },
        )
        expect(put.status).toBe(200)
        expect(put.body.routes.merge_review).toEqual({ enabled: true, channel: '#releases' })
        expect(put.body.mentionsEnabled).toBe(true)

        const after = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(after.body.routes.merge_review?.channel).toBe('#releases')
        expect(after.body.mentionsEnabled).toBe(true)
      })

      it('round-trips the per-account member mapping (de-duped by github user id)', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const empty = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        const put = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'PUT',
          `/workspaces/${wsId}/slack/member-mapping`,
          {
            entries: [
              { githubUserId: 1, slackUserId: 'U1', role: 'engineering' },
              { githubUserId: 1, slackUserId: 'U1b', role: 'product' },
              { githubUserId: 2, slackUserId: 'U2', role: 'product' },
            ],
          },
        )
        expect(put.status).toBe(200)
        // De-duped by github user id (last write wins): 2 entries, not 3.
        expect(put.body.entries).toHaveLength(2)
        expect(put.body.entries.find((e) => e.githubUserId === 1)?.slackUserId).toBe('U1b')

        const after = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(after.body.entries).toHaveLength(2)
        // The notification role round-trips on both stores (drives @-mention audience).
        expect(after.body.entries.find((e) => e.githubUserId === 1)?.role).toBe('product')
        expect(after.body.entries.find((e) => e.githubUserId === 2)?.role).toBe('product')
      })
    })
  })
}
