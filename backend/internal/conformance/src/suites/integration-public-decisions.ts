import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { PipelineRegistry } from '@cat-factory/kernel'
import type { ExecutionInstance, Pipeline, WorkspaceSnapshot } from '@cat-factory/kernel'
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
// See backend/docs/adr/0047-headless-clarification-loop.md.

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
    registerApprovalAnsweringTests(harness)
    registerDialogueAnsweringTests(harness)
    registerStaleRunTests(harness)
    registerCompanionAnsweringTests(harness)
    registerCompanionEdgeTests(harness)
    registerScopeAndCancelTests(harness)
  })
}

/**
 * The two parks that were reachable only from the app until the surface was finished: FOLLOW-UP
 * TRIAGE and the INTERVIEW gates.
 *
 * Both belong here rather than only in unit tests, and for the same reason the clarity loop does:
 * what is per-facade is everything AROUND the shared logic. The follow-up state rides the run's
 * step JSON through each facade's own execution mapper, and an interview's questions live in a
 * separate per-runtime store (D1 ⇄ Drizzle) reached through a module a facade has to wire. A
 * facade that mounted the routes and forgot either would answer every call with a 404 or a 503
 * while the shared projection stayed green.
 */
function registerCompanionAnsweringTests(harness: ConformanceHarness): void {
  it('lists parked FOLLOW-UPS, decides every item, and releases the run', async () => {
    // Driven the way the engine really produces them: the async Coder streams two items, the
    // engine folds them onto the step live, and the companion gate holds the run at the Coder's
    // completion. The public surface then does what the SPA window does.
    const app = harness.makeApp({
      confidence: 1,
      asyncKinds: ['coder'],
      followUps: [
        { kind: 'follow_up', title: 'Dedupe the retry helper', detail: 'two copies exist' },
        { kind: 'question', title: 'Which timeout?', detail: '30s or 60s?' },
      ],
    })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: 'pl_simple',
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(parked.status).toBe('blocked')

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{
      parked: boolean
      decisions: {
        kind: string
        stepKind?: string
        maxLoops?: number
        items?: { itemId: string; kind: string; status: string; title: string }[]
      }[]
    }>('GET', `/api/v1/runs/${parked.id}/decisions`, undefined, decideAuth)
    expect(listed.status).toBe(200)
    const triage = listed.body.decisions.find((d) => d.kind === 'follow-ups')!
    expect(triage).toBeDefined()
    expect(triage.stepKind).toBe('coder')
    // The park is reported as ITS OWN kind, never as the generic approval gate it rides: the
    // trap `dedicatedParkSurface` exists to close, asserted per park because the classifier is
    // read at run time rather than baked into the projection.
    expect(listed.body.decisions.some((d) => d.kind === 'approval-gate')).toBe(false)
    // Both items crossed the wire with the id every verb addresses and the kind that decides
    // which verbs apply.
    const followUp = triage.items!.find((i) => i.kind === 'follow_up')!
    const question = triage.items!.find((i) => i.kind === 'question')!
    expect(followUp.status).toBe('pending')
    expect(question.status).toBe('pending')

    const dismissed = await app.call<{ decisions: { kind: string }[] }>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/follow-ups/items/${followUp.itemId}/dismiss`,
      {},
      decideAuth,
    )
    expect(dismissed.status).toBe(200)
    // One item decided is not the batch decided: the run is still asking, so the decision stays.
    expect(dismissed.body.decisions.some((d) => d.kind === 'follow-ups')).toBe(true)

    const answered = await app.call<{ decisions: { kind: string }[] }>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/follow-ups/items/${question.itemId}/answer`,
      { answer: '30s' },
      decideAuth,
    )
    expect(answered.status).toBe(200)
    // Every item decided: nothing left to ask, so the entry is gone rather than reported settled.
    expect(answered.body.decisions.some((d) => d.kind === 'follow-ups')).toBe(false)

    // The answer really steered the engine, not just the row: the Coder loops for it and the run
    // finishes, the same outcome the SPA-driven twin in `execution-gates.ts` asserts.
    const final = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(final.status).toBe('done')
    const coder = final.steps.find((s) => s.agentKind === 'coder')!
    expect(coder.followUps?.items.find((i) => i.id === question.itemId)?.status).toBe('answered')
  })

  it('lists a parked INTERVIEW and records an answer into the gate’s own store', async () => {
    // The interviewer LLM is off in conformance (as everywhere here), so the PARK is seeded rather
    // than driven: a `doc-interviewer` step waiting on its decision, plus the session row the gate
    // reads its questions out of. That is exactly the seam worth asserting per facade: the
    // questions are NOT on the step, so the projection resolves the wired gate and reads a
    // per-runtime store, and the answer writes back through it.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.docInterviewRepository().upsert(wsId, {
      id: 'dis_pub',
      blockId: 'task_login',
      status: 'awaiting',
      round: 1,
      maxRounds: 4,
      qa: [{ id: 'diq_pub', question: 'Who is the audience?', answer: '' }],
      brief: null,
      model: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await app.executionRepository().upsert(wsId, {
      id: 'exec_interview',
      blockId: 'task_login',
      pipelineId: 'pl_document',
      pipelineName: 'Document',
      steps: [
        {
          agentKind: 'doc-interviewer',
          state: 'waiting_decision',
          progress: 0,
          decision: null,
          approval: { id: 'apr_interview', status: 'pending', proposal: '' },
        },
      ],
      currentStep: 0,
      status: 'blocked',
      initiatedBy: null,
    })

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{
      parked: boolean
      decisions: {
        kind: string
        stepKind?: string
        round?: number
        maxRounds?: number
        questions?: { questionId: string | null; question: string; status: string }[]
      }[]
    }>('GET', `/api/v1/runs/exec_interview/decisions`, undefined, decideAuth)
    expect(listed.status).toBe(200)
    expect(listed.body.parked).toBe(true)
    const interview = listed.body.decisions.find((d) => d.kind === 'interview')!
    expect(interview).toBeDefined()
    // `stepKind` is the ONE field a caller branches on, since one route set serves every gate.
    expect(interview.stepKind).toBe('doc-interviewer')
    expect(interview.round).toBe(1)
    expect(interview.maxRounds).toBe(4)
    expect(interview.questions).toEqual([
      { questionId: 'diq_pub', question: 'Who is the audience?', answer: '', status: 'open' },
    ])
    // Not the generic approval gate, for the same reason as above.
    expect(listed.body.decisions.some((d) => d.kind === 'approval-gate')).toBe(false)

    const answered = await app.call<{
      decisions: { kind: string; questions?: { status: string; answer: string }[] }[]
    }>(
      'POST',
      `/api/v1/runs/exec_interview/decisions/interview/answer`,
      { questionId: 'diq_pub', answer: 'Platform engineers' },
      decideAuth,
    )
    expect(answered.status).toBe(200)
    // Re-read from the projection: the status is DERIVED from the answer, so this pins the
    // derivation as well as the write.
    const after = answered.body.decisions.find((d) => d.kind === 'interview')!
    expect(after.questions).toEqual([
      {
        questionId: 'diq_pub',
        question: 'Who is the audience?',
        answer: 'Platform engineers',
        status: 'answered',
      },
    ])
    // …and it landed in the gate's own store, not only in the response.
    const stored = await app.docInterviewRepository().getByBlock(wsId, 'task_login')
    expect(stored?.qa[0]?.answer).toBe('Platform engineers')
  })

  it('refuses an interview answer on a run that is not parked on one', async () => {
    // The two refusals this surface has to keep apart: no live interview is a 404, where an
    // interviewer the deployment never wired would be a 503 naming the kind. Collapsing them
    // would tell an operator staring at a stopped run that it is not stopped.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.executionRepository().upsert(wsId, {
      id: 'exec_no_interview',
      blockId: 'task_login',
      pipelineId: 'pl_simple',
      pipelineName: 'Simple build',
      steps: [{ agentKind: 'coder', state: 'working', progress: 0, decision: null }],
      currentStep: 0,
      status: 'running',
      initiatedBy: null,
    })
    const decideAuth = await mintKey(app, wsId, 'decide')
    const refused = await app.call<{ error: { code: string } }>(
      'POST',
      `/api/v1/runs/exec_no_interview/decisions/interview/continue`,
      {},
      decideAuth,
    )
    expect(refused.status).toBe(404)
    expect(refused.body.error.code).toBe('no_interview')
  })
}

