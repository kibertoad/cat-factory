import { describe, expect, it } from 'vitest'
import type {
  ExecutionInstance,
  Pipeline,
  RiskPolicy,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type { ConformanceHarness } from '../harness.js'

// Execution-engine conformance: the COMPANION loop — a verdict on the preceding step's work, and
// what happens when the loop cannot get that verdict to a pass.
//
// Split out of `execution-review.ts` when that file crossed its size budget again, along the seam
// its neighbour `execution-failures.ts` had already found: the review slice is about the gates a
// run passes THROUGH, and this is about one gate's own rework machine. The two halves of that
// machine belong together, because the pass rule and the cap rule are the same decision seen at
// two budgets (kernel's `disposeCompanionVerdict`), and a change to one that forgot the other is
// exactly what these assertions catch.
export function defineExecutionCompanionConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    registerCompanionGateTests(harness)
    registerCompanionCapTests(harness)
  })
}

/**
 * The producer/companion review gates: a verdict ON the preceding step's work. The merger's own
 * decision policy sits in `execution-review.ts`, and a job that never delivered work to grade is
 * `execution-failures.ts`.
 *
 * Registered from the suite above; the tests are unchanged by the move.
 */
function registerCompanionGateTests(harness: ConformanceHarness): void {
  it('passes a companion gate when the rating clears the threshold', async () => {
    // A companion step grades the prior producer; at/above its threshold the run
    // proceeds. `reviewer` is the coder's companion, so ['coder','reviewer'] runs the
    // coder then grades it — a passing rating (default 1) finishes the run.
    const app = harness.makeApp({ confidence: 1 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + companion',
      purpose: 'build',
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

  it('holds the run on a MUST-FIX finding the reviewer graded, whatever the rating said', async () => {
    // The gap graded findings close. A rating is one number over a whole deliverable, so a review
    // can score work above its bar and still have named something that must not ship — and every
    // rating this critic returns (0.9, against a 0.8 bar) is a pass. With the point graded
    // `blocker` the loop reworks the producer instead, spends its whole budget failing to get it
    // closed, and stops at a person rather than advancing on the score.
    const app = harness.makeApp({
      confidence: 1,
      companionRating: 0.9,
      companionBlockingFinding: true,
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + blocking companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

    // Parked for a person, not advanced and not failed.
    expect(exec.status).toBe('blocked')
    expect(exec.failure).toBeFalsy()
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    expect(companionStep.state).toBe('waiting_decision')
    expect(companionStep.companion?.exceeded).toBe(true)
    // Every round rated ABOVE the bar and none of them passed, which is the whole point: the
    // severity decided this, not the score. The blocker is stored on the verdict beside it, which
    // is what makes that pair readable rather than looking like a bug.
    const verdicts = companionStep.companion?.verdicts ?? []
    expect(verdicts.length).toBeGreaterThan(0)
    expect(verdicts.every((v) => v.rating > v.threshold)).toBe(true)
    expect(verdicts.every((v) => !v.passed)).toBe(true)
    expect(verdicts.at(-1)?.comments?.some((c) => c.severity === 'blocker')).toBe(true)
  })

  it('always loops the producer on the FIRST batch when the review raised comments, even above threshold', async () => {
    // First review batch: ANY comments loop the producer back regardless of rating —
    // so the first round of findings is always handed to the implementer. The
    // threshold only governs the SECOND pass onward. A steady 0.85 (above the 0.8
    // bar) WITH comments therefore loops once, then passes the second grade.
    const app = harness.makeApp({ confidence: 1, companionRatings: [0.85, 0.85] })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + first-batch companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('done')
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    // First batch failed despite clearing the threshold (forced loop), second passed.
    expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
    expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.85)).toBe(true)
    expect(companionStep.companion?.attempts).toBe(1)
  })

  it('genuinely RE-RUNS both sides of the loop on a container-reusing runner', async () => {
    // The regression the dispatch epoch exists for, end to end. `pooledContainer` models a runner
    // whose harness `JobRegistry` survives between rounds (reclaiming a pooled member does NOT
    // destroy it), so a re-dispatch under an already-used job id re-attaches and REPLAYS the
    // earlier round's completed result: no container session, no model call. On a real run that
    // froze an `architect` under its companion at 0.76 for four rounds while the companion, itself
    // replayed, re-graded a byte-identical artifact and correctly never moved its rating.
    //
    // 0.7 then 0.9 is the tell. Round 2 can only read the SECOND rating if the reviewer's job is
    // genuinely fresh, so a run that converges here is one where both the producer and the
    // reviewer actually re-ran. Both are async so both mint job ids; the epochs assert the
    // mechanism directly, since a REPLAYED round is otherwise invisible from the outside.
    const dispatched: { agentKind: string; epoch: number }[] = []
    const app = harness.makeApp({
      asyncKinds: ['coder', 'reviewer'],
      asyncPolls: 1,
      pooledContainer: true,
      companionRatings: [0.7, 0.9],
      onContext: (c) => dispatched.push({ agentKind: c.agentKind, epoch: c.dispatchEpoch ?? 0 }),
      pullRequest: { url: 'https://gh/pr/7', number: 7, branch: 'cat-factory/task_login' },
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + companion rework',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)

    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('done')
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    // Round 1 rated 0.7 (below the 0.8 bar → rework), round 2 read the NEXT rating and passed.
    expect(companionStep.companion?.verdicts.map((v) => v.rating)).toEqual([0.7, 0.9])
    expect(companionStep.companion?.attempts).toBe(1)
    // The producer really was sent twice, under two different job ids.
    const coderEpochs = dispatched.filter((d) => d.agentKind === 'coder').map((d) => d.epoch)
    expect(coderEpochs).toEqual([0, 1])
    expect(dispatched.filter((d) => d.agentKind === 'reviewer').map((d) => d.epoch)).toEqual([0, 1])
  })

  it('fails the run when a companion verdict cannot be parsed (no silent 100% pass)', async () => {
    // The bug: a truncated/malformed reviewer reply was silently treated as a perfect
    // pass (rating 1 ≥ threshold) and the real review was dropped. Now an unparseable
    // verdict — even after the repair retry — fails the run for human attention.
    const app = harness.makeApp({ confidence: 1, companionMalformed: true })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + unparseable companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('failed')
    expect(exec.failure?.kind).toBe('companion_rejected')
    // The RICH failure record survives the drive: the driver funnels the inline gate's
    // `job_failed` through the single `failRun` with the gate's own kind/message/detail,
    // and never re-fails the (already-failed) run with a generic record. Guards the
    // regression where a second `failRun` clobbered this with kind `job_failed`,
    // message "companion_rejected" and a misleading "container reported a failure" hint.
    expect(exec.failure?.message).toContain('did not return a parseable assessment')
    // The companion's raw (unparseable) reply is stored as the detail for triage —
    // the whole point of the failure, lost when the record was clobbered.
    expect(exec.failure?.detail).toContain('my reply got cut off')
    // The companion step was NOT marked done / passed off as a clean review.
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    expect(companionStep.state).not.toBe('done')
  })
}

/**
 * What happens when a companion's loop stops: its rework budget spent, or a must-fix finding it
 * could not get closed. Either way a person picks — one more round, proceed with the current
 * output, or stop and reset the task to phase zero.
 *
 * Registered from the suite above; the tests are unchanged by the move.
 */
function registerCompanionCapTests(harness: ConformanceHarness): void {
  it('parks for a human when a companion spends its rework budget (no longer fails)', async () => {
    // Below the threshold the companion loops the producer back for automatic rework;
    // once the budget is spent the run no longer fails — it PARKS on the shared
    // iteration-cap gate for a human (one more round / proceed / stop & reset),
    // mirroring the requirements reviewer at its cap. A fixed low rating drives
    // straight to the cap on both runtimes.
    const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + strict companion',
      purpose: 'build',
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
    // Parked, not failed.
    expect(exec.status).toBe('blocked')
    expect(exec.failure).toBeFalsy()
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    expect(companionStep.state).toBe('waiting_decision')
    expect(companionStep.approval?.status).toBe('pending')
    expect(companionStep.companion?.exceeded).toBe(true)
    // The full automatic budget was spent before parking, and the recorded verdicts
    // carry the critic's REAL low rating (not the pass-through `1` for an unparseable
    // assessment). The fake critic emits anchor-based comments (no `quotedSource`),
    // so this also guards that `stepReviewCommentSchema` accepts the real shape.
    expect(companionStep.companion?.attempts).toBe(companionStep.companion?.maxAttempts)
    expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.4)).toBe(true)
    expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(false)

    // The generic approve resolver can't short-circuit the iteration-cap gate.
    const stray = await app.call(
      'POST',
      `/workspaces/${wsId}/executions/${exec.id}/steps/${companionStep.approval!.id}/approve`,
      {},
    )
    expect(stray.status).toBe(409)
  })

  it('spends the rework budget stated by the task risk policy, not a hard-coded one', async () => {
    // The budget is POLICY, and a step is seeded with the catalog default before any policy is
    // resolved, so the adoption happens on the companion's first grading. `0` is the value that
    // makes the whole chain observable in one run: a policy row → the task's pin → the resolved
    // preset → the step's budget → the cap branch. With the hard-coded ceiling still in force the
    // run would instead spend three rework rounds (three more container dispatches) before parking
    // in the same place, so this asserts the SPEND, which is the reason the knob exists.
    const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const policy = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
      name: 'No automatic rework',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      companionMaxReworks: 0,
    })
    expect(policy.status).toBe(201)
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      riskPolicyId: policy.body.id,
    })
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + un-reworked companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })

    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
    expect(companionStep.companion?.maxAttempts).toBe(0)
    // Not one rework round, and exactly one verdict: the companion graded, and what it found went
    // to the person this policy says decides instead of back to the coder.
    expect(companionStep.companion?.attempts).toBe(0)
    expect(companionStep.companion?.verdicts).toHaveLength(1)
    expect(companionStep.companion?.exceeded).toBe(true)
    expect(exec.status).toBe('blocked')
    expect(exec.failure).toBeFalsy()
  })

  it('grants one more round at the companion cap, then completes when it passes', async () => {
    // `extra-round` raises the budget by one and loops the producer back through the
    // companion to re-grade. Four low grades drive to the cap; the post-extra-round
    // grade passes, so the run completes — proving the human can rescue a stuck run.
    const app = harness.makeApp({
      confidence: 1,
      companionRatings: [0.4, 0.4, 0.4, 0.4, 1],
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + rescued companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(parked.status).toBe('blocked')
    const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!
    const budgetAtCap = gate.companion!.maxAttempts

    const res = await app.call(
      'POST',
      `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
      { choice: 'extra-round' },
    )
    expect(res.status).toBe(200)

    const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(done.status).toBe('done')
    const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
    // The budget was raised by exactly one and the gate is no longer flagged exceeded.
    expect(companionStep.companion?.maxAttempts).toBe(budgetAtCap + 1)
    expect(companionStep.companion?.exceeded).toBeFalsy()
    expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(true)
  })

  it('proceeds past the companion cap, advancing with the current output', async () => {
    // `proceed` accepts the producer's current (below-bar) output and advances past
    // the gate; since the companion is the final step, the run completes.
    const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + proceed companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

    const res = await app.call(
      'POST',
      `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
      { choice: 'proceed' },
    )
    expect(res.status).toBe(200)

    const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(done.status).toBe('done')
    const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
    expect(companionStep.state).toBe('done')
    expect(companionStep.companion?.exceeded).toBeFalsy()
  })

  it('stops and resets the task to phase zero at the companion cap', async () => {
    // `stop-reset` tears the run down and returns the block to `planned` (editable),
    // identical to the requirements gate's stop-reset — the same `cancel()` path.
    const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + reset companion',
      purpose: 'build',
      agentKinds: ['coder', 'reviewer'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

    const res = await app.call(
      'POST',
      `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
      { choice: 'stop-reset' },
    )
    expect(res.status).toBe(200)

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    const task = snap.blocks.find((b) => b.id === 'task_login')!
    expect(task.status).toBe('planned')
    // The run record is gone — the task is back to phase zero, editable.
    expect(snap.executions.some((e) => e.blockId === 'task_login')).toBe(false)
  })

  it('rejects a companion separated from its producer by another step (strict adjacency)', async () => {
    // A companion must run IMMEDIATELY after a producer it can review — the builder
    // surfaces companions as toggles attached to their producer, and the validation
    // enforces that adjacency on EVERY facade. ['coder','tester-api','reviewer'] slips
    // `tester` between the coder and its `reviewer` companion, so the pipeline save is
    // rejected (a `validation` domain error → 422) before any run is created.
    const app = harness.makeApp({ confidence: 1 })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const res = await app.call('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + gap companion',
      purpose: 'build',
      agentKinds: ['coder', 'deployer', 'tester-api', 'reviewer', 'disposer'],
    })
    expect(res.status).toBe(422)
  })
}
