import {
  type Block,
  type BugFishingStepState,
  type ExecutionInstance,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Bug-fishing expedition: the per-ANGLE phase loop, the park, and the triage that spawns a bug-fix
// task per marked finding — asserted identically against every facade.
//
// Three properties are the point of the suite, and none of them is visible from one dispatch:
//
//  1. ONE step is dispatched once per angle, and each pass's catch accumulates rather than
//     replacing the last (the loop re-arms the step, which is why `bugFishing` has to survive
//     `resetStepForRerun`).
//  2. The run PARKS once the last angle settles, rather than finishing, so the catch is triaged.
//  3. MARKING a finding creates a real task block linked back to the expedition and starts its
//     run on the resolved fix pipeline — which is the half a unit test cannot reach, since it
//     crosses the board repository, the run-start funnel and the settings store.

/** One angle's catch, returned by the fake agent as `result.custom` on every dispatch. */
const fisherOutput = {
  summary: 'Read the write paths under src/; two things do not hold.',
  findings: [
    {
      path: 'src/session.ts',
      line: 42,
      severity: 'critical',
      kind: 'bug',
      confidence: 'high',
      title: 'Session cache is never invalidated on logout',
      detail: 'The cached session survives the logout write, so a revoked token keeps resolving.',
      failureScenario: 'Log in, log out, replay the old token within the TTL.',
      evidence: 'src/session.ts:42 writes the store but never calls caches.session.invalidate.',
      suggestedFix: 'Invalidate the entry on the same path that writes the revocation.',
    },
    {
      path: 'src/util.ts',
      severity: 'low',
      kind: 'footgun',
      confidence: 'medium',
      title: 'parseRange silently clamps instead of refusing',
      detail: 'A caller passing an inverted range gets an empty result rather than an error.',
    },
  ],
}

export function defineBugFishingSuite(harness: ConformanceHarness): void {
  describe('bug-fishing expedition (per-angle loop → park → triage spawns fix tasks)', () => {
    it('fishes each angle in turn, parks on the catch, and spawns a linked fix task per mark', async () => {
      const { call, createWorkspace, drive } = harness.makeApp({ customResult: fisherOutput })
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id

      // Two angles rather than the whole catalog: the loop is what is under test, and two
      // dispatches prove it as well as eight while keeping the fixture readable.
      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Fish for bugs in auth',
        taskType: 'bug-fishing',
        taskTypeFields: {
          fishingPhaseIds: ['control-flow', 'concurrency'],
          fishingFocus: 'the session store',
        },
      })
      expect(task.status).toBe(201)
      const start = await call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: 'pl_bug_fishing' },
      )
      expect(start.status).toBe(201)

      // Driving runs BOTH angles (the step is re-armed between them) and then parks.
      const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(parked.status).toBe('blocked')
      const step = parked.steps.find((s) => s.agentKind === 'bug-fisher')!
      const state = step.bugFishing!
      expect(state.status).toBe('awaiting_triage')

      // The plan is the creator's selection, in CATALOG order, each phase carrying the title it
      // ran under rather than a lookup the window would have to make.
      expect(state.phases?.map((p) => p.id)).toEqual(['control-flow', 'concurrency'])
      expect(state.phases?.every((p) => p.status === 'completed')).toBe(true)
      expect(state.phases?.[0]?.title).toBeTruthy()
      expect(state.phases?.[0]?.summary).toBe(fisherOutput.summary)

      // Both passes' findings ACCUMULATED (2 per angle), id-stamped, severity-ordered within a
      // pass, and each stamped with the angle that surfaced it. Accumulation is the assertion
      // that matters: the loop re-arms the same step, so a state that did not survive
      // `resetStepForRerun` would leave only the last angle's catch here.
      const findings = state.findings ?? []
      expect(findings).toHaveLength(4)
      expect(findings.every((f) => f.id.startsWith('bff_'))).toBe(true)
      expect(findings.map((f) => f.phaseId)).toEqual([
        'control-flow',
        'control-flow',
        'concurrency',
        'concurrency',
      ])
      expect(findings.slice(0, 2).map((f) => f.severity)).toEqual(['critical', 'low'])
      expect(findings[0]!.evidence).toContain('caches.session.invalidate')

      // With no board setting, the default a mark takes is the built-in bug-fix preset.
      expect(state.defaultFixPipelineId).toBe('pl_bugfix')

      // The park raised the triage card, counting what is left to decide rather than the total.
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const card = snap.body.notifications?.find((n) => n.type === 'bug_fishing_triage')
      expect(card).toBeTruthy()
      expect(card?.payload?.phaseCount).toBe(2)
      expect(card?.payload?.untriagedFindingCount).toBe(4)

      // The GET returns the same active state.
      const active = await call<BugFishingStepState>(
        'GET',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing`,
      )
      expect(active.body.status).toBe('awaiting_triage')
      expect(active.body.findings).toHaveLength(4)
    })

    it('spawns a linked fix task per marked finding, and finishes triage to a terminal run', async () => {
      const { call, createWorkspace, drive } = harness.makeApp({ customResult: fisherOutput })
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id
      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Fish for bugs in auth',
        taskType: 'bug-fishing',
        taskTypeFields: { fishingPhaseIds: ['control-flow'] },
      })
      await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: 'pl_bug_fishing',
      })
      const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      const findings =
        parked.steps.find((s) => s.agentKind === 'bug-fisher')!.bugFishing!.findings ?? []

      // MARK one finding: a bug-fix task is created under the SAME service frame, linked back to
      // the expedition, and started on the resolved pipeline.
      const marked = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id] },
      )
      expect(marked.status).toBe(200)
      const spawn = marked.body.findings?.find((f) => f.id === findings[0]!.id)?.spawn
      expect(spawn?.pipelineId).toBe('pl_bugfix')
      expect(spawn?.taskId).toBeTruthy()

      // The board is read through the snapshot (there is no single-block GET), which is also the
      // surface a person would see the new card on.
      const board = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const spawned = board.body.blocks.find((b) => b.id === spawn!.taskId)!
      expect(spawned).toBeTruthy()
      expect(spawned.expeditionId).toBe(task.body.id)
      expect(spawned.parentId).toBe('blk_auth')
      expect(spawned.taskType).toBe('bug')
      expect(spawned.pipelineId).toBe('pl_bugfix')
      // The finding's own body reaches the fix task, so its investigator starts from what the
      // expedition found rather than from a title.
      expect(spawned.description).toContain('src/session.ts')
      expect(spawned.executionId).toBeTruthy()

      // A second mark of the SAME finding is refused rather than double-spawning.
      const again = await call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id] },
      )
      expect(again.status).toBe(409)

      // Dismissing leaves the finding on the record, struck through, and unspawnable.
      const dismissed = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/findings/${findings[1]!.id}/dismiss`,
        {},
      )
      expect(dismissed.status).toBe(200)
      expect(dismissed.body.findings?.find((f) => f.id === findings[1]!.id)?.dismissed).toBe(true)
      expect(dismissed.body.findings).toHaveLength(2)

      // Finishing triage advances the run past the read-only step to a terminal state. The
      // pipeline has no merger and opens no PR, so the block reaches `done` through the engine's
      // no-PR completion path rather than stalling at `pr_ready`.
      const resolved = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/resolve`,
        {},
      )
      expect(resolved.status).toBe(200)
      expect(resolved.body.status).toBe('done')
      await drive(wsId)
      const finished = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(finished.body.blocks.find((b) => b.id === task.body.id)?.status).toBe('done')
    })

    it("honours the board's configured fix pipeline, and the caller's per-batch override", async () => {
      const { call, createWorkspace, drive } = harness.makeApp({ customResult: fisherOutput })
      const { workspace } = await createWorkspace({ seed: true })
      const wsId = workspace.id

      // The board pins a different fix pipeline. Nothing about the expedition changes; only what
      // a marked finding's task runs.
      const settings = await call('PUT', `/workspaces/${wsId}/settings`, {
        bugFishingFixPipelineId: 'pl_build',
      })
      expect(settings.status).toBe(200)

      const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Fish for bugs',
        taskType: 'bug-fishing',
        taskTypeFields: { fishingPhaseIds: ['control-flow'] },
      })
      await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: 'pl_bug_fishing',
      })
      const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
      const state = parked.steps.find((s) => s.agentKind === 'bug-fisher')!.bugFishing!
      // The resolved default is recorded on the expedition when it is PLANNED, so the window can
      // state what a mark will run before anything is created.
      expect(state.defaultFixPipelineId).toBe('pl_build')
      const findings = state.findings ?? []

      // A pipeline the workspace does not hold is REFUSED naming it, rather than silently
      // falling back onto a preset nobody chose.
      const missing = await call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id], pipelineId: 'pl_does_not_exist' },
      )
      expect(missing.status).toBe(422)

      // A pipeline that EXISTS but cannot be STARTED on a one-off task (the recurring bug-triage
      // preset) fails loudly too. It is the case a silent "the finding just stays untriaged"
      // would have hidden: the request reports done and nobody is waiting on a task that is never
      // going to appear.
      const unstartable = await call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id], pipelineId: 'pl_bug_triage' },
      )
      expect(unstartable.status).toBeGreaterThanOrEqual(400)

      // Neither refusal recorded a spawn, so the finding is still markable — which is what makes
      // "loudly" useful rather than merely honest.
      const untouched = await call<BugFishingStepState>(
        'GET',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing`,
      )
      expect(untouched.body.findings?.[0]?.spawn).toBeFalsy()

      // A mark with no override takes the board's setting…
      const first = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id] },
      )
      expect(first.body.findings?.[0]?.spawn?.pipelineId).toBe('pl_build')

      // …and one naming a pipeline takes that, for this batch only.
      const second = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[1]!.id], pipelineId: 'pl_bugfix' },
      )
      expect(second.body.findings?.[1]?.spawn?.pipelineId).toBe('pl_bugfix')
    })
  })
}
