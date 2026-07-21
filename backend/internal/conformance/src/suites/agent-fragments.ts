import type { Block, Pipeline, WorkspaceSnapshot } from '@cat-factory/kernel'
import {
  clearRegisteredPromptFragments,
  clearRegisteredTaskTypeDefaultFragments,
  registerPromptFragment,
  registerTaskTypeDefaultFragments,
} from '@cat-factory/prompt-fragments'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// The service-scoped FRAGMENTS half of the agent conformance group, extracted from
// `suites/agents.ts` for file-size hygiene (a cohesive cluster: the workspace default
// service-fragment set, per-task fragment seeding + the deployment-registered per-task-type
// default, and the code-aware/doc-aware fold — over the in-memory pool, the managed DB catalog,
// and a built-in). Called from `defineAgentConformance` so it stays part of the same suite.
export function defineAgentFragmentConformance(harness: ConformanceHarness): void {
  describe('service-scoped fragments + agent traits', () => {
    it('reads, replaces and surfaces the workspace default service-fragment set', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()

      // A fresh workspace has no default service fragments.
      const initial = await call<{ fragmentIds: string[] }>(
        'GET',
        `/workspaces/${workspace.id}/service-fragment-defaults`,
      )
      expect(initial.status).toBe(200)
      expect(initial.body.fragmentIds).toEqual([])

      // Replace the whole list (ids aren't validated against the catalog here).
      const put = await call<{ fragmentIds: string[] }>(
        'PUT',
        `/workspaces/${workspace.id}/service-fragment-defaults`,
        { fragmentIds: ['node.best-practices', 'node.performance'] },
      )
      expect(put.status).toBe(200)
      expect(put.body.fragmentIds).toEqual(['node.best-practices', 'node.performance'])

      // It persisted and rides along on the snapshot.
      const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snapshot.body.serviceFragmentDefaults?.fragmentIds).toEqual([
        'node.best-practices',
        'node.performance',
      ])

      // A new service inherits the default onto its serviceFragmentIds.
      const frame = await call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
        type: 'service',
        position: { x: 5, y: 5 },
      })
      expect(frame.body.serviceFragmentIds).toEqual(['node.best-practices', 'node.performance'])
    })

    it("seeds a new task's fragments from its service, honouring an explicit override", async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const wsId = workspace.id

      // Give the seeded auth service a fragment selection.
      await call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        serviceFragmentIds: ['node.best-practices', 'node.performance'],
      })

      // A task created under it inherits that selection onto its OWN fragmentIds — so it is
      // visible and editable/removable per task from here (the service is not re-unioned at run).
      const inherited = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Inherits the service standards',
      })
      expect(inherited.body.fragmentIds).toEqual(['node.best-practices', 'node.performance'])

      // An explicit list on the create request is authoritative (the user edited the picker).
      const overridden = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Overrides the inherited set',
        fragmentIds: ['node.performance'],
      })
      expect(overridden.body.fragmentIds).toEqual(['node.performance'])

      // An explicit EMPTY list means "the user cleared the inherited selection" — no seeding.
      const cleared = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Clears the inherited set',
        fragmentIds: [],
      })
      expect(cleared.body.fragmentIds ?? []).toEqual([])
    })

    it('folds the task fragments into code-aware agents only', async () => {
      // Register a deployment-style custom fragment into the universal pool, select it on the
      // TASK's own selection, and assert the engine folds it into a `code-aware` step's prompt
      // (coder) but not a non-code-aware one (documenter). A task owns its fragment selection
      // (seeded from the service at creation, then editable), so the fold reads the task's own
      // `fragmentIds` — the service's fragments are not re-unioned at run time.
      registerPromptFragment({
        id: 'test.svc-standard',
        version: '1.0.0',
        title: 'Service standard',
        category: 'Test',
        summary: 'A registered service standard.',
        body: 'SERVICE-STANDARD-BODY',
      })
      try {
        const app = harness.makeApp({ echoFragments: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Select the fragment on the seeded task itself.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          fragmentIds: ['test.svc-standard'],
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + document',
          agentKinds: ['coder', 'documenter', 'doc-outliner'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

        // The coder is `code-aware`: it receives the task's fragment.
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.output).toContain('[frags]test.svc-standard[/frags]')
        expect(coder.selectedFragmentIds).toEqual(['test.svc-standard'])

        // The doc-outliner is `doc-aware`: it folds the same fragments (the
        // document writing-style path is the doc analogue of code-aware).
        const outliner = exec.steps.find((s) => s.agentKind === 'doc-outliner')!
        expect(outliner.output).toContain('[frags]test.svc-standard[/frags]')
        expect(outliner.selectedFragmentIds).toEqual(['test.svc-standard'])

        // The documenter is neither code-aware, doc-aware nor spec-aware: no fragments.
        const documenter = exec.steps.find((s) => s.agentKind === 'documenter')!
        expect(documenter.output).toContain('[frags][/frags]')
        expect(documenter.selectedFragmentIds ?? []).toEqual([])
      } finally {
        clearRegisteredPromptFragments()
      }
    })

    it('seeds a deployment-registered task-type default onto a new task of that type', async () => {
      // The full programmatic deployment flow: register a custom fragment into the universal
      // pool AND mark it as the default for a task type (here `review`), so every new review
      // task on the board starts with that org's guidance — no per-block or per-workspace
      // configuration. Asserts the board seeds it onto the created task's own `fragmentIds`
      // (visible + removable per task) and that the engine then folds it into a code-aware run,
      // identically on D1 and Postgres.
      registerPromptFragment({
        id: 'test.review-checklist',
        version: '1.0.0',
        title: 'Review checklist',
        category: 'Test',
        summary: 'A registered review checklist.',
        body: 'REVIEW-CHECKLIST-BODY',
      })
      registerTaskTypeDefaultFragments('review', ['test.review-checklist'])
      try {
        const app = harness.makeApp({ echoFragments: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A NEW review task is seeded with the registered type default onto its own selection.
        const review = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Review the auth PR',
          taskType: 'review',
        })
        expect(review.body.fragmentIds).toEqual(['test.review-checklist'])

        // A task of a DIFFERENT type gets no such default (no built-in, none registered).
        const feature = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'A feature',
          taskType: 'feature',
        })
        expect(feature.body.fragmentIds ?? []).toEqual([])

        // The engine folds the seeded default into a code-aware step's prompt.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code',
          agentKinds: ['coder'],
        })
        const start = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/${review.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === review.body.id)!
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.output).toContain('[frags]test.review-checklist[/frags]')
        expect(coder.selectedFragmentIds).toEqual(['test.review-checklist'])
      } finally {
        clearRegisteredTaskTypeDefaultFragments()
        clearRegisteredPromptFragments()
      }
    })

    it('resolves a managed (DB-backed) workspace fragment into a code-aware run', async () => {
      // Unlike the previous test (a fragment in the in-memory static pool), this one
      // is persisted in the facade's real fragment store. It asserts the engine now
      // resolves run-time fragment ids against the merged TENANT CATALOG — so a
      // managed fragment (the foundation document-backed fragments build on) actually
      // reaches a `code-aware` agent, identically on D1 and Postgres. A fragment id
      // that failed to resolve would be dropped, so a non-empty selection is the proof.
      const app = harness.makeApp({ echoFragments: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const created = await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
        id: 'db.managed-standard',
        title: 'Managed standard',
        summary: 'A DB-backed standard.',
        body: 'MANAGED-DB-BODY',
      })
      expect(created.status).toBe(201)

      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        fragmentIds: ['db.managed-standard'],
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code',
        agentKinds: ['coder'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.output).toContain('[frags]db.managed-standard[/frags]')
      expect(coder.selectedFragmentIds).toEqual(['db.managed-standard'])
    })

    it('resolves the built-in design.context fragment into a code-aware run', async () => {
      // The shared design-context fragment (the one a linked Figma/Zeplin document's
      // materialised `.cat-context/*.md` pairs with) is a built-in catalog entry. Pinning
      // it on the task and asserting a `coder` run resolves it proves the fragment is in
      // the universal pool and reaches a code-aware agent identically on D1 and Postgres —
      // a rename/removal of the design fragment fails here. (The document body's own
      // materialisation into the agent context is covered by the generic document-source
      // path; design sources ride it unchanged.)
      const app = harness.makeApp({ echoFragments: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        fragmentIds: ['design.context'],
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code',
        agentKinds: ['coder'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.selectedFragmentIds).toEqual(['design.context'])
      expect(coder.output).toContain('[frags]design.context[/frags]')
    })
  })
}
