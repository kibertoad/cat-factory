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
    registerFragmentSetTests(harness)
    registerFragmentBriefTests(harness)
  })
}

/**
 * The workspace/service/task fragment sets: defaults, per-task overrides, task-type defaults,
 * and how they fold into code-aware agents only.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerFragmentSetTests(harness: ConformanceHarness): void {
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
        description: 'Read the open auth pull request and report on its correctness and risk.',
        taskType: 'review',
        taskTypeFields: { prNumber: 41 },
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

  // ---- condensed briefs for implementer kinds ---------------------------------------
  // `coder` carries the `brief-standards` trait, so it folds a standard's CONDENSED variant
  // instead of the body. These assert the two STORES that back it round-trip identically on
  // D1 and Postgres: the linked `brief` column on `prompt_fragments`, and the generated-brief
  // table keyed by a fingerprint of the body it condensed.

  /** A body comfortably over `FRAGMENT_BRIEF_MIN_BODY_CHARS`, so condensation is warranted. */
}

/**
 * Auto-generated fragment briefs: a tenant-authored linked brief, generation + reuse +
 * regeneration on change, the remembered can't-condense case, and the full-standards kinds.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerFragmentBriefTests(harness: ConformanceHarness): void {
  const longBody = (marker: string) =>
    `${marker}. ${'Every rule in this standard must survive condensation. '.repeat(40)}`

  async function runCoder(app: ReturnType<ConformanceHarness['makeApp']>, wsId: string) {
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Code',
      agentKinds: ['coder'],
    })
    const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    return exec.steps.find((s) => s.agentKind === 'coder')!
  }

  it('folds a LINKED brief a tenant authored on its own managed standard', async () => {
    // Before this, only the code-authored built-in tier could carry a brief — a managed
    // standard (including one overriding a built-in id) always folded in full.
    const app = harness.makeApp({ echoFragments: true, echoFragmentBriefs: true })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const created = await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
      id: 'db.linked-brief',
      title: 'Linked brief standard',
      summary: 'A DB-backed standard with its own short version.',
      body: longBody('LONG-BODY'),
      brief: 'LINKED-BRIEF',
    })
    expect(created.status).toBe(201)
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      fragmentIds: ['db.linked-brief'],
    })

    const coder = await runCoder(app, wsId)
    expect(coder.output).toContain('[briefs]db.linked-brief=LINKED-BRIEF[/briefs]')
  })

  it('GENERATES a brief for a long standard with none, reuses it, and regenerates on change', async () => {
    // The whole feature in one drive: condense once, serve the persisted copy on the next
    // dispatch, and re-condense as soon as the standard's body moves. The generator counts
    // its calls, so "reused" is asserted as an absence of a second condensation rather than
    // merely as equal text.
    let calls = 0
    const app = harness.makeApp(
      { echoFragments: true, echoFragmentBriefs: true },
      {
        fragmentBriefGenerator: {
          enabled: true,
          generate: async (_workspaceId, input) => {
            calls += 1
            return {
              outcome: 'brief',
              brief: `CONDENSED-${input.body.slice(0, 9)}-${calls}`,
              model: 'fake:small',
            }
          },
        },
      },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const created = await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
      id: 'db.long-standard',
      title: 'Long standard',
      summary: 'A DB-backed standard with no short version.',
      body: longBody('FIRST-REV'),
    })
    expect(created.status).toBe(201)
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      fragmentIds: ['db.long-standard'],
    })

    const first = await runCoder(app, wsId)
    expect(first.output).toContain('[briefs]db.long-standard=CONDENSED-FIRST-REV-1[/briefs]')
    expect(calls).toBe(1)

    // Same body ⇒ the persisted brief is read back; no second condensation is paid for.
    const second = await runCoder(app, wsId)
    expect(second.output).toContain('[briefs]db.long-standard=CONDENSED-FIRST-REV-1[/briefs]')
    expect(calls).toBe(1)

    // The standard's body moves — the stored brief now condenses a revision this standard
    // no longer has, so it must be re-condensed rather than folded.
    const edited = await app.call(
      'PATCH',
      `/workspaces/${wsId}/prompt-fragments/db.long-standard`,
      { body: longBody('SECOND-RV') },
    )
    expect(edited.status).toBe(200)

    const third = await runCoder(app, wsId)
    expect(third.output).toContain('[briefs]db.long-standard=CONDENSED-SECOND-RV-2[/briefs]')
    expect(calls).toBe(2)
  })

  it('REMEMBERS a standard that cannot be condensed, and re-attempts once it is edited', async () => {
    // The generator is told to keep every rule even if that means returning the text near
    // its original length, so "not condensable" is an ordinary outcome — and it lands on the
    // longest standards, the ones this feature exists for. Unremembered, each of those
    // re-pays for a model call on every implementer dispatch forever. Asserted per runtime
    // because the memory IS a stored row: the marker has to round-trip D1 and Postgres.
    let calls = 0
    const app = harness.makeApp(
      { echoFragments: true, echoFragmentBriefs: true },
      {
        fragmentBriefGenerator: {
          enabled: true,
          generate: async () => {
            calls += 1
            return { outcome: 'not-condensable', model: 'fake:small', reason: 'no shorter' }
          },
        },
      },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
      id: 'db.irreducible',
      title: 'Irreducible standard',
      summary: 'A standard whose every line is an obligation.',
      body: longBody('FIRST-REV'),
    })
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      fragmentIds: ['db.irreducible'],
    })

    // The full body is folded — no brief — and the refusal is recorded.
    const first = await runCoder(app, wsId)
    expect(first.output).toContain('[briefs]db.irreducible=[/briefs]')
    expect(calls).toBe(1)

    // The recorded refusal is read back: same outcome, no second condensation paid for.
    const second = await runCoder(app, wsId)
    expect(second.output).toContain('[briefs]db.irreducible=[/briefs]')
    expect(calls).toBe(1)

    // Editing the standard clears it — the marker is scoped to a BODY, not to a fragment,
    // so a rewrite earns a fresh attempt with no operator surface to reset.
    const edited = await app.call('PATCH', `/workspaces/${wsId}/prompt-fragments/db.irreducible`, {
      body: longBody('SECOND-RV'),
    })
    expect(edited.status).toBe(200)

    await runCoder(app, wsId)
    expect(calls).toBe(2)
  })

  it('never condenses for a kind that folds full standards', async () => {
    // `architect` is code-aware but carries no `brief-standards` trait, so it receives the
    // full body — and must not spend a condensation call producing text it would discard.
    let calls = 0
    const app = harness.makeApp(
      { echoFragments: true, echoFragmentBriefs: true },
      {
        fragmentBriefGenerator: {
          enabled: true,
          generate: async () => {
            calls += 1
            return { outcome: 'brief', brief: 'CONDENSED', model: 'fake:small' }
          },
        },
      },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
      id: 'db.full-only',
      title: 'Full-only standard',
      summary: 'A DB-backed standard read at full length.',
      body: longBody('FULL-ONLY'),
    })
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      fragmentIds: ['db.full-only'],
    })
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Plan',
      agentKinds: ['architect'],
    })
    const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

    const architect = exec.steps.find((s) => s.agentKind === 'architect')!
    expect(architect.output).toContain('[briefs]db.full-only=[/briefs]')
    expect(calls).toBe(0)
  })
}
