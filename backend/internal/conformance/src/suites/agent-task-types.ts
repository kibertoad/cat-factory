import { defaultTaskTypeRegistry } from '@cat-factory/kernel'
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

    it('folds nothing for a built-in task type, so its prompt is unchanged', async () => {
      // The regression bar for the fold: a run that collected no parameters must carry none.
      const app = harness.makeApp({ echoTaskParams: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const created = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'A plain feature',
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
