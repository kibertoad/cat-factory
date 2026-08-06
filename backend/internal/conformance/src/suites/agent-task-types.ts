import { PipelineRegistry, defaultTaskTypeRegistry } from '@cat-factory/kernel'
import type { Block, Pipeline, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

/**
 * A deployment-registered custom TASK TYPE, and the REUSABLE OPERATION bundle built on it
 * (`backend/docs/reusable-operations.md`): the descriptor's snapshot projection and pipeline
 * pin, the standing-context fragments a new task is seeded with, the collected per-case values on
 * their way to a prompt, and the creation-time check that they are the values the type declares.
 *
 * Every assertion here crosses persistence (the widened `taskType` scalar, the sparse `custom` JSON
 * column, the seeded fragment-id array), which is why it is a conformance suite rather than a unit
 * test: a mapper that dropped a half would otherwise ship on one runtime.
 */
export function defineTaskTypeConformance(harness: ConformanceHarness): void {
  describe('registered custom task type', () => {
    // A deployment registers a namespaced task type on its app-owned TaskTypeRegistry (the
    // frontend analogue of a custom agent kind). This asserts the SAME injected instance reaches
    // BOTH the HTTP snapshot projection (`customTaskTypes`) AND `defaultPipelineIdForTaskType`'s
    // registry consult — and that a task created with the namespaced type + its descriptor-driven
    // `custom` fields round-trips through create + a full snapshot re-read — identically on D1 and
    // Postgres, so a facade that forgot to thread the registry fails here rather than shipping.
    it('projects a custom task type into the snapshot, defaults its pipeline, and round-trips a typed task', async () => {
      const taskTypeRegistry = defaultTaskTypeRegistry()
      taskTypeRegistry.register({
        taskType: 'conf:incident',
        presentation: {
          label: 'Incident',
          icon: 'i-lucide-siren',
          color: '#ef4444',
          description: 'A production incident to triage.',
        },
        fields: [
          {
            key: 'severity',
            label: 'Severity',
            type: 'select',
            options: [
              { value: 'sev1', label: 'SEV1' },
              { value: 'sev2', label: 'SEV2' },
            ],
          },
        ],
        // A BUILT-IN pipeline id (resolves via `seedPipelines()`), so the assertion that the
        // registry default wins needs no separately-registered pipeline.
        defaultPipelineId: 'pl_review',
      })
      const app = harness.makeApp(undefined, { taskTypeRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // 1. Advertised in the snapshot's custom-task-type catalog on every runtime.
      const snap = await app.call<{
        customTaskTypes?: { taskType: string; defaultPipelineId?: string }[]
      }>('GET', `/workspaces/${wsId}`)
      const listed = (snap.body.customTaskTypes ?? []).find((t) => t.taskType === 'conf:incident')
      expect(listed).toBeTruthy()
      expect(listed?.defaultPipelineId).toBe('pl_review')

      // 2. A task created with the namespaced type + descriptor `custom` fields round-trips, and
      //    (with no pinned pipeline) defaults to the registry's pipeline — proving
      //    `defaultPipelineIdForTaskType` consults the injected registry after the built-in map.
      const created = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'DB outage',
        description: 'Investigate the incident.',
        taskType: 'conf:incident',
        taskTypeFields: { custom: { severity: 'sev1' } },
      })
      expect(created.status).toBe(201)
      expect(created.body.taskType).toBe('conf:incident')
      expect(created.body.taskTypeFields?.custom?.severity).toBe('sev1')
      expect(created.body.pipelineId).toBe('pl_review')

      // 3. And it survives a full REPLACE-style snapshot re-read (the persistence mappers carry
      //    the widened `taskType` + the sparse `custom` bag through the scalar/JSON columns).
      const reread = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const block = reread.body.blocks.find((b) => b.id === created.body.id)
      expect(block?.taskType).toBe('conf:incident')
      expect(block?.taskTypeFields?.custom?.severity).toBe('sev1')
    })

    // The REUSABLE OPERATION bundle (backend/docs/reusable-operations.md): a registered type
    // carrying a per-case form AND its standing-context fragments. Both halves are engine-level,
    // but both cross persistence (the seeded fragment ids onto the task row, the collected values
    // through the sparse `custom` JSON column), so a mapper that dropped either would ship.
    it('seeds an operation’s standing context and folds its parameters into the run', async () => {
      const taskTypeRegistry = defaultTaskTypeRegistry()
      taskTypeRegistry.register({
        taskType: 'conf:introduce-api',
        presentation: {
          label: 'Introduce API',
          icon: 'i-lucide-plug',
          color: '#0ea5e9',
          description: 'Expose functionality over HTTP.',
          category: 'API delivery',
        },
        fields: [
          { key: 'entity', label: 'Entity', type: 'text', required: true },
          {
            key: 'authRequirement',
            label: 'Auth requirement',
            type: 'select',
            options: [{ value: 'service', label: 'Service-to-service token' }],
          },
          // The widened value shapes: a multi-select answer is a `string[]` on the wire and in the
          // JSON column, so a mapper that stringified the bag would fail here rather than ship.
          {
            key: 'operations',
            label: 'Operations',
            type: 'checkbox-group',
            options: [
              { value: 'create', label: 'Create' },
              { value: 'list', label: 'List' },
            ],
          },
        ],
        defaultFragmentIds: ['conf.api-guidelines'],
      })
      const app = harness.makeApp({ echoTaskParams: true }, { taskTypeRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // 1. Creating the task seeds the operation's standing context onto its own selection, and the
      //    collected bag survives the JSON column with its value SHAPES intact.
      const created = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Expose orders',
        description: 'Expose the order entity.',
        taskType: 'conf:introduce-api',
        taskTypeFields: {
          custom: { entity: 'Order', authRequirement: 'service', operations: ['create', 'list'] },
        },
      })
      expect(created.status).toBe(201)
      expect(created.body.fragmentIds).toEqual(['conf.api-guidelines'])
      expect(created.body.taskTypeFields?.custom?.operations).toEqual(['create', 'list'])

      // 2. Dispatching resolves the collected values under the descriptor's labels, rendering the
      //    select's CAPTION rather than its stored enum value.
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build',
        agentKinds: ['coder'],
      })
      const start = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/${created.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === created.body.id)!
      expect(exec.steps[0]?.output).toContain(
        '[params]Introduce API|Entity=Order;Auth requirement=Service-to-service token;Operations=Create, List[/params]',
      )
    })

    // D8: the descriptor is the CONTRACT at every door, not decoration on the create form. The SPA
    // disables its submit button off the same pure rule, so what this pins is that an API caller
    // (and a stale form) cannot land values the operation never declared: the prompt fold would
    // otherwise present them to the agents as the operation's own brief.
    it('refuses a collected bag that contradicts the registered descriptor', async () => {
      const taskTypeRegistry = defaultTaskTypeRegistry()
      taskTypeRegistry.register({
        taskType: 'conf:introduce-api',
        presentation: {
          label: 'Introduce API',
          icon: 'i-lucide-plug',
          color: '#0ea5e9',
          description: 'Expose functionality over HTTP.',
        },
        fields: [
          { key: 'entity', label: 'Entity', type: 'text', required: true },
          {
            key: 'authRequirement',
            label: 'Auth requirement',
            type: 'select',
            options: [{ value: 'service', label: 'Service-to-service token' }],
          },
        ],
      })
      const app = harness.makeApp(undefined, { taskTypeRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const path = `/workspaces/${wsId}/blocks/blk_auth/tasks`

      // A required field left unanswered, an option outside the declared set, and a key nothing
      // declares are each a 422, the status class a client keys its remedy off.
      const missing = await app.call('POST', path, {
        title: 'Expose orders',
        taskType: 'conf:introduce-api',
        taskTypeFields: { custom: {} },
      })
      expect(missing.status).toBe(422)
      // And OMITTING the bag is the same refusal, not an exemption: a required field is unanswered
      // either way, and a check the caller opts out of by sending nothing is not a check. This is
      // the spelling a headless caller reaches for first, so it is pinned beside the empty one.
      const omitted = await app.call('POST', path, {
        title: 'Expose orders',
        taskType: 'conf:introduce-api',
      })
      expect(omitted.status).toBe(422)
      const badOption = await app.call('POST', path, {
        title: 'Expose orders',
        taskType: 'conf:introduce-api',
        taskTypeFields: { custom: { entity: 'Order', authRequirement: 'anonymous' } },
      })
      expect(badOption.status).toBe(422)
      const unknownKey = await app.call('POST', path, {
        title: 'Expose orders',
        taskType: 'conf:introduce-api',
        taskTypeFields: { custom: { entity: 'Order', bogus: 'x' } },
      })
      expect(unknownKey.status).toBe(422)

      // And a type this deployment does NOT register keeps passing through: an unregistered
      // namespaced type is a supported row (task types are node-local by design), so degrading
      // data must not brick creation.
      const unregistered = await app.call<Block>('POST', path, {
        title: 'Foreign incident',
        taskType: 'other:incident',
        taskTypeFields: { custom: { anything: 'goes' } },
      })
      expect(unregistered.status).toBe(201)
      expect(unregistered.body.taskTypeFields?.custom?.anything).toBe('goes')
    })

    registerOperationPipelineTests(harness)
    registerSuppressionTests(harness)
    registerPublicApiTests(harness)

    it('folds nothing for a built-in task type, so its prompt is unchanged', async () => {
      // The regression bar for the fold: a run that collected no parameters must carry none.
      const app = harness.makeApp({ echoTaskParams: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const created = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'A plain feature',
        description: 'Add a remember-me checkbox to the sign-in form.',
        taskType: 'feature',
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build',
        agentKinds: ['coder'],
      })
      await app.call('POST', `/workspaces/${wsId}/blocks/${created.body.id}/executions`, {
        pipelineId: pipeline.body.id,
      })
      const exec = (await app.drive(wsId)).find((e) => e.blockId === created.body.id)!
      expect(exec.steps[0]?.output).toContain('[params][/params]')
    })
  })
}

/**
 * The lifecycle of the pipeline an operation BUNDLES (D10 / D10b): how the org's canned pipeline
 * reaches a workspace, and how a later version of it does. Registered from the suite above, into the
 * same `describe`; split out purely to keep each function within the per-function line budget (the
 * `registerPipelineCatalogTests` precedent in `core-planning.ts`).
 */
function registerOperationPipelineTests(harness: ConformanceHarness): void {
  // D10: an operation's canned pipeline registers as a READ-ONLY VERSIONED catalog template, and
  // that shape is what makes the operation distributable: the org rolls the pipeline out to
  // boards that predate it and then rolls UPDATES out to the same boards. Driven as three apps
  // over ONE store (the board exists, the org ships the operation, the org bumps it) because the
  // sequencing IS the feature: a workspace created after the registration is seeded with the
  // pipeline at creation and would prove nothing about adoption.
  it('rolls an operation’s canned pipeline out to a board seeded before it, then updates it', async () => {
    const PIPELINE_ID = 'pl_conf_introduce_api'
    const TASK_TYPE = 'conf:introduce-api'

    // 1. The board is seeded while the org's package does not yet exist, so it holds neither the
    //    operation nor its pipeline, and the catalog cannot claim a pipeline nothing registers.
    const before = harness.makeApp()
    const { workspace } = await before.createWorkspace()
    const wsId = workspace.id
    const seeded = await before.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(seeded.body.pipelines.map((p) => p.id)).not.toContain(PIPELINE_ID)
    expect(seeded.body.pipelineCatalogVersions).not.toHaveProperty(PIPELINE_ID)

    // 2. The org ships the operation. Its pipeline is advertised in the catalog versions with NO
    //    stored row: precisely the state the SPA's new-pipeline advisory offers to materialise,
    //    and reachable only because the registration is `builtin` with a `version` (a versionless
    //    one is version 0 to the advisory and un-reseedable once stored).
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      taskType: TASK_TYPE,
      presentation: {
        label: 'Introduce API',
        icon: 'i-lucide-plug',
        color: '#0ea5e9',
        description: 'Expose functionality over HTTP.',
      },
      fields: [{ key: 'entity', label: 'Entity', type: 'text', required: true }],
      defaultPipelineId: PIPELINE_ID,
    })
    const v1 = new PipelineRegistry()
    v1.register({
      id: PIPELINE_ID,
      name: 'Introduce API',
      builtin: true,
      version: 1,
      agentKinds: ['architect', 'coder'],
    })
    const shipped = harness.makeApp(undefined, { pipelineRegistry: v1, taskTypeRegistry })
    const advertised = await shipped.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(advertised.body.pipelineCatalogVersions?.[PIPELINE_ID]).toBe(1)
    expect(advertised.body.pipelines.map((p) => p.id)).not.toContain(PIPELINE_ID)

    // 3. One reseed MATERIALISES it as an INSERT into a board that never held the row, the half
    //    of the reseed path a workspace created after the registration never exercises. It lands
    //    read-only, so the operation's pipeline cannot be reshaped out from under the type that
    //    pins it. Deviating is a clone.
    const reseed = `/workspaces/${wsId}/pipelines/${PIPELINE_ID}/reseed`
    const added = await shipped.call<Pipeline>('POST', reseed)
    expect(added.status).toBe(200)
    expect(added.body.builtin).toBe(true)
    expect(added.body.version).toBe(1)
    const edit = await shipped.call('PATCH', `/workspaces/${wsId}/pipelines/${PIPELINE_ID}`, {
      name: 'Mine',
    })
    expect(edit.status).toBe(422)

    // The rollout's point: the operation is now invocable on this board, its task pinning the
    // pipeline the board just adopted.
    const task = await shipped.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Expose orders',
      taskType: TASK_TYPE,
      taskTypeFields: { custom: { entity: 'Order' } },
    })
    expect(task.status).toBe(201)
    expect(task.body.pipelineId).toBe(PIPELINE_ID)

    // 4. The org tightens the operation and bumps the version. The catalog moves ahead of the
    //    stored copy (the drift signal the advisory reads to offer an update), and the SAME
    //    reseed adopts the new definition.
    const v2 = new PipelineRegistry()
    v2.register({
      id: PIPELINE_ID,
      name: 'Introduce API',
      builtin: true,
      version: 2,
      agentKinds: ['architect', 'coder', 'tester-api'],
    })
    const upgraded = harness.makeApp(undefined, { pipelineRegistry: v2, taskTypeRegistry })
    const drifted = await upgraded.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(drifted.body.pipelineCatalogVersions?.[PIPELINE_ID]).toBe(2)
    expect(drifted.body.pipelines.find((p) => p.id === PIPELINE_ID)?.version).toBe(1)
    const adopted = await upgraded.call<Pipeline>('POST', reseed)
    expect(adopted.status).toBe(200)
    expect(adopted.body.version).toBe(2)
    expect(adopted.body.agentKinds).toEqual(['architect', 'coder', 'tester-api'])
  })

  // The other half of D10's rollout: a board does not have to ADOPT the operation's pipeline
  // before it can invoke the operation. An operation pins its pipeline by id off the task-type
  // registry, which knows nothing about rows, so on a board older than the registration a task
  // of the operation was creatable and then refused to start. Starting now materialises the
  // catalog row rather than running off the code copy, because a run must never use a pipeline
  // the board's own library cannot show, open in the builder, or attach a schedule to.
  it('adopts an operation’s canned pipeline on first run, once, under concurrent starts', async () => {
    const PIPELINE_ID = 'pl_conf_adopt_on_start'
    const TASK_TYPE = 'conf:adopt-on-start'

    // 1. The board is seeded before the org's package exists.
    const before = harness.makeApp()
    const { workspace } = await before.createWorkspace()
    const wsId = workspace.id

    // 2. The org ships the operation. Nobody reseeds, so the board still holds no row for it.
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      taskType: TASK_TYPE,
      presentation: {
        label: 'Adopt on start',
        icon: 'i-lucide-plug',
        color: '#0ea5e9',
        description: 'Expose functionality over HTTP.',
      },
      defaultPipelineId: PIPELINE_ID,
    })
    const registry = new PipelineRegistry()
    registry.register({
      id: PIPELINE_ID,
      name: 'Adopt on start',
      builtin: true,
      version: 3,
      agentKinds: ['coder'],
    })
    const app = harness.makeApp(undefined, { pipelineRegistry: registry, taskTypeRegistry })
    const unadopted = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect(unadopted.body.pipelines.map((p) => p.id)).not.toContain(PIPELINE_ID)

    // 3. Two tasks of the operation, both pinning the un-adopted pipeline, started AT ONCE. Both
    //    resolve "no row" and both adopt, which is the race a plain insert would 500 the loser on.
    const tasks = await Promise.all(
      ['Expose orders', 'Expose refunds'].map((title) =>
        app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title,
          taskType: TASK_TYPE,
        }),
      ),
    )
    expect(tasks.map((t) => t.body.pipelineId)).toEqual([PIPELINE_ID, PIPELINE_ID])
    const starts = await Promise.all(
      tasks.map((t) =>
        app.call('POST', `/workspaces/${wsId}/blocks/${t.body.id}/executions`, {
          pipelineId: PIPELINE_ID,
        }),
      ),
    )
    expect(starts.map((s) => s.status)).toEqual([201, 201])

    // 4. Adoption persisted the catalog row ONCE, at its catalog version, and read-only: the
    //    board's library now shows exactly what ran, which is the whole reason this writes.
    const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    const stored = after.body.pipelines.filter((p) => p.id === PIPELINE_ID)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.builtin).toBe(true)
    expect(stored[0]?.version).toBe(3)
    expect(after.body.pipelineCatalogVersions?.[PIPELINE_ID]).toBe(3)

    // 5. An id that is neither stored nor in the live catalog is still a 404. Adoption widens what
    //    resolves to the catalog, never to anything a caller names.
    const bogus = await app.call('POST', `/workspaces/${wsId}/blocks/blk_auth/executions`, {
      pipelineId: 'pl_conf_never_registered',
    })
    expect(bogus.status).toBe(404)
  })
}

