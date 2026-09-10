import { PipelineRegistry } from '@cat-factory/kernel'
import {
  type Block,
  type BugFishingStepState,
  type ExecutionInstance,
  type RepoContentEntry,
  type RepoFiles,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

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

/**
 * The `bug-fishing` decision as `/api/v1` serves it, plus the list it arrives in.
 *
 * Declared structurally here rather than imported, on the same footing as the PR review's twin:
 * this package depends on kernel and not on the public contracts, and a suite that asserted
 * against the very schema the projection is built from would pass on a projection that dropped
 * half of it. What is written out is what an integrator reads.
 */
type PublicBugFishingDecision = {
  kind: string
  status: string
  stepIndex: number
  phases: { phaseId: string; title: string; status: string }[]
  findings: {
    findingId: string
    path: string
    severity: string
    evidence: string | null
    dismissed: boolean
    spawn: { status: string; taskId: string; pipelineId: string } | null
  }[]
  defaultFixPipelineId: string | null
}

type PublicDecisionListBody = {
  parked: boolean
  decisions: (PublicBugFishingDecision & { kind: string })[]
  unanswerable: { reason: string }[]
}

/**
 * The phase a given territory was fished under.
 *
 * A function rather than an inline `find(...)!`, so a partition that produced no phase for the
 * territory fails naming the territory instead of dereferencing undefined three assertions later.
 */
function phaseForTerritory(state: BugFishingStepState, territoryId: string) {
  const phase = (state.phases ?? []).find((p) => p.territoryId === territoryId)
  if (!phase) throw new Error(`no phase was recorded for territory ${territoryId}`)
  return phase
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

      // With no board setting, the default a mark takes is the built-in TEST-VERIFIED bug-fix
      // preset: a fished defect has no reporter to reproduce it with, so the committed regression
      // test is the deliverable.
      expect(state.defaultFixPipelineId).toBe('pl_bugfix_tested')

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
      // Give the host service its standing standards, so the spawned fix task has something to
      // inherit: a task-level run folds only its OWN `fragmentIds` and never re-unions the
      // service's, which is exactly why a spawn has to be handed them at creation.
      await call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        serviceFragmentIds: ['node.best-practices'],
      })
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
      expect(spawn?.pipelineId).toBe('pl_bugfix_tested')
      expect(spawn?.taskId).toBeTruthy()
      // SETTLED, not merely present. The record is written first as a `pending` claim (which is
      // what makes two markings of one finding safe), so a caller that read only its presence
      // could not tell a fix task that exists from one being made.
      expect(spawn?.status).toBe('spawned')

      // The board is read through the snapshot (there is no single-block GET), which is also the
      // surface a person would see the new card on.
      const board = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const spawned = board.body.blocks.find((b) => b.id === spawn!.taskId)!
      expect(spawned).toBeTruthy()
      expect(spawned.expeditionId).toBe(task.body.id)
      expect(spawned.parentId).toBe('blk_auth')
      expect(spawned.taskType).toBe('bug')
      expect(spawned.pipelineId).toBe('pl_bugfix_tested')
      // The finding's own body reaches the fix task, so its investigator starts from what the
      // expedition found rather than from a title.
      expect(spawned.description).toContain('src/session.ts')
      expect(spawned.executionId).toBeTruthy()
      // The spawned task is created the way the CREATE FORM would have created it under this
      // service, not as a bare block: the service's standing standards ride along, so a fix
      // spawned from a finding is held to exactly the standards the same bug filed by hand
      // would have been.
      expect(spawned.fragmentIds).toContain('node.best-practices')

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

      // The finding is still MARKABLE after both refusals, which is what makes "loudly" useful
      // rather than merely honest. The first refused before taking a claim at all; the second
      // took one, could not start the run behind it, and RELEASED it as `failed` carrying the
      // cause — never left `pending`, which would read as a fix somebody is working on.
      const untouched = await call<BugFishingStepState>(
        'GET',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing`,
      )
      const releasedSpawn = untouched.body.findings?.[0]?.spawn
      expect(releasedSpawn === null || releasedSpawn?.status === 'failed').toBe(true)

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

    it('spawns onto a fix pipeline the board was never seeded with', async () => {
      // The regression this exists for: built-ins are COPIED into a workspace at creation, so a
      // board older than a preset holds no row for it, and the fix pipeline a mark resolves to is
      // a built-in. Validating it with a point read at the repository therefore answered "deleted"
      // for a pipeline nobody had ever been offered, and refused every marking on every board that
      // predated the preset. It resolves through `PipelineAdoption` instead, which is the same
      // rule the start path adopts by.
      //
      // Driven as two apps over ONE store, the `agent-task-types` adoption pattern: a board seeded
      // while the pipeline does not exist, then an app that knows it. A board created afterwards
      // would hold the row and prove nothing.
      const before = harness.makeApp({ customResult: fisherOutput })
      const { workspace } = await before.createWorkspace({ seed: true })
      const wsId = workspace.id

      const registry = new PipelineRegistry()
      registry.register({
        id: 'pl_conf_unadopted_fix',
        name: 'Unadopted fix',
        purpose: 'bugfix',
        builtin: true,
        version: 1,
        agentKinds: ['coder'],
      })
      const { call, drive } = harness.makeApp(
        { customResult: fisherOutput },
        { pipelineRegistry: registry },
      )
      const unadopted = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(unadopted.body.pipelines.map((p) => p.id)).not.toContain('pl_conf_unadopted_fix')

      const settings = await call('PUT', `/workspaces/${wsId}/settings`, {
        bugFishingFixPipelineId: 'pl_conf_unadopted_fix',
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
      const findings = state.findings ?? []

      const marked = await call<BugFishingStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[0]!.id] },
      )
      expect(marked.status).toBe(200)
      expect(marked.body.findings?.[0]?.spawn?.pipelineId).toBe('pl_conf_unadopted_fix')
      expect(marked.body.findings?.[0]?.spawn?.executionId).toBeTruthy()

      // Starting it ADOPTED the row, so the board's own library can now show what ran. An id
      // NOTHING defines is still refused, which is the case the read must keep answering.
      const after = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      expect(after.body.pipelines.map((p) => p.id)).toContain('pl_conf_unadopted_fix')
      const bogus = await call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/bug-fishing/address`,
        { findingIds: [findings[1]!.id], pipelineId: 'pl_nothing_defines_this' },
      )
      expect(bogus.status).toBe(422)
    })

    // The territory half of the flow is its own suite: same harness, same describe-level
    // contract, split out because one function may not carry both and a suite that grows a
    // dimension is exactly what the budget is a trigger for. The public-API half is split for the
    // same reason and answers a different question: not what the expedition does, but what an
    // integration outside the app can do with it.
    defineTerritoryCases(harness)
    definePublicTriageCase(harness)
  })
}

