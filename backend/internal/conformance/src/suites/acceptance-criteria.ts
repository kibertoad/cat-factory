import { describe, expect, it } from 'vitest'
import type {
  AgentRunContext,
  ExecutionInstance,
  Pipeline,
  PullRequestRef,
} from '@cat-factory/kernel'
import type {
  ServiceAcceptanceCriteria,
  ServiceAcceptanceCriterion,
  TestReport,
} from '@cat-factory/contracts'
import { FakePrReportPublisher } from '../FakePrReportPublisher.js'
import type { ConformanceHarness } from '../harness.js'

// Per-service ACCEPTANCE-CRITERIA conformance
// (docs/initiatives/acceptance-criteria-store.md).
//
// A service frame accumulates durable given/when/outcome statements of required behaviour;
// the CONFIRMED ones ride every dispatch's prompt, the tester rules on them, and the PR
// verification report renders the criterion → evidence join. Four things have to behave
// identically on D1 and Postgres, and each is a place a facade could silently diverge:
//
//  1. STORE + BATCH READ — the row round-trips through one repository shape, and the batch
//     read (`listByFrameBlocks`, a chunked `IN`) is what both the CRUD surface and the
//     dispatch resolution go through.
//  2. PROPOSED-vs-CONFIRMED GATING — the single most important assertion here. Only
//     `confirmed` criteria reach `AgentRunContext`; a `proposed` one (a model extraction no
//     human has read) or a `retired` one must NOT. A facade that filtered in the wrong layer
//     — or not at all — would put un-reviewed, model-authored "requirements" into every
//     coder prompt, which is strictly worse than having no store.
//  3. FRAME-CHAIN RESOLUTION — a run on a TASK resolves its service FRAME's criteria. A
//     facade that keyed resolution off the run block would see nothing at all.
//  4. THE UNCONFIGURED NO-OP — no criteria ⇒ no `acceptanceCriteria` field on the context at
//     all (not an empty object), so every prompt is byte-for-byte what it was before the
//     feature existed. This is the compatibility promise the whole design rests on.
//
// The extraction/accretion pass is deliberately NOT asserted here: it needs a wired model
// provider, which the conformance harness has none of. Its pass-through — no model ⇒ nothing
// happens, the run advances unchanged — is what every OTHER suite in this package proves by
// continuing to pass.
export function defineAcceptanceCriteriaConformance(harness: ConformanceHarness): void {
  describe('acceptance criteria', () => {
    /** Add a criterion to a service frame over the real HTTP route. */
    const addCriterion = async (
      app: ReturnType<ConformanceHarness['makeApp']>,
      wsId: string,
      blockId: string,
      body: {
        title: string
        given?: string
        when: string
        outcome: string
        tags?: string[]
        status?: 'proposed' | 'confirmed' | 'retired'
      },
    ) =>
      app.call<ServiceAcceptanceCriterion>(
        'POST',
        `/workspaces/${wsId}/services/${blockId}/acceptance-criteria`,
        body,
      )

    /** A single-step coder pipeline — the dispatch whose prompt context is under test. */
    const coderPipeline = async (app: ReturnType<ConformanceHarness['makeApp']>, wsId: string) =>
      (
        await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
      ).body

    it('stores, reads back, lists and patches a service frame’s criteria', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const created = await addCriterion(app, wsId, 'blk_auth', {
        title: 'Expired sessions are rejected',
        given: 'a session token issued more than 24 hours ago',
        when: 'the token is presented to any authenticated endpoint',
        outcome: 'the request is rejected with 401 and the token is not refreshed',
        tags: ['auth', 'security'],
      })
      expect(created.status).toBe(201)
      // A hand-authored criterion is `confirmed` on arrival: a human typing it into the
      // inspector HAS confirmed it, so requiring a second click would be ceremony.
      expect(created.body.status).toBe('confirmed')
      expect(created.body.provenance).toBe('authored')
      expect(created.body.sourceReviewId).toBeNull()
      expect(created.body.tags).toEqual(['auth', 'security'])

      const read = await app.call<ServiceAcceptanceCriteria>(
        'GET',
        `/workspaces/${wsId}/services/blk_auth/acceptance-criteria`,
      )
      expect(read.body.criteria).toHaveLength(1)
      expect(read.body.criteria[0]?.outcome).toContain('401')

      // The workspace listing groups by frame — the store's hydrate read.
      const list = await app.call<ServiceAcceptanceCriteria[]>(
        'GET',
        `/workspaces/${wsId}/acceptance-criteria`,
      )
      expect(list.body.map((entry) => entry.blockId)).toContain('blk_auth')

      const patched = await app.call<ServiceAcceptanceCriterion>(
        'PATCH',
        `/workspaces/${wsId}/acceptance-criteria/${created.body.id}`,
        { status: 'retired' },
      )
      expect(patched.status).toBe(200)
      expect(patched.body.status).toBe('retired')
      // A retired criterion is KEPT, not deleted — that is what stops a later extraction pass
      // cheerfully re-proposing something a human already decided against.
      const afterRetire = await app.call<ServiceAcceptanceCriteria>(
        'GET',
        `/workspaces/${wsId}/services/blk_auth/acceptance-criteria`,
      )
      expect(afterRetire.body.criteria).toHaveLength(1)

      const deleted = await app.call(
        'DELETE',
        `/workspaces/${wsId}/acceptance-criteria/${created.body.id}`,
      )
      expect(deleted.status).toBe(204)
      const afterDelete = await app.call<ServiceAcceptanceCriteria>(
        'GET',
        `/workspaces/${wsId}/services/blk_auth/acceptance-criteria`,
      )
      expect(afterDelete.body.criteria).toEqual([])
    })

    it('reclaims a deleted service frame’s criteria', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // A fresh, task-less frame: deleting a service that still holds unfinished tasks is
      // refused outright, and this test is about the cascade, not that guard.
      const frame = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 600, y: 600 },
      })
      await addCriterion(app, wsId, frame.body.id, {
        title: 'Expired sessions are rejected',
        when: 'an expired token is presented',
        outcome: 'the request is rejected with 401',
      })
      expect(
        (
          await app.call<ServiceAcceptanceCriteria[]>(
            'GET',
            `/workspaces/${wsId}/acceptance-criteria`,
          )
        ).body,
      ).toHaveLength(1)

      const removed = await app.call('DELETE', `/workspaces/${wsId}/blocks/${frame.body.id}`)
      expect(removed.status).toBe(204)

      // Criteria are keyed by the frame's BLOCK id, so without the delete cascade they survive as
      // rows no inspector can ever reach (the panel renders only for a live frame) that the
      // workspace hydrate nonetheless keeps returning forever. Asserted on both runtimes because
      // the cascade rides a repository each facade implements separately.
      const after = await app.call<ServiceAcceptanceCriteria[]>(
        'GET',
        `/workspaces/${wsId}/acceptance-criteria`,
      )
      expect(after.body).toEqual([])
    })

    it('refuses criteria on a non-frame block (they would never be resolved)', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      // `task_login` is a TASK inside `blk_auth`. Resolution only ever walks UP to the frame,
      // so a criterion stored here would silently never reach a prompt — reject it at the
      // write boundary instead of saving something inert.
      const res = await addCriterion(app, workspace.id, 'task_login', {
        title: 'Never resolved',
        when: 'anything happens',
        outcome: 'nothing observes this',
      })
      expect(res.status).toBe(422)
    })

    it('threads a task’s SERVICE-FRAME confirmed criteria onto the dispatched agent context', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Stored on the FRAME; the run is on a TASK inside it — the frame-chain walk is the
      // thing under test (a facade that keyed resolution off the run block would see nothing).
      const confirmed = await addCriterion(app, wsId, 'blk_auth', {
        title: 'Expired sessions are rejected',
        given: 'a session token older than 24 hours',
        when: 'it is presented to an authenticated endpoint',
        outcome: 'the request is rejected with 401',
      })

      const pipeline = await coderPipeline(app, wsId)
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      expect(start.status).toBe(201)
      await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.acceptanceCriteria?.criteria).toEqual([
        {
          id: confirmed.body.id,
          title: 'Expired sessions are rejected',
          given: 'a session token older than 24 hours',
          when: 'it is presented to an authenticated endpoint',
          outcome: 'the request is rejected with 401',
          tags: [],
        },
      ])
    })

    it('never dispatches a PROPOSED or RETIRED criterion', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // `proposed` is what the accretion pass writes — a MODEL's reading of a requirements
      // document that no human has looked at. Letting it steer the coder would make a
      // hallucination indistinguishable from a decision, so the gating is asserted here
      // rather than left to the service layer's word.
      await addCriterion(app, wsId, 'blk_auth', {
        title: 'Unreviewed extraction',
        when: 'the accretion pass proposed this',
        outcome: 'a human has not yet confirmed it',
        status: 'proposed',
      })
      await addCriterion(app, wsId, 'blk_auth', {
        title: 'Superseded behaviour',
        when: 'this used to be required',
        outcome: 'it no longer is',
        status: 'retired',
      })
      const confirmed = await addCriterion(app, wsId, 'blk_auth', {
        title: 'Still required',
        when: 'the user signs out',
        outcome: 'every active session for that user is invalidated',
        status: 'confirmed',
      })

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.acceptanceCriteria?.criteria.map((c) => c.id)).toEqual([
        confirmed.body.id,
      ])
    })

    it('carries NO criteria when the service has none confirmed (unchanged behaviour)', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // A frame holding ONLY unconfirmed criteria must be indistinguishable from a frame
      // holding none: the field is absent, not an empty object, so the job body carries no
      // `acceptanceCriteria` at all and the prompt is byte-for-byte the pre-feature one.
      await addCriterion(app, wsId, 'blk_auth', {
        title: 'Unreviewed extraction',
        when: 'the accretion pass proposed this',
        outcome: 'a human has not yet confirmed it',
        status: 'proposed',
      })

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs: ExecutionInstance[] = await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext).toBeDefined()
      expect(coderContext?.acceptanceCriteria).toBeUndefined()
      // And the run itself is entirely unaffected.
      expect(execs.find((e) => e.blockId === 'task_login')?.status).toBe('done')
    })

    it('renders the criterion → evidence table on the PR verification report', async () => {
      const publisher = new FakePrReportPublisher()
      const pr: PullRequestRef = {
        number: 7,
        url: 'https://github.test/o/r/pull/7',
        branch: 'work',
      }
      // The tester rules on one criterion and leaves the other alone — the two states the
      // table has to keep distinguishable ("checked and fine" vs "nobody looked").
      const app = harness.makeApp(
        { pullRequest: pr, testReports: [] as TestReport[] },
        { prVerificationReportPublisher: publisher },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await addCriterion(app, wsId, 'blk_auth', {
        title: 'Expired sessions are rejected',
        when: 'an expired token is presented',
        outcome: 'the request is rejected with 401',
      })

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      await app.drive(wsId)

      const section = publisher.section('task_login')
      expect(section, 'expected a verification report on the PR').toBeTruthy()
      expect(section).toContain('### Acceptance criteria')
      expect(section).toContain('Expired sessions are rejected')
      // No tester in this pipeline, so the section must SAY the criteria went unverified
      // rather than quietly omitting them — an unchecked contract that looks like a checked
      // one is exactly the false reassurance the report exists to remove.
      expect(section).toContain('no tester in this run returned a verdict')
    })
  })
}