/**
 * D12: a workspace admin HIDES a registered operation from that board. An org registers its
 * operations process-wide, so twenty of them flood a team that runs three; suppression is the
 * per-workspace answer, and it is the only piece of this feature that is DATA rather than code
 * (the descriptors themselves stay node-local by design).
 *
 * Crosses persistence on both runtimes (a tombstone row keyed `(workspace, taskType)`) AND both
 * doors that read it: the snapshot projection the picker is drawn from, and the creation refusal
 * that keeps every non-picker door in step with it.
 */
function registerSuppressionTests(harness: ConformanceHarness): void {
  it('hides a registered operation from one board, refuses creating it, and restores it', async () => {
    const HIDDEN = 'conf:hidden-op'
    const KEPT = 'conf:kept-op'
    const taskTypeRegistry = defaultTaskTypeRegistry()
    for (const [taskType, label] of [
      [HIDDEN, 'Hidden op'],
      [KEPT, 'Kept op'],
    ]) {
      taskTypeRegistry.register({
        taskType: taskType!,
        presentation: {
          label: label!,
          icon: 'i-lucide-plug',
          color: '#0ea5e9',
          description: 'A registered operation.',
        },
      })
    }
    const app = harness.makeApp(undefined, { taskTypeRegistry })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const suppressions = `/workspaces/${wsId}/task-type-suppressions`

    // 1. Nothing is suppressed by default: a newly registered operation is offered on every board
    //    until somebody hides it, which is the only direction that cannot silently withhold one.
    const listed = await app.call<{
      taskTypes: { taskType: { taskType: string }; suppressed: boolean }[]
    }>('GET', suppressions)
    expect(listed.status).toBe(200)
    expect(listed.body.taskTypes.map((row) => row.taskType.taskType).sort()).toEqual([HIDDEN, KEPT])
    expect(listed.body.taskTypes.every((row) => !row.suppressed)).toBe(true)

    // 2. Hiding one drops it from the snapshot catalog the picker renders, and ONLY it.
    const hidden = await app.call('PUT', `${suppressions}/${encodeURIComponent(HIDDEN)}`)
    expect(hidden.status).toBe(200)
    const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    const offered = (snap.body.customTaskTypes ?? []).map((t) => t.taskType)
    expect(offered).toContain(KEPT)
    expect(offered).not.toContain(HIDDEN)
    // The COMPLEMENT rides the same snapshot, and it is what keeps hiding reversible. The offered
    // catalog alone cannot tell \"this deployment registers no operations\" from \"this board hid
    // the ones it has\", so a SPA reading only that drops the settings screen the moment the last
    // operation is hidden, taking away the only surface that un-hides one.
    expect(snap.body.suppressedTaskTypes).toEqual([HIDDEN])

    // 3. And the SERVER refuses creating one, so the internal API, the public API, an initiative
    //    spawn and a tracker import cannot land what the picker no longer offers.
    const refused = await app.call('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Should not land',
      taskType: HIDDEN,
    })
    expect(refused.status).toBe(422)
    const allowed = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Still fine',
      taskType: KEPT,
    })
    expect(allowed.status).toBe(201)

    // 4. The suppression LIST is its own read precisely because a hidden id is by construction
    //    absent from the catalog above: nothing else could offer the way back.
    const withHidden = await app.call<{
      taskTypes: { taskType: { taskType: string }; suppressed: boolean }[]
    }>('GET', suppressions)
    expect(withHidden.body.taskTypes.find((r) => r.taskType.taskType === HIDDEN)?.suppressed).toBe(
      true,
    )

    // 5. Restoring hard-deletes the tombstone: the operation is offered and creatable again.
    const restored = await app.call('DELETE', `${suppressions}/${encodeURIComponent(HIDDEN)}`)
    expect(restored.status).toBe(200)
    const reoffered = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
    expect((reoffered.body.customTaskTypes ?? []).map((t) => t.taskType)).toContain(HIDDEN)
    // Absent rather than empty once nothing is hidden, like every other registry projection.
    expect(reoffered.body.suppressedTaskTypes).toBeUndefined()
    const created = await app.call('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Lands now',
      taskType: HIDDEN,
    })
    expect(created.status).toBe(201)

    // 6. Suppressing twice is a no-op rather than a duplicate-key failure, and an id the
    //    deployment does not register is a 404: a typo must not leave a tombstone that hides
    //    nothing and appears on no screen (the settings list renders the registry, not the store).
    expect((await app.call('PUT', `${suppressions}/${encodeURIComponent(KEPT)}`)).status).toBe(200)
    expect((await app.call('PUT', `${suppressions}/${encodeURIComponent(KEPT)}`)).status).toBe(200)
    expect((await app.call('PUT', `${suppressions}/conf%3Anever-registered`)).status).toBe(404)
  })

  it('scopes a suppression to the board that made it', async () => {
    // The whole point of the per-workspace row: one team hiding an operation must not take it away
    // from the next board in the same deployment, which reads the same process-wide registry.
    const TASK_TYPE = 'conf:scoped-op'
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      taskType: TASK_TYPE,
      presentation: {
        label: 'Scoped op',
        icon: 'i-lucide-plug',
        color: '#0ea5e9',
        description: 'A registered operation.',
      },
    })
    const app = harness.makeApp(undefined, { taskTypeRegistry })
    const hiding = (await app.createWorkspace()).workspace
    const other = (await app.createWorkspace()).workspace
    await app.call(
      'PUT',
      `/workspaces/${hiding.id}/task-type-suppressions/${encodeURIComponent(TASK_TYPE)}`,
    )

    const hidden = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${hiding.id}`)
    expect((hidden.body.customTaskTypes ?? []).map((t) => t.taskType)).not.toContain(TASK_TYPE)
    const untouched = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${other.id}`)
    expect((untouched.body.customTaskTypes ?? []).map((t) => t.taskType)).toContain(TASK_TYPE)
  })
}