/**
 * The same expedition, triaged entirely through `/api/v1`: the door an integration that renders a
 * catch in its own tracker actually uses.
 *
 * Here rather than only in a unit test for the reason the PR review's public case gives, and one
 * more of its own. Everything AROUND the shared projection is per-facade: the expedition rides the
 * run's step JSON through each facade's own execution mapper, and the key store the `decide` scope
 * is read from is a per-runtime table, so a facade that mounted the routes and mapped the step
 * differently would answer with an empty catch while the shared projection stayed green. And the
 * verb under test CREATES work: marking a finding inserts a board block and starts its run, which
 * is the half that crosses the board repository and the run-start funnel.
 *
 * The last assertion is the one that closes the gap this surface had. A parked expedition used to
 * be reported in `unanswerable[]` as a `curation_gate` while its ordinary approval WAS offered, so
 * the only thing an integration could do with it was end it and lose the catch.
 */
function definePublicTriageCase(harness: ConformanceHarness): void {
  it('serves the catch, marks a finding and finishes triage over /api/v1', async () => {
    const app = harness.makeApp({ customResult: fisherOutput })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Fish for bugs in auth',
      taskType: 'bug-fishing',
      taskTypeFields: { fishingPhaseIds: ['control-flow'] },
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
      pipelineId: 'pl_bug_fishing',
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
    const decideAuth = await mintPublicApiKey(app, wsId, 'decide', 'bug-fishing')

    const readCatch = async () => {
      const listed = await app.call<PublicDecisionListBody>(
        'GET',
        `/api/v1/runs/${parked.id}/decisions`,
        undefined,
        decideAuth,
      )
      expect(listed.status).toBe(200)
      return listed.body
    }

    const first = await readCatch()
    const expedition = first.decisions.find((d) => d.kind === 'bug-fishing')!
    expect(expedition.status).toBe('awaiting_triage')
    // Severity-ordered and id-stamped, with the evidence carried apart from the prose: a caller
    // triaging has to be able to see which findings the agent could point at code for.
    expect(expedition.findings.map((f) => f.severity)).toEqual(['critical', 'low'])
    expect(expedition.findings[0]!.evidence).toContain('src/session.ts:42')
    expect(expedition.findings[0]!.spawn).toBeNull()
    expect(expedition.phases.map((p) => p.phaseId)).toEqual(['control-flow'])
    expect(expedition.defaultFixPipelineId).toBe('pl_bugfix_tested')
    // The gap this closes: a parked expedition is a DECISION here, not a wait the surface names
    // and cannot answer. Both halves are asserted, because the two are built from one table and a
    // regression that re-listed it would also go on offering these verbs.
    expect(first.unanswerable.map((w) => w.reason)).not.toContain('curation_gate')

    // MARK one finding. The response is the whole decision list re-read, so the spawn is visible
    // without a follow-up call.
    const marked = await app.call<PublicDecisionListBody>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/bug-fishing/address`,
      { findingIds: [expedition.findings[0]!.findingId] },
      decideAuth,
    )
    expect(marked.status).toBe(200)
    const afterMark = marked.body.decisions.find((d) => d.kind === 'bug-fishing')!
    const spawn = afterMark.findings.find(
      (f) => f.findingId === expedition.findings[0]!.findingId,
    )!.spawn
    // SETTLED, not merely present: the record is written first as a `pending` claim, so a caller
    // reading only its presence could not tell a fix task that exists from one being made.
    expect(spawn?.status).toBe('spawned')
    expect(spawn?.pipelineId).toBe('pl_bugfix_tested')
    // …and the task it names is addressable through this same API, which is how an integration
    // follows the work its own marking created.
    const spawned = await app.call<{ taskId: string }>(
      'GET',
      `/api/v1/tasks/${spawn!.taskId}`,
      undefined,
      decideAuth,
    )
    expect(spawned.status).toBe(200)

    // Dismissing leaves the finding on the record, struck through, and the run parked.
    const dismissed = await app.call<PublicDecisionListBody>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/bug-fishing/findings/${expedition.findings[1]!.findingId}/dismiss`,
      undefined,
      decideAuth,
    )
    expect(dismissed.status).toBe(200)
    const afterDismiss = dismissed.body.decisions.find((d) => d.kind === 'bug-fishing')!
    expect(afterDismiss.findings).toHaveLength(2)
    expect(afterDismiss.findings[1]!.dismissed).toBe(true)
    expect(afterDismiss.status).toBe('awaiting_triage')

    // Finishing advances the run past the read-only step, and the expedition leaves the decision
    // list because there is nothing left to answer.
    const resolved = await app.call<PublicDecisionListBody>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/bug-fishing/resolve`,
      undefined,
      decideAuth,
    )
    expect(resolved.status).toBe(200)
    expect(resolved.body.decisions.find((d) => d.kind === 'bug-fishing')).toBeUndefined()
    await app.drive(wsId)
    const board = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(board.body.blocks.find((b) => b.id === task.body.id)?.status).toBe('done')
  })

  it('refuses the triage verbs for a key that cannot decide', async () => {
    // Marking a finding STARTS a run, so it sits at `decide` beside every other park answer rather
    // than at the `write` that authors tasks. Asserted on the surface an integrator actually meets:
    // a `write` key reads the catch and is refused the moment it acts on one.
    const app = harness.makeApp({ customResult: fisherOutput })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Fish for bugs in auth',
      taskType: 'bug-fishing',
      taskTypeFields: { fishingPhaseIds: ['control-flow'] },
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
      pipelineId: 'pl_bug_fishing',
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
    const writeAuth = await mintPublicApiKey(app, wsId, 'write', 'bug-fishing')

    const listed = await app.call<PublicDecisionListBody>(
      'GET',
      `/api/v1/runs/${parked.id}/decisions`,
      undefined,
      writeAuth,
    )
    expect(listed.status).toBe(200)
    const findings = listed.body.decisions.find((d) => d.kind === 'bug-fishing')!.findings
    const refused = await app.call(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/bug-fishing/address`,
      { findingIds: [findings[0]!.findingId] },
      writeAuth,
    )
    expect(refused.status).toBe(403)
  })
}

