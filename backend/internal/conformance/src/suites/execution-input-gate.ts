import type { Block, ExecutionInstance, RunInputGate } from '@cat-factory/kernel'
import { defaultTaskTypeRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// PRE-DISPATCH INPUT GATE conformance. The gate is the run's last chance to refuse work for free:
// it reduces the task's authored input before the first agent step is dispatched, and parks the
// run when there is structurally nothing to act on.
//
// Every assertion here is about a property a facade could get wrong independently, the mode
// column round-tripping, the verdict surviving on the run row's `detail` JSON, the park clearing
// only on a verified fix, so all of it must hold identically on D1 and Postgres.
export function defineInputGateConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    it('parks a title-only task before its first dispatch, and no step ever runs', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Make the login better',
      })
      expect(task.status).toBe(201)
      const blockId = task.body.id

      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${blockId}/executions`,
        { pipelineId: 'pl_simple' },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(exec.status).toBe('blocked')
      expect(exec.inputGate?.status).toBe('blocked')
      expect(exec.inputGate?.issues).toEqual([
        { code: 'description_missing', severity: 'blocking' },
      ])
      // The whole point: the run parked having dispatched nothing. Step 0 is parked on the
      // decision, and no step has produced output.
      expect(exec.steps[0]?.state).toBe('waiting_decision')
      expect(exec.steps.every((s) => !s.output)).toBe(true)
    })

    it('recheck releases the run only once the task is genuinely fixed', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Make the login better',
      })
      const blockId = task.body.id
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${blockId}/executions`,
        { pipelineId: 'pl_simple' },
      )
      const execId = start.body.id
      await app.drive(wsId)

      // A recheck against the STILL-unfixed task refreshes the findings and stays parked, the
      // fix is verified, never taken on the caller's word.
      const still = await app.call<RunInputGate>(
        'POST',
        `/workspaces/${wsId}/executions/${execId}/input-gate/resolve`,
        { choice: 'recheck' },
      )
      expect(still.status).toBe(200)
      expect(still.body.status).toBe('blocked')

      // Fill the description in, then recheck again: now it clears and the run finishes.
      await app.call('PATCH', `/workspaces/${wsId}/blocks/${blockId}`, {
        description:
          'The login form should keep the typed email when a sign-in attempt fails validation.',
      })
      const cleared = await app.call<RunInputGate>(
        'POST',
        `/workspaces/${wsId}/executions/${execId}/input-gate/resolve`,
        { choice: 'recheck' },
      )
      expect(cleared.status).toBe(200)
      expect(cleared.body.status).toBe('passed')

      const done = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(done.status).toBe('done')
      // The released run resumed the SAME step rather than skipping it.
      expect(done.steps[0]?.state).toBe('done')
    })

    it('proceed waives the findings and keeps them on the record', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Make the login better',
      })
      const blockId = task.body.id
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${blockId}/executions`,
        { pipelineId: 'pl_simple' },
      )
      await app.drive(wsId)

      const waived = await app.call<RunInputGate>(
        'POST',
        `/workspaces/${wsId}/executions/${start.body.id}/input-gate/resolve`,
        { choice: 'proceed' },
      )
      expect(waived.status).toBe(200)
      // `overridden`, never `passed`: what was waived is part of the run's history.
      expect(waived.body.status).toBe('overridden')
      expect(waived.body.issues).toEqual([{ code: 'description_missing', severity: 'blocking' }])

      const done = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(done.status).toBe('done')
      expect(done.inputGate?.status).toBe('overridden')
    })

    it('resolving a run that is not parked on the gate is a 409, not a silent no-op', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: 'pl_simple' },
      )
      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${start.body.id}/input-gate/resolve`,
        { choice: 'proceed' },
      )
      expect(res.status).toBe(409)
    })

    it('an `off` workspace records that nobody looked, rather than a clean bill of health', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.call('PUT', `/workspaces/${wsId}/settings`, { inputGateMode: 'off' })
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Make the login better',
      })
      const blockId = task.body.id
      await app.call('POST', `/workspaces/${wsId}/blocks/${blockId}/executions`, {
        pipelineId: 'pl_simple',
      })

      const exec = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(exec.status).toBe('done')
      // `off` with NO findings, not `passed` with an empty list, which would claim the input
      // was checked and found sound.
      expect(exec.inputGate).toMatchObject({ status: 'off', mode: 'off', issues: [] })
    })

    it('does not judge a recurring schedule block, whose input is the schedule', async () => {
      // A recurring schedule reuses one on-board block that no human authored, so its blank
      // description means nothing is wrong. Recorded as `not_applicable`, which is neither
      // `off` (a setting somebody chose) nor `passed` (a description we judged and liked).
      const app = harness.makeApp({ confidence: 1 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Nightly design',
        agentKinds: ['architect'],
      })
      const schedule = await app.call<{ id: string; blockId: string }>(
        'POST',
        `/workspaces/${wsId}/recurring-pipelines`,
        {
          frameId: 'blk_auth',
          pipelineId: pipeline.body.id,
          name: 'Nightly',
          recurrence: {
            intervalHours: 24,
            weekdays: [] as number[],
            windowStartHour: null,
            windowEndHour: null,
            timezone: 'UTC',
          },
        },
      )
      expect(
        (
          await app.call(
            'POST',
            `/workspaces/${wsId}/recurring-pipelines/${schedule.body.id}/run-now`,
          )
        ).status,
      ).toBe(200)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === schedule.body.blockId)!
      expect(exec.status).toBe('done')
      expect(exec.inputGate).toMatchObject({
        status: 'not_applicable',
        mode: 'standard',
        issues: [],
      })
    })

    it('does not judge a run against a block that is not a TASK', async () => {
      // A run can be started against a frame, a module or an initiative anchor, and such a block
      // stands for an entity whose real input lives elsewhere (the initiative's goal and plan,
      // the service's spec). Its description is a caption, so judging it parked exactly the runs
      // with no task card anyone could go and fix. Asserted on the SERVICE FRAME because it is
      // the level every harness seeds; the rule is the same for all four non-task levels.
      const app = harness.makeApp({ confidence: 1 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, { description: '' })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/blk_auth/executions`,
        { pipelineId: 'pl_simple' },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'blk_auth')!
      expect(exec.status).toBe('done')
      expect(exec.inputGate).toMatchObject({
        status: 'not_applicable',
        mode: 'standard',
        issues: [],
      })
    })

    it('advisory mode records the findings and runs anyway', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.call('PUT', `/workspaces/${wsId}/settings`, { inputGateMode: 'advisory' })
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'Make the login better',
      })
      const blockId = task.body.id
      await app.call('POST', `/workspaces/${wsId}/blocks/${blockId}/executions`, {
        pipelineId: 'pl_simple',
      })

      const exec = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(exec.status).toBe('done')
      expect(exec.inputGate).toMatchObject({
        status: 'passed',
        mode: 'advisory',
        issues: [{ code: 'description_missing', severity: 'advisory' }],
      })
    })

    it('parks on a CUSTOM task type’s own required field, and the field survives the round trip', async () => {
      // A deployment declares a required field on its own task type, and the gate reads THAT
      // declaration rather than a second one — so the create form and the run agree by
      // construction. What the gate adds is WHEN it asks: the create check fired once, against
      // the declaration as it stood that day; this one fires at every run, against the
      // declaration as it stands now.
      //
      // Which is exactly what is modelled here. A task is created while the type declares the
      // field OPTIONAL, then a later release marks it required. No create-time check can reach
      // back to that row; the gate parks the run instead of dispatching an agent with nothing.
      // (The same shape covers a task created on a node that did not register the type at all,
      // which is normal in a two-process deployment.)
      const optional = defaultTaskTypeRegistry()
      const presentation = {
        label: 'Incident',
        icon: 'i-lucide-siren',
        color: '#ef4444',
        description: 'A production incident to triage.',
      }
      optional.register({
        taskType: 'conf:incident',
        presentation,
        fields: [{ key: 'impact', label: 'Customer impact' }],
      })
      const before = harness.makeApp(undefined, { taskTypeRegistry: optional })
      const { workspace } = await before.createWorkspace()
      const wsId = workspace.id
      const task = await before.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
        title: 'EU shard outage',
        description: 'The EU shard started refusing writes at 14:02 and recovered at 14:19.',
        taskType: 'conf:incident',
      })
      expect(task.status).toBe(201)
      const blockId = task.body.id

      // The next release requires it. Same store, same task, stricter declaration.
      const required = defaultTaskTypeRegistry()
      required.register({
        taskType: 'conf:incident',
        presentation,
        fields: [{ key: 'impact', label: 'Customer impact', required: true }],
      })
      const app = harness.makeApp(undefined, { taskTypeRegistry: required })
      await app.call('POST', `/workspaces/${wsId}/blocks/${blockId}/executions`, {
        pipelineId: 'pl_simple',
      })

      const parked = (await app.drive(wsId)).find((e) => e.blockId === blockId)!
      expect(parked.status).toBe('blocked')
      // The description is a real brief, so this park is the custom field's doing alone — and it
      // NAMES the field, carrying the deployment's own label. That name is the part only a real
      // runtime can vouch for: it rides the run row's `detail` JSON, and a facade that dropped it
      // would leave a human parked on "something is missing".
      expect(parked.inputGate?.issues).toEqual([
        {
          code: 'required_field_missing',
          severity: 'blocking',
          field: { key: 'impact', label: 'Customer impact' },
        },
      ])
      // The whole point: it parked having dispatched nothing.
      expect(parked.steps.every((s) => !s.output)).toBe(true)

      // A human waives it, and the finding STAYS on the record under `overridden` — what was
      // waived is part of the run's history, which no reader can mistake for `passed`.
      const waived = await app.call<RunInputGate>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/input-gate/resolve`,
        { choice: 'proceed' },
      )
      expect(waived.status).toBe(200)
      expect(waived.body.status).toBe('overridden')
      expect(waived.body.issues[0]?.field).toEqual({ key: 'impact', label: 'Customer impact' })
    })
  })
}
