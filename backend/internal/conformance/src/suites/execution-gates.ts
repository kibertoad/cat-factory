import {
  type Block,
  type ExecutionInstance,
  type Pipeline,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Execution-engine conformance, slice 3: estimate-gated companions, merge presets + merger
// routing, pipeline library round-trips, async job drive, follow-up companion, human decision /
// approval gates, per-run gate overrides, and the Ralph loop. Re-opens the `execution engine`
// group and adds the sibling `ralph loop` group, both inside the aggregator's `[name]` wrapper.
export function defineExecutionGatesConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    it('skips an estimate-gated companion below threshold, runs it above', async () => {
      // A companion can be GATED on the task estimate: it runs only when the estimate
      // clears a threshold (OR across axes), else it is transparently skipped at runtime.
      // The estimate is produced by an earlier `task-estimator` step in the SAME run. A
      // LOW estimate skips the reviewer; the run still completes.
      const gating = [null, null, { enabled: true, minRisk: 0.6, minImpact: 0.6 }]
      const low = harness.makeApp({
        confidence: 1,
        taskEstimate: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'low' },
      })
      const { workspace } = await low.createWorkspace()
      const lowPipe = await low.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Estimator-gated reviewer (low)',
        agentKinds: ['task-estimator', 'coder', 'reviewer'],
        gating,
      })
      expect(lowPipe.status).toBe(201)
      const lowStart = await low.call<ExecutionInstance>(
        'POST',
        `/workspaces/${workspace.id}/blocks/task_login/executions`,
        { pipelineId: lowPipe.body.id },
      )
      expect(lowStart.status).toBe(201)
      const lowExec = (await low.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(lowExec.status).toBe('done')
      const skipped = lowExec.steps.find((s) => s.agentKind === 'reviewer')!
      expect(skipped.skipped).toBe(true)
      expect(skipped.companion?.verdicts ?? []).toEqual([])

      // A HIGH estimate clears the gate, so the reviewer runs and grades the coder.
      const high = harness.makeApp({
        confidence: 1,
        taskEstimate: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'high' },
      })
      const { workspace: ws2 } = await high.createWorkspace()
      const hiPipe = await high.call<Pipeline>('POST', `/workspaces/${ws2.id}/pipelines`, {
        name: 'Estimator-gated reviewer (high)',
        agentKinds: ['task-estimator', 'coder', 'reviewer'],
        gating,
      })
      const hiStart = await high.call<ExecutionInstance>(
        'POST',
        `/workspaces/${ws2.id}/blocks/task_login/executions`,
        { pipelineId: hiPipe.body.id },
      )
      expect(hiStart.status).toBe(201)
      const hiExec = (await high.drive(ws2.id)).find((e) => e.blockId === 'task_login')!
      expect(hiExec.status).toBe('done')
      const ran = hiExec.steps.find((s) => s.agentKind === 'reviewer')!
      expect(ran.skipped ?? false).toBe(false)
      expect((ran.companion?.verdicts.length ?? 0) > 0).toBe(true)
    })

    it('rejects a pipeline that gates a step with no task-estimator before it', async () => {
      // Estimate gating is meaningless without an estimate to consult, so a pipeline with
      // any enabled gating but no preceding `task-estimator` is rejected at save (and at
      // start) — a `validation` domain error → 422, identically on both facades.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const res = await app.call('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Gated without estimator',
        agentKinds: ['coder', 'reviewer'],
        gating: [null, { enabled: true, minRisk: 0.6 }],
      })
      expect(res.status).toBe(422)
    })

    it('round-trips pipeline labels + archive state through create and organize', async () => {
      // Labels + archive are organizational metadata that persist on BOTH stores. Archive
      // is the only mutation a built-in accepts (it touches the view, not the structure).
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Labelled',
        agentKinds: ['coder'],
        labels: ['experiment', 'wip'],
      })
      expect(created.status).toBe(201)
      expect([...(created.body.labels ?? [])].sort()).toEqual(['experiment', 'wip'])
      expect(created.body.archived ?? false).toBe(false)

      const organized = await app.call<Pipeline>(
        'PATCH',
        `/workspaces/${wsId}/pipelines/${created.body.id}/organize`,
        { archived: true, labels: ['shelved'] },
      )
      expect(organized.status).toBe(200)
      expect(organized.body.archived).toBe(true)
      expect(organized.body.labels).toEqual(['shelved'])

      // The list reflects the persisted change (re-read from the store).
      const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
      const reread = list.body.find((p) => p.id === created.body.id)!
      expect(reread.archived).toBe(true)
      expect(reread.labels).toEqual(['shelved'])

      // A built-in accepts organize (archive) while staying read-only/builtin.
      const builtin = list.body.find((p) => p.builtin)!
      const archivedBuiltin = await app.call<Pipeline>(
        'PATCH',
        `/workspaces/${wsId}/pipelines/${builtin.id}/organize`,
        { archived: true },
      )
      expect(archivedBuiltin.status).toBe(200)
      expect(archivedBuiltin.body.archived).toBe(true)
      expect(archivedBuiltin.body.builtin).toBe(true)
    })

    it('round-trips pipeline launch availability through create, update, and clone', async () => {
      // `availability` gates HOW a pipeline may be launched (one-off / recurring / both). It is
      // a plain persisted column on BOTH stores — a facade that forgot to map it would silently
      // drop the field on save (the exact gap this asserts against), leaving the launch gate
      // inert after a DB round-trip.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Recurring only',
        agentKinds: ['coder'],
        availability: 'recurring',
      })
      expect(created.status).toBe(201)
      expect(created.body.availability).toBe('recurring')

      // Re-read from the store (not the create echo) — this is where a dropped column shows up.
      const afterCreate = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
      expect(afterCreate.body.find((p) => p.id === created.body.id)?.availability).toBe('recurring')

      const updated = await app.call<Pipeline>(
        'PATCH',
        `/workspaces/${wsId}/pipelines/${created.body.id}`,
        { availability: 'both' },
      )
      expect(updated.status).toBe(200)
      expect(updated.body.availability).toBe('both')
      const afterUpdate = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
      expect(afterUpdate.body.find((p) => p.id === created.body.id)?.availability).toBe('both')

      // A clone preserves the source's availability.
      const source = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'One-off only',
        agentKinds: ['coder'],
        availability: 'one-off',
      })
      expect(source.status).toBe(201)
      const cloned = await app.call<Pipeline>(
        'POST',
        `/workspaces/${wsId}/pipelines/${source.body.id}/clone`,
        {},
      )
      expect(cloned.status).toBe(201)
      expect(cloned.body.availability).toBe('one-off')
      const afterClone = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
      expect(afterClone.body.find((p) => p.id === cloned.body.id)?.availability).toBe('one-off')
    })

    it('reviews the spec-writer with its companion and reworks it without a human gate', async () => {
      // The Spec Writer is no longer human-gated by default: its `spec-companion`
      // (Spec Reviewer) rates the spec, and below threshold loops the spec-writer
      // back for automatic rework — NO human decision is raised. A first failing
      // grade then a passing re-grade drives the loop to completion, pinning that
      // the spec quality gate is automatic on both runtimes.
      const spec = {
        service: 'Auth',
        summary: 'Authentication service',
        modules: [
          {
            name: 'Access',
            summary: 'User access',
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
                rules: [],
              },
            ],
          },
        ],
      }
      const app = harness.makeApp({ spec, companionRatings: [0.4, 1] })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Spec + reviewer',
        agentKinds: ['spec-writer', 'spec-companion'],
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
      // Completed straight through — the spec never paused for a human decision.
      expect(exec.status).toBe('done')
      expect(exec.steps.some((s) => s.state === 'waiting_decision')).toBe(false)
      // The spec-writer re-ran after the failing grade and finished.
      expect(exec.steps.find((s) => s.agentKind === 'spec-writer')!.state).toBe('done')
      // The companion recorded both cycles (rejected then passed), consuming exactly
      // one automatic rework from the budget.
      const companionStep = exec.steps.find((s) => s.agentKind === 'spec-companion')!
      expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
      expect(companionStep.companion?.attempts).toBe(1)
    })

    it('drives an asynchronous (polled) agent job to completion', async () => {
      // The `coder` step runs as a polled async job (startJob → awaiting_job → pollJob),
      // so this exercises the durable driver's job-poll loop — Cloudflare Workflows and
      // pg-boss — through the SAME assertion, the path most likely to drift between them.
      // asyncPolls: 3 so the job reports two running polls — phase `clone` then `agent`
      // — exercising the live phase progression surfaced on the step's container.
      const app = harness.makeApp({ confidence: 1, asyncKinds: ['coder'], asyncPolls: 3 })
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
      // The container reached `up` (the cold-boot lifecycle advanced past `starting`),
      // and a finished job never reads as still booting.
      expect(coder.container?.status).toBe('up')
      // The model is known at dispatch (the moment the ref resolves, before the
      // container is up), so it must ALREADY be present on the first "spinning up
      // container" emit (container `starting`) — not only once the job's result lands.
      const containerEmits = app
        .executionEmits('task_login')
        .map((e) => e.steps.find((s) => s.agentKind === 'coder'))
      const booting = containerEmits.find((s) => s?.container?.status === 'starting')
      expect(booting, 'expected a "spinning up container" emit for the coder step').toBeTruthy()
      expect(booting!.model).toBe('fake')
      // Once up, the run surfaces the live phase (the agent making calls) and the
      // container's id, so the details show WHAT it's doing and WHERE it runs rather
      // than a blank "working" — identically on both runtimes.
      const running = containerEmits.find(
        (s) => s?.container?.status === 'up' && s.container.phase === 'agent',
      )
      expect(running, 'expected a running emit with the agent phase').toBeTruthy()
      expect(running!.container!.id).toContain('fake-container-')

      const task = (
        await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      ).body.blocks.find((b) => b.id === 'task_login')!
      expect(task.status).toBe('done')
    })

    it('parks on undecided follow-ups, then decides + loops the Coder (Follow-up companion)', async () => {
      // The async `coder` streams two forward-looking items (a follow-up + a question).
      // The engine appends them to the step live and the Follow-up companion gate holds the
      // pipeline at the Coder's completion until every item is decided — then loops the
      // Coder for the answered question before advancing. Asserted identically on both
      // runtimes (pure engine + step state — no new table, no facade-specific wiring).
      const app = harness.makeApp({
        confidence: 1,
        asyncKinds: ['coder'],
        followUps: [
          { kind: 'follow_up', title: 'Dedupe the retry helper', detail: 'two copies exist' },
          { kind: 'question', title: 'Which timeout?', detail: '30s or 60s?' },
        ],
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: 'pl_quick',
      })

      // The run parks at the Coder's completion: both items surfaced + pending, the run
      // blocked, and the NEXT step (blueprints) NOT started.
      const parked = await app.drive(wsId)
      const exec = parked.find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('blocked')
      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.followUps?.enabled).toBe(true)
      expect(coder.followUps?.items.map((i) => i.status)).toEqual(['pending', 'pending'])
      expect(exec.steps.find((s) => s.agentKind === 'blueprints')!.state).toBe('pending')

      // GET surfaces the same live state.
      const got = await app.call('GET', `/workspaces/${wsId}/executions/${exec.id}/follow-ups`)
      expect(got.status).toBe(200)

      const followUp = coder.followUps!.items.find((i) => i.kind === 'follow_up')!
      const question = coder.followUps!.items.find((i) => i.kind === 'question')!

      // Dismiss the follow-up, then answer the question → every item decided.
      await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/follow-ups/${followUp.id}/dismiss`,
      )
      const answered = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/follow-ups/${question.id}/answer`,
        { answer: '30s' },
      )
      expect(answered.status).toBe(200)

      // The answered question loops the Coder once, then the run advances to completion.
      const done = await app.drive(wsId)
      const final = done.find((e) => e.blockId === 'task_login')!
      expect(final.status).toBe('done')
      const finalCoder = final.steps.find((s) => s.agentKind === 'coder')!
      expect(finalCoder.followUps?.loops ?? 0).toBeGreaterThanOrEqual(1)
      expect(finalCoder.followUps?.items.find((i) => i.id === question.id)?.status).toBe('answered')
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

    // The per-run gate-override seam (the initiative-preset gate-override, slice 2): a run
    // started with a `gates` override runs with THAT approval-gate config instead of the
    // pipeline's own, and the override is persisted on the run's steps (so it round-trips
    // through each store and survives to the driver). Exercised through the `startExecution`
    // probe (no HTTP route carries a gate override) so both stores are asserted identically.
    describe('per-run gate overrides (initiative-preset seam)', () => {
      it('an override turns a pipeline gate ON, pausing a step the pipeline left ungated', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The pipeline itself declares NO gates; the per-run override enables the first one.
        const ungated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Override on',
          agentKinds: ['architect', 'coder'],
          gates: [false, false],
        })
        await app.startExecution(wsId, 'task_login', ungated.body.id, { gates: [true, false] })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        expect(exec.steps[0]!.state).toBe('waiting_decision')
        expect(exec.steps[0]!.approval?.status).toBe('pending')
        expect(exec.steps[1]!.state).toBe('pending')

        // The override is persisted on the run's steps, not just held in memory — read it back
        // from the runtime's real store to prove each store round-trips `requiresApproval`.
        const stored = await app.executionRepository().get(wsId, exec.id)
        expect(stored!.steps[0]!.requiresApproval).toBe(true)
        expect(stored!.steps[1]!.requiresApproval).toBe(false)
      })

      it('an override turns a pipeline gate OFF, advancing past a step the pipeline gated', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The pipeline gates the first step; the per-run override disables it so the run flows
        // straight through (no human approval) — the docs-refresh "human review off" default.
        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Override off',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.startExecution(wsId, 'task_login', gated.body.id, { gates: [false, false] })

        const settled = await app.drive(wsId)
        const exec = settled.find((e) => e.blockId === 'task_login')!
        // The first step completed without ever pausing for approval.
        expect(exec.steps[0]!.state).toBe('done')
        expect(exec.steps[0]!.approval ?? null).toBeNull()
        const stored = await app.executionRepository().get(wsId, exec.id)
        expect(stored!.steps[0]!.requiresApproval).toBe(false)
      })

      it('rejects a gate override whose length does not match the pipeline step count', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Mismatch',
          agentKinds: ['architect', 'coder'],
          gates: [false, false],
        })

        // A one-entry override against a two-step pipeline is rejected before any side effect.
        await expect(
          app.startExecution(wsId, 'task_login', pipeline.body.id, { gates: [true] }),
        ).rejects.toThrow(/2 step/)
      })
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

    it('refuses to approve a rejected gate — a stale approve cannot resurrect a failed run', async () => {
      // The reject/approve race regression: approve used to read once and blind-write,
      // so an approve landing after a reject advanced the already-failed run back to
      // life. It now re-validates under optimistic concurrency and must conflict.
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

      const rejected = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/reject`,
        { reason: 'wrong direction' },
      )
      expect(rejected.status).toBe(200)
      expect(rejected.body.status).toBe('failed')

      const approve = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/approve`,
        {},
      )
      expect(approve.status).toBe(409)

      // The run stays failed and the task stays blocked — nothing was resurrected.
      const snapshot = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const run = snapshot.executions.find((e) => e.id === exec.id)!
      expect(run.status).toBe('failed')
      expect(run.steps[0]!.approval?.status).toBe('rejected')
      const task = snapshot.blocks.find((b) => b.id === 'task_login')!
      expect(task.status).toBe('blocked')
    })
  })

  // The Ralph loop: a persistent retry-until-done coding step whose exit condition is a
  // harness-run validation command. These assert the loop drives to completion, exhausts its
  // budget, and refuses to start unconfigured — identically on D1 and Postgres, and (because
  // the loop state rides the persisted `step.ralph`) resumable across the durable driver.
  describe('ralph loop', () => {
    const ralphPr = {
      url: 'https://github.com/o/r/pull/7',
      number: 7,
      branch: 'cat-factory/ralph',
    }

    it('loops a ralph step until its validation command passes, then advances', async () => {
      // The fake reports a failing validation for iterations 1–2 and a pass on iteration 3
      // (based on the iteration number the engine folds in), so the engine must re-dispatch
      // twice before finishing — proving the retry loop and the persisted iteration count.
      const app = harness.makeApp({
        asyncKinds: ['ralph'],
        ralphPassOnIteration: 3,
        pullRequest: ralphPr,
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Ralph task',
        taskType: 'ralph',
        agentConfig: {
          'ralph.validationCommand': 'echo build && echo test',
          'ralph.maxIterations': '6',
        },
      })
      expect(task.status).toBe(201)
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Ralph only',
        agentKinds: ['ralph'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      const step = done.steps.find((s) => s.agentKind === 'ralph')!
      expect(step.state).toBe('done')
      // Looped exactly three iterations: fail, fail, pass.
      expect(step.ralph?.attempts).toBe(3)
      expect(step.ralph?.attemptLog).toHaveLength(3)
      expect(step.ralph?.attemptLog?.[0]?.validationPassed).toBe(false)
      expect(step.ralph?.attemptLog?.at(-1)?.validationPassed).toBe(true)
      expect(step.ralph?.lastExitCode).toBe(0)
    })

    it('gives up a ralph loop that never passes, at its iteration budget', async () => {
      // The validation never passes (target far above the budget), so the loop must exhaust
      // its 2-iteration budget and fail the run for a human rather than spinning forever.
      const app = harness.makeApp({
        asyncKinds: ['ralph'],
        ralphPassOnIteration: 99,
        pullRequest: ralphPr,
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Ralph never-passes',
        taskType: 'ralph',
        agentConfig: {
          'ralph.validationCommand': 'exit 1',
          'ralph.maxIterations': '2',
        },
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Ralph only',
        agentKinds: ['ralph'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const failed = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      const step = failed.steps.find((s) => s.agentKind === 'ralph')!
      expect(failed.status).toBe('failed')
      expect(step.state).not.toBe('done')
      // Ran exactly the budgeted number of iterations, no more.
      expect(step.ralph?.attempts).toBe(2)
      // The block is left blocked for a human (never falsely done).
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(snap.blocks.find((b) => b.id === task.body.id)?.status).toBe('blocked')
    })

    it('refuses to start a ralph pipeline with no validation command', async () => {
      // A ralph loop is meaningless without a programmatic completion criterion — the engine
      // rejects the start rather than dispatching a validation-less coding pass.
      const app = harness.makeApp({ asyncKinds: ['ralph'] })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Ralph unconfigured',
        taskType: 'ralph',
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Ralph only',
        agentKinds: ['ralph'],
      })
      const start = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      // A validation error (missing completion criterion) — refused, run never started.
      expect(start.status).toBe(422)
    })
  })
}