/**
 * TERRITORIES: a codebase too large to fish whole is partitioned by the platform, and every
 * angle runs once per territory.
 *
 * This is the half that cannot be unit-tested, because it crosses the run-repo resolution, the
 * tree read, the phase loop and the persisted step blob: a facade that mapped `territoryId` off
 * the phase row would still pass every pure reduction's test and lose the whole partition on a
 * real run.
 */
function defineTerritoryCases(harness: ConformanceHarness): void {
  it('partitions a large codebase into territories and fishes each angle per territory', async () => {
    // Two directories, each far past the per-territory ceiling, so the survey cannot pack them
    // together. Sizes come from the tree's blob bytes, which is what the real provider reports.
    const bigFile = (path: string): RepoContentEntry => ({
      path,
      name: path.split('/').pop()!,
      type: 'file',
      sha: `sha-${path}`,
      size: 200_000,
    })
    const entries: RepoContentEntry[] = [
      { path: 'billing', name: 'billing', type: 'dir', sha: 'tree-billing' },
      { path: 'sessions', name: 'sessions', type: 'dir', sha: 'tree-sessions' },
      ...Array.from({ length: 4 }, (_, i) => bigFile(`billing/invoice${i}.ts`)),
      ...Array.from({ length: 4 }, (_, i) => bigFile(`sessions/store${i}.ts`)),
      // Excluded by the ignore vocabulary: a vendored tree is not code this repository wrote,
      // so a territory packed with it would be budget spent on nothing.
      bigFile('node_modules/left-pad/index.js'),
    ]
    const repo: RepoFiles = {
      getFile: async () => null,
      listDirectory: async () => [],
      listTree: async () => ({ entries, truncated: false }),
      headSha: async () => 'base-sha',
      createBranch: async () => {},
      deleteBranch: async () => {},
      commitFiles: async () => ({ sha: 'commit-sha' }),
      openPullRequest: async () => {
        throw new Error('not exercised by this test')
      },
    }
    // Every pass returns findings anchored in `billing`, which is one territory's ground and
    // not the other's. That is what makes the assertions below about the PARTITION rather than
    // about the loop: the billing pass keeps them, and the sessions pass has them dropped and
    // COUNTED, which is the platform holding a wandering pass to its territory.
    const billingOutput = {
      summary: 'Read the invoice write paths.',
      filesRead: ['billing/invoice0.ts', 'billing/invoice1.ts'],
      findings: [
        {
          path: 'billing/invoice0.ts',
          line: 12,
          severity: 'critical',
          kind: 'bug',
          confidence: 'high',
          title: 'Invoice total is recomputed after the ledger write',
          detail: 'A corrected line item never reaches the ledger row.',
        },
        {
          path: 'billing/invoice1.ts',
          severity: 'low',
          kind: 'footgun',
          confidence: 'medium',
          title: 'roundCents clamps instead of refusing',
          detail: 'A negative amount silently becomes zero.',
        },
      ],
    }
    const { call, createWorkspace, drive } = harness.makeApp(
      { customResult: billingOutput },
      { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
    )
    const { workspace } = await createWorkspace({ seed: true })
    const wsId = workspace.id

    const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Fish the whole service',
      taskType: 'bug-fishing',
      // One angle, so the matrix is exactly one pass per territory and the assertion below is
      // about the PARTITION rather than about the angle list.
      taskTypeFields: { fishingPhaseIds: ['control-flow'] },
    })
    await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
      pipelineId: 'pl_bug_fishing',
    })
    const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
    const state = parked.steps.find((s) => s.agentKind === 'bug-fisher')!.bugFishing!

    // The partition is on the record as DESCRIPTORS, never file lists: the state rides the run
    // blob, re-serialised on every progress write.
    const territories = state.territories ?? []
    expect(territories.map((t) => t.label).sort()).toEqual(['billing', 'sessions'])
    expect(territories.every((t) => (t.fileCount ?? 0) === 4)).toBe(true)
    // The subtree sha comes free with the tree read and is what a later run compares against.
    expect(territories.every((t) => (t.subtreeShas ?? []).every((sha) => sha.length > 0))).toBe(
      true,
    )

    // ONE run, whose phase list is territory x angle, TERRITORY-MAJOR: every phase carries the
    // territory it fished plus the label it fished under, so a territory a later survey no
    // longer produces still renders from what this run recorded.
    expect(state.phases).toHaveLength(2)
    expect(state.phases?.every((p) => p.id === 'control-flow')).toBe(true)
    expect(state.phases?.map((p) => p.territoryId).sort()).toEqual(
      territories.map((t) => t.id).sort(),
    )
    expect(state.phases?.every((p) => (p.territoryLabel ?? '').length > 0)).toBe(true)
    expect(state.phases?.every((p) => p.status === 'completed')).toBe(true)

    // Each pass's findings are stamped with the territory that pass owned, which is what lets
    // the window group a catch by module and the next pass be briefed with only its own. Both
    // passes reported the same `billing` findings, and only the billing pass's were kept: a
    // finding outside a pass's territory is another pass's to file, so filing it twice is what
    // the drop prevents.
    const billing = territories.find((t) => t.label === 'billing')!
    const sessions = territories.find((t) => t.label === 'sessions')!
    const findings = state.findings ?? []
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => f.territoryId === billing.id)).toBe(true)

    // The drop is COUNTED, never silent: a territory that came back clean and one whose pass
    // spent its findings on somebody else's code have to read differently.
    const sessionsPhase = phaseForTerritory(state, sessions.id)
    expect(sessionsPhase.outOfScopeFindings).toBe(2)
    expect(sessionsPhase.summary).toContain('territory')

    // Coverage is a computed record, and honest about being self-reported. The billing pass
    // read two of its four manifest files; the sessions pass read none of ITS four and reported
    // two paths that are not on its manifest at all.
    const billingPhase = phaseForTerritory(state, billing.id)
    expect(billingPhase.coverage).toEqual({
      filesRead: 2,
      manifestFiles: 4,
      offManifest: 0,
      source: 'self-reported',
    })
    expect(sessionsPhase.coverage).toMatchObject({ filesRead: 0, offManifest: 2 })

    // The plan says what was planned and what the budget cut. Nothing was cut here (two cells,
    // a budget of twenty-four), and an empty `unfished` is the honest answer for that.
    expect(state.plan?.plannedCells).toBe(2)
    expect(state.plan?.unfished).toEqual([])
    expect(state.plan?.treeTruncated).toBe(false)
    expect(state.plan?.surveyUnavailableReason ?? null).toBeNull()
  })

  // The PASS-THROUGH, asserted rather than assumed: with no repository to survey, the
  // expedition is field-for-field the one that shipped before territories existed, and it SAYS
  // it could not survey rather than presenting itself as a small codebase.
  it('fishes an unsurveyable codebase whole, and says why', async () => {
    const { call, createWorkspace, drive } = harness.makeApp({ customResult: fisherOutput })
    const { workspace } = await createWorkspace({ seed: true })
    const wsId = workspace.id
    const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Fish for bugs',
      taskType: 'bug-fishing',
      taskTypeFields: { fishingPhaseIds: ['control-flow', 'concurrency'] },
    })
    await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
      pipelineId: 'pl_bug_fishing',
    })
    const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
    const state = parked.steps.find((s) => s.agentKind === 'bug-fisher')!.bugFishing!
    expect(state.phases?.map((p) => p.id)).toEqual(['control-flow', 'concurrency'])
    expect(state.phases?.every((p) => (p.territoryId ?? null) === null)).toBe(true)
    expect(state.findings?.every((f) => (f.territoryId ?? null) === null)).toBe(true)
    // An unsurveyable codebase and a small one are the same VALUE and opposite FACTS; only the
    // reason tells them apart.
    expect(state.plan?.surveyUnavailableReason).toBeTruthy()
  })
}