/** One block from the workspace snapshot, the only read that addresses a block by id here. */
async function blockById(
  app: { call: <T>(method: string, path: string) => Promise<{ body: T }> },
  workspaceId: string,
  blockId: string,
): Promise<Block | undefined> {
  const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
  return snapshot.body.blocks.find((block) => block.id === blockId)
}

/**
 * D9: the public API can DISCOVER a task type's form and FILL it. A headless caller could always
 * name a registered operation and never fill one of its fields, so every run it filed started with
 * the per-case brief the form exists to collect left blank.
 *
 * Driven end to end over a real key because the two halves have to agree: what discovery advertises
 * is what creation validates against, and the second is what proves the first is not a separate
 * hand-written shape.
 */
function registerPublicApiTests(harness: ConformanceHarness): void {
  it('discovers a registered operation’s form over /api/v1 and fills it on create', async () => {
    const TASK_TYPE = 'conf:public-op'
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      taskType: TASK_TYPE,
      presentation: {
        label: 'Public op',
        icon: 'i-lucide-plug',
        color: '#0ea5e9',
        description: 'Expose functionality over HTTP.',
        category: 'API delivery',
      },
      fields: [
        { key: 'entity', label: 'Entity', type: 'text', required: true },
        {
          key: 'operations',
          label: 'Operations',
          type: 'checkbox-group',
          options: [
            { value: 'create', label: 'Create' },
            { value: 'list', label: 'List' },
          ],
        },
        {
          key: 'authRequirement',
          label: 'Auth requirement',
          type: 'select',
          default: 'service',
          required: true,
          options: [{ value: 'service', label: 'Service-to-service token' }],
        },
      ],
    })
    const app = harness.makeApp(undefined, { taskTypeRegistry })
    const { workspace } = await app.createOrgWorkspace({ seed: true })
    const wsId = workspace.id
    const key = await app.call<{ secret: string }>('POST', `/workspaces/${wsId}/public-api-keys`, {
      label: 'external',
    })
    const auth = { authorization: `Bearer ${key.body.secret}` }

    // 1. Discovery serves the built-in kinds AND the registered operation, each with the form it
    //    accepts, which are the descriptors creation is about to be checked against.
    const catalog = await app.call<{
      taskTypes: {
        taskType: string
        builtin: boolean
        label: string
        category?: string
        fields: { key: string; type?: string; options?: { value: string }[] }[]
      }[]
    }>('GET', '/api/v1/task-types', undefined, auth)
    expect(catalog.status).toBe(200)
    const byId = new Map(catalog.body.taskTypes.map((t) => [t.taskType, t]))
    expect(byId.get('bug')?.builtin).toBe(true)
    expect(byId.get('bug')?.fields.map((f) => f.key)).toContain('severity')
    const op = byId.get(TASK_TYPE)
    expect(op?.builtin).toBe(false)
    expect(op?.category).toBe('API delivery')
    expect(op?.fields.map((f) => f.key)).toEqual(['entity', 'operations', 'authRequirement'])

    const frame = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
      type: 'service',
      position: { x: 400, y: 400 },
    })
    const tasks = `/api/v1/services/${frame.body.id}/tasks`

    // 2. Filling them lands the values on the task. `authRequirement` is required AND defaulted, so
    //    omitting it is answered by the descriptor rather than refused: the rule that had the SPA
    //    accepting what a headless caller could not.
    const created = await app.call<{ taskId: string }>(
      'POST',
      tasks,
      {
        title: 'Expose orders',
        taskType: TASK_TYPE,
        fields: { entity: 'Order', operations: ['create', 'list'] },
      },
      auth,
    )
    expect(created.status).toBe(201)
    // Read back through the workspace SNAPSHOT, as every other assertion in this file does. There
    // is no `GET /workspaces/:ws/blocks/:id` route; addressing one answered Hono's plain-text 404,
    // which is not JSON, so this step failed on a parse error rather than on anything it asserts.
    const block = await blockById(app, wsId, created.body.taskId)
    expect(block?.taskTypeFields?.custom).toEqual({
      entity: 'Order',
      operations: ['create', 'list'],
      authRequirement: 'service',
    })

    // 3. The descriptor is the contract here too: a missing required field with no default, an
    //    option outside the declared set and an undeclared key are each a 422 naming the reason.
    const missing = await app.call<{ error: { details?: { reason?: string } } }>(
      'POST',
      tasks,
      { title: 'No entity', taskType: TASK_TYPE, fields: { operations: ['create'] } },
      auth,
    )
    expect(missing.status).toBe(422)
    expect(missing.body.error.details?.reason).toBe('task_type_fields_invalid')
    const badOption = await app.call(
      'POST',
      tasks,
      { title: 'Bad op', taskType: TASK_TYPE, fields: { entity: 'Order', operations: ['purge'] } },
      auth,
    )
    expect(badOption.status).toBe(422)
    const unknownKey = await app.call(
      'POST',
      tasks,
      { title: 'Unknown', taskType: TASK_TYPE, fields: { entity: 'Order', bogus: 'x' } },
      auth,
    )
    expect(unknownKey.status).toBe(422)

    // 4. A BUILT-IN type's fields map onto the schema-typed TOP-LEVEL keys instead, so the existing
    //    creation machinery keeps working unchanged, which is the asymmetry the mapper exists for.
    const bug = await app.call<{ taskId: string }>(
      'POST',
      tasks,
      {
        title: 'Checkout 500s',
        taskType: 'bug',
        fields: { severity: 'critical', stepsToReproduce: 'Place an order, watch it 500.' },
      },
      auth,
    )
    expect(bug.status).toBe(201)
    const bugBlock = await blockById(app, wsId, bug.body.taskId)
    expect(bugBlock?.taskTypeFields?.severity).toBe('critical')
    expect(bugBlock?.taskTypeFields?.custom).toBeUndefined()
    expect(
      (
        await app.call(
          'POST',
          tasks,
          { title: 'Bad severity', taskType: 'bug', fields: { severity: 'apocalyptic' } },
          auth,
        )
      ).status,
    ).toBe(422)

    // 5. A SUPPRESSED operation is absent from discovery, because this endpoint answers "what may I
    //    create here": listing one whose creation is then refused would mislead the very client
    //    that read it.
    await app.call(
      'PUT',
      `/workspaces/${wsId}/task-type-suppressions/${encodeURIComponent(TASK_TYPE)}`,
    )
    const afterHide = await app.call<{ taskTypes: { taskType: string }[] }>(
      'GET',
      '/api/v1/task-types',
      undefined,
      auth,
    )
    expect(afterHide.body.taskTypes.map((t) => t.taskType)).not.toContain(TASK_TYPE)
  })
}