/**
 * The three edges of the two companion surfaces that the happy paths above cannot show, each a
 * claim the code makes elsewhere in prose:
 *
 *  - follow-up triage is listed while the run is still RUNNING (the only decision kind that is);
 *  - a verb refuses on its own terms (409) instead of hiding the run (404) or the deployment (503);
 *  - an interviewer kind a deployment REGISTERED but never WIRED is unanswerable and says so.
 *
 * All three seed their run rather than driving one, because each is about a state the engine passes
 * through or cannot reach at all with the built-ins: a run mid-Coder with items already streamed,
 * and a park on a kind no facade has a controller for.
 */
function registerCompanionEdgeTests(harness: ConformanceHarness): void {
  /** A `coder` step mid-run with one follow-up and one question already streamed onto it. */
  const codingStepWithItems = (now: number) => ({
    agentKind: 'coder',
    state: 'working' as const,
    progress: 0.5,
    decision: null,
    followUps: {
      enabled: true,
      items: [
        {
          id: 'fu_loose_end',
          kind: 'follow_up' as const,
          title: 'Dedupe the retry helper',
          detail: 'two copies exist',
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'fu_question',
          kind: 'question' as const,
          title: 'Which timeout?',
          detail: '30s or 60s?',
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
      loops: 0,
      maxLoops: 3,
    },
  })

  it('lists FOLLOW-UPS on a run that has NOT parked, and sends one back', async () => {
    // The rule the whole projection change turns on, and the one the happy-path test cannot see
    // because it drives the run to its park first: items accrue LIVE, so `parked` is false while
    // the decision is listed. An integration that triages here never sees the run stop, which is
    // the point of the companion; one that waits for `parked` still works, it just waits.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.executionRepository().upsert(wsId, {
      id: 'exec_live_followups',
      blockId: 'task_login',
      pipelineId: 'pl_simple',
      pipelineName: 'Simple build',
      steps: [codingStepWithItems(1_000)],
      currentStep: 0,
      status: 'running',
      initiatedBy: null,
    })

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{
      parked: boolean
      status: string
      decisions: { kind: string; loops?: number; maxLoops?: number }[]
    }>('GET', `/api/v1/runs/exec_live_followups/decisions`, undefined, decideAuth)
    expect(listed.status).toBe(200)
    expect(listed.body.status).toBe('running')
    expect(listed.body.parked).toBe(false)
    const triage = listed.body.decisions.find((d) => d.kind === 'follow-ups')!
    expect(triage).toBeDefined()
    // The send-back budget is projected as the ENGINE will read it, so a caller can tell whether a
    // send-back will re-run the Coder or just advance the run.
    expect(triage.maxLoops).toBe(3)
    expect(triage.loops).toBe(0)

    const sentBack = await app.call<{
      parked: boolean
      decisions: { kind: string; items?: { itemId: string; status: string }[] }[]
    }>(
      'POST',
      `/api/v1/runs/exec_live_followups/decisions/follow-ups/items/fu_loose_end/send-back`,
      {},
      decideAuth,
    )
    expect(sentBack.status).toBe(200)
    // Still listed and still not parked: one item decided is not the batch decided, and the run
    // was never stopped to begin with.
    const after = sentBack.body.decisions.find((d) => d.kind === 'follow-ups')!
    expect(sentBack.body.parked).toBe(false)
    expect(after.items?.find((i) => i.itemId === 'fu_loose_end')?.status).toBe('queued')
    expect(after.items?.find((i) => i.itemId === 'fu_question')?.status).toBe('pending')
    // …and it landed on the step itself, not only in the response.
    const stored = await app.executionRepository().get(wsId, 'exec_live_followups')
    expect(stored?.steps[0]?.followUps?.items.find((i) => i.id === 'fu_loose_end')?.status).toBe(
      'queued',
    )
  })

  it('refuses a follow-up verb on its own terms: 409, not 404 and not 503', async () => {
    // Which refusal a verb gives is what a caller acts on. `file` with no tracker connected and
    // `answer` against a `follow_up` are both "this run is answerable, this VERB is not": a 409,
    // where a 404 would say the run is gone and a 503 would send an operator to wire a module the
    // remedy does not need. Both are the ENGINE's refusals, reaching the wire unre-mapped.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.executionRepository().upsert(wsId, {
      id: 'exec_followup_refusals',
      blockId: 'task_login',
      pipelineId: 'pl_simple',
      pipelineName: 'Simple build',
      steps: [codingStepWithItems(2_000)],
      currentStep: 0,
      status: 'running',
      initiatedBy: null,
    })
    const decideAuth = await mintKey(app, wsId, 'decide')

    const base = `/api/v1/runs/exec_followup_refusals/decisions/follow-ups/items`
    const filed = await app.call('POST', `${base}/fu_loose_end/file`, {}, decideAuth)
    expect(filed.status).toBe(409)
    const misanswered = await app.call(
      'POST',
      `${base}/fu_loose_end/answer`,
      { answer: 'not a question' },
      decideAuth,
    )
    expect(misanswered.status).toBe(409)
    // The item is untouched by either refusal: a rejected verb decides nothing.
    const stored = await app.executionRepository().get(wsId, 'exec_followup_refusals')
    expect(stored?.steps[0]?.followUps?.items.find((i) => i.id === 'fu_loose_end')?.status).toBe(
      'pending',
    )
  })

  it('reports a REGISTERED but unwired interviewer as unanswerable, never as absent', async () => {
    // The asymmetry between the two halves of an interview gate, asserted rather than only
    // documented: admission reads the `interview-gate` TRAIT off the kind registry, so a
    // deployment's own interviewer counts as a park the moment it is registered, while ANSWERING it
    // needs its controller wired as well (`ExecutionService.interviewGateFor`). A kind with no
    // controller is exactly this state, and both halves must tell the truth about it: the run
    // reports `parked: true` with an EMPTY list (the loud case), and the verb 503s NAMING the kind
    // rather than 404ing, which would tell an operator staring at a stopped run it is not stopped.
    const agentKindRegistry = defaultAgentKindRegistry()
    agentKindRegistry.register({
      kind: 'org-interviewer',
      systemPrompt: 'You interview.',
      agent: { surface: 'inline' },
      traits: ['interview-gate'],
    })
    const app = harness.makeApp({}, { agentKindRegistry })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.executionRepository().upsert(wsId, {
      id: 'exec_unwired_interview',
      blockId: 'task_login',
      pipelineId: 'pl_simple',
      pipelineName: 'Simple build',
      steps: [
        {
          agentKind: 'org-interviewer',
          state: 'waiting_decision',
          progress: 0,
          decision: null,
          approval: { id: 'apr_unwired', status: 'pending', proposal: '' },
        },
      ],
      currentStep: 0,
      status: 'blocked',
      initiatedBy: null,
    })

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{ parked: boolean; decisions: { kind: string }[] }>(
      'GET',
      `/api/v1/runs/exec_unwired_interview/decisions`,
      undefined,
      decideAuth,
    )
    expect(listed.status).toBe(200)
    expect(listed.body.parked).toBe(true)
    expect(listed.body.decisions).toEqual([])

    const refused = await app.call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/v1/runs/exec_unwired_interview/decisions/interview/proceed`,
      {},
      decideAuth,
    )
    expect(refused.status).toBe(503)
    expect(refused.body.error.code).toBe('unavailable')
    expect(refused.body.error.message).toContain('org-interviewer')
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
      purpose: 'build',
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
      purpose: 'build',
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
      purpose: 'build',
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
    // An approval gate IS answerable over the public surface now, so the refusal must steer the
    // operator there rather than describing the park as cancel-only — the same honesty rule the
    // input-gate case below pins. (Which EXIT route a refusal names when a park is unanswerable
    // is asserted on the `human-review` case, the one surface still in that position.)
    expect(refused.body.error.message).toContain('/api/v1/runs/:runId/decisions')
    expect(refused.body.error.message).not.toContain('cancel')

    const decideAuth = await mintKey(app, wsId, 'decide')
    const started = await app.call(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: pipeline.body.id },
      decideAuth,
    )
    expect(started.status).toBe(202)
  })

  it('applies the decide-scope rule to a pipeline the board has not ADOPTED yet', async () => {
    // The check above resolves the caller's `pipelineId` to inspect it for parks, and a board can
    // legitimately hold no row for a pipeline a run will nonetheless launch: run resolution ADOPTS a
    // catalog built-in the workspace was never seeded with. Reading the stored row alone therefore
    // found nothing to inspect, skipped the refusal, and let `start` adopt and park the run anyway —
    // so a plain `write` key set in motion exactly the park the scope ladder withholds. Over the
    // wire on both facades, because the pipeline read the check runs against is facade-wired.
    const PIPELINE_ID = 'pl_conf_unadopted_parking'
    const before = harness.makeApp()
    const { workspace } = await before.createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    // The org ships a read-only catalog pipeline that PARKS (an approval gate on its only step),
    // after this board was seeded, so the board holds no row for it.
    const registry = new PipelineRegistry()
    registry.register({
      id: PIPELINE_ID,
      name: 'Gated coder',
      purpose: 'build',
      builtin: true,
      version: 1,
      agentKinds: ['coder'],
      gates: [true],
    })
    const app = harness.makeApp(undefined, { pipelineRegistry: registry })
    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(snapshot.body.pipelines.map((p) => p.id)).not.toContain(PIPELINE_ID)

    const writeAuth = await mintKey(app, wsId, 'write')
    const refused = await app.call<{ error: { code: string } }>(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: PIPELINE_ID },
      writeAuth,
    )
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('pipeline_requires_decide_scope')
    // Refused BEFORE any side effect: a rejected start must not leave the adoption behind, or the
    // board's library would gain a pipeline nothing was allowed to run.
    const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(after.body.pipelines.map((p) => p.id)).not.toContain(PIPELINE_ID)

    // And the same key ladder still ADMITS it: a `decide` key starts the run, which adopts the row.
    const decideAuth = await mintKey(app, wsId, 'decide')
    const started = await app.call(
      'POST',
      `/api/v1/tasks/task_login/start`,
      { pipelineId: PIPELINE_ID },
      decideAuth,
    )
    expect(started.status).toBe(202)
    const adopted = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(adopted.body.pipelines.map((p) => p.id)).toContain(PIPELINE_ID)
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
      purpose: 'build',
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
    // And, for the ONE park the decision surface still cannot answer, it must name the exit route
    // of THIS start surface rather than the jobs cancel, which 404s for a board task run.
    expect(refused.body.error.message).toContain('POST /api/v1/tasks/:taskId/stop')

    // The control, in the same test so the two can never drift apart: the identical chain minus
    // the gate is still startable by a plain `write` key. Widening the park enumeration must not
    // quietly re-scope ordinary board work, which is the failure mode that would hurt most.
    const plain = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Coder only',
      purpose: 'build',
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
      purpose: 'build',
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
      purpose: 'build',
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
 * The generic APPROVAL GATE — "pause a run until a human approves", the park any pipeline can
 * carry and the one an integration meets first.
 *
 * Both halves belong here rather than only in a unit test. The gate's state rides the run's step
 * (D1 ⇄ Drizzle `detail` JSON) and answering it wakes each facade's own durable driver, so a
 * facade that persisted the approval differently, or never re-drove the run, would pass a pure
 * projection test and strand every parked run in production.
 */
function registerApprovalAnsweringTests(harness: ConformanceHarness): void {
  it('lists a parked approval gate and advances the run when the public key approves', async () => {
    const app = harness.makeApp({ confidence: 1 })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id

    const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Gated architect',
      purpose: 'build',
      agentKinds: ['architect', 'coder'],
      gates: [true, false],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: gated.body.id,
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(parked.status).toBe('blocked')

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{
      parked: boolean
      decisions: {
        kind: string
        approvalId?: string
        stepKind?: string
        proposal?: string
        exceeded?: boolean
      }[]
    }>('GET', `/api/v1/runs/${parked.id}/decisions`, undefined, decideAuth)
    expect(listed.status).toBe(200)
    expect(listed.body.parked).toBe(true)
    const gate = listed.body.decisions.find((d) => d.kind === 'approval-gate')!
    expect(gate).toBeDefined()
    // The projection has to carry the id the answer is addressed by, the step whose output is
    // being judged, and the proposal itself — without all three the caller is being asked to
    // approve something it cannot see.
    expect(gate.approvalId).toBe(parked.steps[0]!.approval!.id)
    expect(gate.stepKind).toBe('architect')
    expect(gate.proposal).toBe(parked.steps[0]!.output)
    // An ordinary pipeline gate, not a companion at its rework cap: the caller answers with
    // `approve`, not `resolve-exceeded`.
    expect(gate.exceeded).toBe(false)

    const approved = await app.call<{ parked: boolean; decisions: { kind: string }[] }>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/approvals/${gate.approvalId}/approve`,
      {},
      decideAuth,
    )
    expect(approved.status).toBe(200)
    // Answered: the gate is settled, so it is no longer a decision anybody has to answer.
    expect(approved.body.decisions.some((d) => d.kind === 'approval-gate')).toBe(false)

    const advanced = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(advanced.steps[0]!.approval?.status).toBe('approved')
    expect(advanced.steps[0]!.state).toBe('done')
  })

  it('reports a park a dedicated surface owns as ITS kind, never as an approval gate', async () => {
    // The trap this pins. `step.approval` is the engine's generic parking mechanism, so an input
    // gate, a review gate, a fork choice and a human-verdict gate all leave a PENDING approval on
    // the step — and the engine refuses the generic approve/request-changes/reject verbs on every
    // one of them. A projection that reported "pending approval ⇒ approval-gate" would hand a
    // well-behaved integration a route the engine answers with a 409, forever.
    //
    // Driven through the input gate because it is the one such park a conformance run can reach
    // without a live model: it holds the run before the first dispatch.
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const decideAuth = await mintKey(app, wsId, 'decide')
    const task = await app.call<{ id: string }>(
      'POST',
      `/workspaces/${wsId}/blocks/blk_auth/tasks`,
      { title: 'Make the login better' },
    )
    expect(
      (
        await app.call(
          'POST',
          `/api/v1/tasks/${task.body.id}/start`,
          { pipelineId: 'pl_simple' },
          decideAuth,
        )
      ).status,
    ).toBe(202)
    await app.drive(wsId)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!

    // The engine really did park it on an approval — this test would be vacuous otherwise.
    expect(exec.steps.some((s) => s.approval?.status === 'pending')).toBe(true)

    const listed = await app.call<{ parked: boolean; decisions: { kind: string }[] }>(
      'GET',
      `/api/v1/runs/${exec.id}/decisions`,
      undefined,
      decideAuth,
    )
    expect(listed.status).toBe(200)
    const kinds = listed.body.decisions.map((d) => d.kind)
    expect(kinds).toContain('input-gate')
    expect(kinds).not.toContain('approval-gate')
  })
}

