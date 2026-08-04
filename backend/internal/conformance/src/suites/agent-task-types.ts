import { PipelineRegistry, defaultTaskTypeRegistry } from '@cat-factory/kernel'
import type { Block, Pipeline, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

/**
 * A deployment-registered custom TASK TYPE, and the REUSABLE OPERATION bundle built on it
 * (`docs/initiatives/reusable-operations.md`): the descriptor's snapshot projection and pipeline
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

    // The REUSABLE OPERATION bundle (docs/initiatives/reusable-operations.md): a registered type
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