/**
 * The CLARITY review over the public surface, end to end: park, answer a finding, proceed, advance.
 *
 * Requirements already has this loop asserted above, and clarity is its twin driven by the same
 * `ReviewGateController`. The twin-ness is exactly what makes the assertion worth having,
 * because everything AROUND the shared controller is per-kind and per-facade: a separate store
 * (D1 ⇄ Drizzle), a separate `container.clarity` module a facade must wire, and a separate
 * step-gated read in the decision projection. A facade that mounted the routes but never wired the
 * clarity module would answer every one of them with a 503 while requirements stayed green.
 *
 * Driven through the `bug-investigator`'s `needs_clarification` verdict, which seeds one finding
 * per question deterministically, so this runs with no reviewer model, exactly like the
 * requirements case.
 */
function registerDialogueAnsweringTests(harness: ConformanceHarness): void {
  it('lists a parked CLARITY review, answers a finding, and proceeds the run', async () => {
    const app = harness.makeApp({
      customResult: {
        clarity: 'needs_clarification',
        summary: 'The submit handler swallows the validation error.',
        rootCauseHypotheses: ['Unhandled promise rejection in onSubmit'],
        affectedRepos: [],
        suggestedReproductions: ['Submit the form with an empty email'],
        questions: ['What are the exact reproduction steps?'],
      },
    })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Triage & investigate',
      purpose: 'build',
      agentKinds: ['bug-investigator', 'clarity-review', 'architect'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(parked.status).toBe('blocked')

    const decideAuth = await mintKey(app, wsId, 'decide')
    const listed = await app.call<{
      parked: boolean
      decisions: {
        kind: string
        findings?: { itemId: string; status: string }[]
        clarifiedReport?: string | null
      }[]
    }>('GET', `/api/v1/runs/${parked.id}/decisions`, undefined, decideAuth)
    expect(listed.status).toBe(200)
    expect(listed.body.parked).toBe(true)

    // Reported as its OWN kind. The clarity gate parks on a `step.approval` like everything else,
    // so a projection reading "pending approval ⇒ approval-gate" would offer verbs the engine
    // refuses here: the same trap the input-gate case above pins, on a second surface.
    const review = listed.body.decisions.find((d) => d.kind === 'clarity-review')!
    expect(review).toBeDefined()
    expect(listed.body.decisions.some((d) => d.kind === 'approval-gate')).toBe(false)
    const open = review.findings!.find((f) => f.status === 'open')!
    expect(open).toBeDefined()

    const answered = await app.call<{
      decisions: { kind: string; findings?: { itemId: string; status: string; reply: string }[] }[]
    }>(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/clarity/findings/${open.itemId}/reply`,
      { reply: 'Submit the login form with an empty email on Firefox 141.' },
      decideAuth,
    )
    expect(answered.status).toBe(200)
    const item = answered.body.decisions
      .find((d) => d.kind === 'clarity-review')!
      .findings!.find((f) => f.itemId === open.itemId)!
    expect(item.status).toBe('answered')

    // Proceed settles the review and RELEASES the park, the half that only the assembled facade
    // can prove, since it wakes each runtime's own durable driver.
    const proceeded = await app.call(
      'POST',
      `/api/v1/runs/${parked.id}/decisions/clarity/proceed`,
      undefined,
      decideAuth,
    )
    expect(proceeded.status).toBe(200)
    const advanced = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(advanced.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe('done')
    expect(advanced.status).not.toBe('blocked')
  })
}

/**
 * The invariant that makes the BLOCK-SCOPED routes safe: a run its task has moved past is not
 * resolvable at all.
 *
 * The three iterative reviews and both human-verdict gates delegate to service methods keyed by
 * BLOCK, not by run, so the `runId` in the path names a run nothing downstream reads. Left alone
 * that is a misaddressing hazard (answer with a stale id, act on whatever run the block now
 * holds), and the ONLY reason it is not one is that the execution repositories never leave a
 * superseded
 * run readable: `insertLive` deletes the block's terminal rows in the same transaction that claims
 * the new live one, so resolution itself is the check and `loadScopedRun` returns a 404.
 *
 * That invariant lives in each facade's own repository (D1 ⇄ Drizzle), not in the HTTP layer, and
 * nothing else asserts the public surface depends on it. A runtime re-check in the gate would be
 * an unreachable branch; this is the guard that actually fails if the invariant is ever relaxed.
 */
function registerStaleRunTests(harness: ConformanceHarness): void {
  it('refuses a block-scoped answer once the task has moved on', async () => {
    const app = harness.makeApp()
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    await app.seedReadyReview(wsId, 'task_login')
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Coder only',
      purpose: 'build',
      agentKinds: ['coder'],
    })

    const first = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(first.status).toBe(201)
    const staleRunId = first.body.id

    // Drive the first run to completion, then start a SECOND on the same task: the ordinary
    // re-run, which re-points `block.executionId`. The first run is still perfectly readable,
    // which is the whole point: resolution succeeds and only the block check can catch it.
    await app.drive(wsId)
    const second = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(second.status).toBe(201)
    expect(second.body.id).not.toBe(staleRunId)

    const decideAuth = await mintKey(app, wsId, 'decide')
    const refused = await app.call<{ error: { code: string } }>(
      'POST',
      `/api/v1/runs/${staleRunId}/decisions/requirements/proceed`,
      undefined,
      decideAuth,
    )
    // The superseded run is GONE, not merely un-answerable, which is what makes it impossible
    // for this call to have proceeded the review on the second run instead.
    expect(refused.status).toBe(404)
    expect(refused.body.error.code).toBe('not_found')

    // The control, in the same test so the two cannot drift: the LIVE run answers fine.
    const accepted = await app.call(
      'POST',
      `/api/v1/runs/${second.body.id}/decisions/requirements/proceed`,
      undefined,
      decideAuth,
    )
    expect(accepted.status).toBe(200)
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
      purpose: 'build',
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
      purpose: 'build',
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
