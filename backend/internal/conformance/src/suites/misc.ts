import {
  BUG_TRIAGE_PIPELINE_ID,
  type Block,
  type ExecutionInstance,
  type Pipeline,
  type PipelineSchedule,
  type ScheduleRun,
  type SlackMemberMappingEntry,
  type SlackNotificationSettings,
  type TrackerSettings,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeTaskSourceProvider } from '../FakeTaskSourceProvider.js'
import type { ConformanceHarness } from '../harness.js'

export function defineMiscConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('recurring pipelines', () => {
      const recurrence = {
        intervalHours: 24,
        weekdays: [] as number[],
        windowStartHour: null,
        windowEndHour: null,
        timezone: 'UTC',
      }

      it('creates a schedule with a reused block and surfaces it on the snapshot', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: 'pl_dep_update', name: 'Weekly deps', recurrence },
        )
        expect(created.status).toBe(201)
        expect(created.body.frameId).toBe('blk_auth')
        expect(created.body.nextRunAt).toBeGreaterThan(0)

        // The schedule materialised a reused task block under the service frame.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === created.body.blockId)
        expect(block?.parentId).toBe('blk_auth')
        expect(block?.level).toBe('task')
        expect(snapshot.body.recurringPipelines?.map((s) => s.id)).toContain(created.body.id)

        // Listing + deletion (which removes the reused block too).
        const list = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(list.body).toHaveLength(1)
        const del = await app.call(
          'DELETE',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
        )
        expect(del.status).toBe(204)
        const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(after.body.blocks.find((b) => b.id === created.body.blockId)).toBeUndefined()
      })

      it('round-trips the issue-intake config through create, update, and clear', async () => {
        // `issueIntake` (bug-triage Phase D) is a persisted JSON column on
        // `pipeline_schedules`, so this pins the column mapping on BOTH runtimes —
        // a facade that drops it on save would leave every bug-intake fire scopeless.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const issueIntake = {
          source: 'jira',
          board: { jiraProjectKey: 'PROJ' },
          predicates: { titleFragment: 'crash', labels: ['bug'], issueType: 'Bug' },
        }
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: 'pl_dep_update',
            name: 'Bug triage',
            recurrence,
            issueIntake,
          },
        )
        expect(created.status).toBe(201)
        expect(created.body.issueIntake).toEqual(issueIntake)

        // The config survives a persistence round-trip (list re-reads the row).
        const listed = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(listed.body.find((s) => s.id === created.body.id)?.issueIntake).toEqual(issueIntake)

        // PATCH replaces the config…
        const replaced = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          {
            issueIntake: {
              source: 'github',
              board: { githubRepo: 'octo/app' },
              predicates: {},
              inProgressLabel: 'bot-working',
            },
          },
        )
        expect(replaced.status).toBe(200)
        expect(replaced.body.issueIntake?.source).toBe('github')
        expect(replaced.body.issueIntake?.inProgressLabel).toBe('bot-working')

        // …an unrelated PATCH leaves it untouched, and null clears it.
        const renamed = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          { name: 'Renamed' },
        )
        expect(renamed.body.issueIntake?.source).toBe('github')
        const cleared = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          { issueIntake: null },
        )
        expect(cleared.status).toBe(200)
        expect(cleared.body.issueIntake).toBeUndefined()
        const after = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(after.body.find((s) => s.id === created.body.id)?.issueIntake).toBeUndefined()
      })

      it('run-now starts an execution on the reused block and records run history', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A single-step inline pipeline keeps the run deterministic across runtimes.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Recurring inline',
          agentKinds: ['architect'],
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: pipeline.body.id, name: 'Nightly', recurrence },
        )

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        // A running history row pointing at a real execution on the schedule's block.
        const running = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(running.body).toHaveLength(1)
        expect(running.body[0]!.executionId).toBeTruthy()

        // Drive it to completion; the history (overlaid with live status) shows done.
        const driven = await app.drive(wsId)
        expect(driven.find((e) => e.blockId === created.body.blockId)?.status).toBe('done')
        const done = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(done.body[0]!.status).toBe('done')

        // A second run-now while the (now-finished) run exists still works; firing
        // twice in a row never starts two concurrent runs on the same block.
        const again = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(again.status).toBe(200)
      })

      it('bug-intake picks up a matching issue, seeds the block, and drives to completion', async () => {
        // A Jira fake source, CONNECTED (so it is `offered` — available + enabled — which the
        // schedule intake-config validation requires), pre-loaded with an open bug. The suite holds
        // the instance to seed the backlog + inspect the recorded query.
        const source = new FakeTaskSourceProvider('jira')
        source.set('42', { title: 'Login crashes on submit', labels: ['bug'], status: 'open' })
        const app = harness.makeApp({ confidence: 1 }, { taskSourceProviders: [source] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        // Connect the source so it counts as a usable intake source (the fake accepts any creds).
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        // A recurring pipeline whose first step is `bug-intake`; a trailing `architect` step
        // proves the run advances past intake when an issue is picked up.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash', labels: ['bug'] },
            },
          },
        )
        expect(created.status).toBe(201)
        const blockId = created.body.blockId

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        const driven = await app.drive(wsId)
        const run = driven.find((e) => e.blockId === blockId)
        expect(run?.status).toBe('done')
        // The intake step recorded the pickup, and NEITHER step was skipped (the fix work ran).
        const intakeStep = run?.steps.find((s) => s.agentKind === 'bug-intake')
        expect(intakeStep?.output).toContain('42')
        expect(intakeStep?.skipped).toBeFalsy()
        expect(run?.steps.find((s) => s.agentKind === 'architect')?.skipped).toBeFalsy()

        // The search ran with the schedule's predicates pushed into the intake query.
        expect(source.intakeCalls).toHaveLength(1)
        expect(source.intakeCalls[0]!.query.titleFragment).toBe('crash')

        // The reused block was reseeded from the picked issue (title keyed by the external id).
        const block = await app.blockRepository().get(wsId, blockId)
        expect(block?.title).toContain('42')
        expect(block?.title).toContain('Login crashes on submit')
      })

      it('bug-intake with no matching issue completes the run, skipping the remaining steps', async () => {
        // The backlog holds only a NON-matching issue (wrong title), so nothing qualifies. A
        // CONNECTED Jira source (the schedule validation requires an offered source).
        const source = new FakeTaskSourceProvider('jira')
        source.set('7', { title: 'Update docs', labels: ['bug'], status: 'open' })
        const app = harness.makeApp({ confidence: 1 }, { taskSourceProviders: [source] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash' },
            },
          },
        )
        const blockId = created.body.blockId
        const blockBefore = await app.blockRepository().get(wsId, blockId)

        await app.call('POST', `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`)
        const driven = await app.drive(wsId)
        const run = driven.find((e) => e.blockId === blockId)

        // The run completes SUCCESSFULLY, with the trailing step skipped (nothing to fix).
        expect(run?.status).toBe('done')
        const intakeStep = run?.steps.find((s) => s.agentKind === 'bug-intake')
        expect(intakeStep?.skipped).toBeFalsy()
        expect(intakeStep?.output).toContain('No matching')
        expect(run?.steps.find((s) => s.agentKind === 'architect')?.skipped).toBe(true)

        // No issue was picked up, so the block's title is untouched, the block is finalized `done`
        // (NOT `pr_ready`), and — since nothing was worked and no PR opened — the no-op raises NO
        // `pipeline_complete` "confirm + merge" notification.
        const blockAfter = await app.blockRepository().get(wsId, blockId)
        expect(blockAfter?.title).toBe(blockBefore?.title)
        expect(blockAfter?.status).toBe('done')
        const notes = await app.notificationRepository().listOpen(wsId)
        expect(notes.some((n) => n.blockId === blockId)).toBe(false)
      })

      it('rejects a bug-intake schedule with no issue-intake configuration', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        // Attaching it to a schedule with no `issueIntake` is refused up front (every fire would
        // otherwise silently no-op — nothing to pull work from).
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: pipeline.body.id, name: 'Nightly', recurrence },
        )
        expect(created.status).toBe(422)
      })

      // Phase H — the whole built-in `pl_bug_triage` pipeline end to end on a schedule: a fire
      // pulls one matching issue (bug-intake), investigates it (bug-investigator → clear ⇒ the
      // clarity gate auto-passes with no park), estimates it (task-estimator), reproduces it
      // (repro-test), fixes it (coder), reviews it (reviewer), tests it (tester-api, greenlights),
      // and drives the conflicts/ci/merger tail to an auto-merge. This asserts the SEEDED
      // definition (`availability: 'recurring'`, the exact step order) drives to completion
      // identically on every runtime — not a hand-built pipeline. The investigator/repro results
      // ride ONE lenient superset `customResult`: each structured kind reads only its own fields
      // (both schemas strip the rest), so the single fake result satisfies both.
      it('drives the built-in pl_bug_triage pipeline end to end: intake → investigate → repro → fix → merge', async () => {
        const source = new FakeTaskSourceProvider('jira')
        source.set('99', {
          title: 'Checkout crashes on empty cart',
          labels: ['bug'],
          status: 'open',
        })
        const app = harness.makeApp(
          {
            confidence: 1,
            // A superset of the bug-investigator triage (clear ⇒ auto-pass) and the repro-test
            // outcome (reproduced) — each kind parses only its own fields.
            customResult: {
              clarity: 'clear',
              summary: 'The checkout handler dereferences an empty cart.',
              rootCauseHypotheses: ['Missing empty-cart guard in checkout()'],
              affectedRepos: [],
              suggestedReproductions: ['POST /checkout with an empty cart'],
              questions: [],
              outcome: 'reproduced',
              testPaths: ['test/checkout.test.ts'],
              notes: 'Fails for the reported reason (empty-cart dereference).',
            },
          },
          { taskSourceProviders: [source] },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        // The pipeline is the SEEDED built-in (auto-seeded into every workspace), attached to a
        // schedule with its issue-intake config — exactly how a real deployment runs it.
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: BUG_TRIAGE_PIPELINE_ID,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash', labels: ['bug'] },
            },
          },
        )
        expect(created.status).toBe(201)
        const blockId = created.body.blockId

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        const run = (await app.drive(wsId)).find((e) => e.blockId === blockId)
        // The full pipeline reached an auto-merge (confidence 1) — `done`, every step finished.
        expect(run?.status).toBe('done')
        const step = (kind: string) => run?.steps.find((s) => s.agentKind === kind)
        expect(step('bug-intake')?.output).toContain('99')
        expect(step('bug-intake')?.skipped).toBeFalsy()
        // Investigation was `clear`, so the clarity gate auto-passed (no park, run stayed running).
        expect((step('bug-investigator')?.custom as { clarity?: string })?.clarity).toBe('clear')
        expect(step('clarity-review')?.state).toBe('done')
        // The reproduction reproduced and the coder fixed it — both ran, neither blocked the run.
        expect((step('repro-test')?.custom as { outcome?: string })?.outcome).toBe('reproduced')
        expect(step('coder')?.state).toBe('done')
        expect(step('reviewer')?.state).toBe('done')
        expect(step('merger')?.state).toBe('done')
        // The reused block was reseeded from the picked issue and finalized `done`.
        const block = await app.blockRepository().get(wsId, blockId)
        expect(block?.status).toBe('done')
        expect(block?.title).toContain('Checkout crashes on empty cart')
      })

      it('persists an on-demand schedule (no cadence) and fires it via run-now', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'On-demand inline',
          agentKinds: ['architect'],
        })
        // No `recurrence` on the body — an on-demand schedule needs none.
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Manual pass',
            onDemand: true,
          },
        )
        expect(created.status).toBe(201)
        expect(created.body.onDemand).toBe(true)

        // The flag round-trips through the store on both runtimes.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(
          snapshot.body.recurringPipelines?.find((s) => s.id === created.body.id)?.onDemand,
        ).toBe(true)

        // Manual run-now still fires it (the credential gate is a no-op with no individual model).
        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)
        const runs = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(runs.body).toHaveLength(1)
        expect(runs.body[0]!.executionId).toBeTruthy()
      })

      it('reads and writes the workspace tracker selection', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const initial = await app.call<TrackerSettings>(
          'GET',
          `/workspaces/${wsId}/tracker-settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.tracker).toBeNull()

        const put = await app.call<TrackerSettings>('PUT', `/workspaces/${wsId}/tracker-settings`, {
          tracker: 'jira',
          jiraProjectKey: 'ENG',
          writebackCommentOnPrOpen: true,
          writebackResolveOnMerge: true,
        })
        expect(put.body.tracker).toBe('jira')
        expect(put.body.jiraProjectKey).toBe('ENG')
        // Writeback flags round-trip identically across both stores.
        expect(put.body.writebackCommentOnPrOpen).toBe(true)
        expect(put.body.writebackResolveOnMerge).toBe(true)

        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snapshot.body.trackerSettings?.tracker).toBe('jira')
        expect(snapshot.body.trackerSettings?.writebackResolveOnMerge).toBe(true)

        // Switching to Linear persists the team id (the one tracker-settings column the
        // Linear support adds) and clears the Jira project key — identical on both stores.
        const linear = await app.call<TrackerSettings>(
          'PUT',
          `/workspaces/${wsId}/tracker-settings`,
          { tracker: 'linear', linearTeamId: 'team_abc123' },
        )
        expect(linear.body.tracker).toBe('linear')
        expect(linear.body.linearTeamId).toBe('team_abc123')
        expect(linear.body.jiraProjectKey).toBeNull()
        const linearSnapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(linearSnapshot.body.trackerSettings?.tracker).toBe('linear')
        expect(linearSnapshot.body.trackerSettings?.linearTeamId).toBe('team_abc123')
      })

      it('round-trips the per-task writeback overrides on a block', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Task with writeback overrides',
        })

        const patched = await app.call<Block>(
          'PATCH',
          `/workspaces/${wsId}/blocks/${task.body.id}`,
          { trackerCommentOnPrOpen: 'on', trackerResolveOnMerge: 'off' },
        )
        expect(patched.body.trackerCommentOnPrOpen).toBe('on')
        expect(patched.body.trackerResolveOnMerge).toBe('off')

        // The overrides survive a snapshot round-trip identically across both stores.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const stored = snapshot.body.blocks.find((b) => b.id === task.body.id)!
        expect(stored.trackerCommentOnPrOpen).toBe('on')
        expect(stored.trackerResolveOnMerge).toBe('off')

        // Clearing an override (back to inheriting the workspace setting) drops the field.
        const cleared = await app.call<Block>(
          'PATCH',
          `/workspaces/${wsId}/blocks/${task.body.id}`,
          { trackerCommentOnPrOpen: null },
        )
        expect(cleared.body.trackerCommentOnPrOpen ?? null).toBeNull()
        expect(cleared.body.trackerResolveOnMerge).toBe('off')
      })
    })

    describe('pipeline purpose classifier', () => {
      it('persists a custom pipeline’s purpose and seeds the built-ins with theirs', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A custom pipeline created WITH a purpose round-trips through the store on every runtime
        // (the new `purpose` column, mirrored D1 ⇄ Drizzle) — read back via the list endpoint.
        const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Doc authoring',
          agentKinds: ['doc-writer'],
          purpose: 'document',
        })
        expect(created.body.purpose).toBe('document')

        const listed = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        expect(listed.body.find((p) => p.id === created.body.id)?.purpose).toBe('document')
        // The seeded built-ins carry the purpose stamped in `seedPipelines()`: the document
        // pipeline is `document`, a full build is `build` — so the pickers can filter on it.
        expect(listed.body.find((p) => p.id === 'pl_document')?.purpose).toBe('document')
        expect(listed.body.find((p) => p.id === 'pl_full')?.purpose).toBe('build')
      })
    })

    // The `bug-investigator` is a structured `container-explore` kind whose `clarity`/`questions`
    // drive the downstream `clarity-review` gate (phase F): `clear` auto-passes with no human
    // park; `needs_clarification` seeds one finding per question and parks the run for a human.
    // The seed is DETERMINISTIC — no reviewer model — so the gate behaves identically on every
    // runtime (conformance wires no reviewer model), which is exactly what these assert.
    describe('bug-triage investigation + clarification (phase F)', () => {
      type SeededReview = {
        id: string
        status: string
        items: { id: string; status: string; detail: string }[]
      }
      const investigatorResult = (over: Record<string, unknown>): Record<string, unknown> => ({
        clarity: 'clear',
        summary: 'The submit handler swallows the validation error.',
        rootCauseHypotheses: ['Unhandled promise rejection in onSubmit'],
        affectedRepos: [],
        suggestedReproductions: ['Submit the form with an empty email'],
        questions: [],
        ...over,
      })

      it('auto-passes the clarity gate when the investigator reports the report is clear', async () => {
        const app = harness.makeApp({ customResult: investigatorResult({ clarity: 'clear' }) })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Triage & investigate',
          agentKinds: ['bug-investigator', 'clarity-review', 'architect'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        // Clear ⇒ no park: the run drives straight through the clarity gate to the architect.
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).toBe('done')

        // The investigator recorded its structured triage on `step.custom`, and the
        // post-completion resolver rendered a prose digest onto `step.output` (what the
        // downstream `priorOutputs` carries).
        const investigator = exec.steps.find((s) => s.agentKind === 'bug-investigator')!
        expect((investigator.custom as { clarity?: string } | undefined)?.clarity).toBe('clear')
        expect(investigator.output).toContain('Investigation summary')
        expect(investigator.output).toContain('swallows the validation error')

        // The clarity review auto-passed (settled `incorporated`, no findings, no model).
        const review = await app.call<SeededReview | null>(
          'GET',
          `/workspaces/${wsId}/blocks/task_login/clarity-review`,
        )
        expect(review.body?.status).toBe('incorporated')
        expect(review.body?.items ?? []).toHaveLength(0)
      })

      it('parks the clarity gate for a human on needs_clarification, then resumes on proceed', async () => {
        const app = harness.makeApp({
          customResult: investigatorResult({
            clarity: 'needs_clarification',
            questions: ['What are the exact reproduction steps?', 'Which browser and version?'],
          }),
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Triage & investigate',
          agentKinds: ['bug-investigator', 'clarity-review', 'architect'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })

        // needs_clarification ⇒ the gate seeds one finding per question and PARKS the run.
        let exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe(
          'waiting_decision',
        )
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).not.toBe('done')

        // The seeded review carries one OPEN finding per investigator question — no LLM ran.
        const review = await app.call<SeededReview | null>(
          'GET',
          `/workspaces/${wsId}/blocks/task_login/clarity-review`,
        )
        expect(review.body?.status).toBe('ready')
        const items = review.body?.items ?? []
        expect(items).toHaveLength(2)
        expect(items.every((i) => i.status === 'open')).toBe(true)
        expect(items.map((i) => i.detail)).toContain('Which browser and version?')

        // Resume: dismiss both questions, then proceed — advancing the parked run (no model).
        for (const item of items) {
          const dismissed = await app.call(
            'PATCH',
            `/workspaces/${wsId}/clarity-reviews/${review.body!.id}/items/${item.id}`,
            { status: 'dismissed' },
          )
          expect(dismissed.status).toBe(200)
        }
        const proceeded = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/clarity-review/proceed`,
        )
        expect(proceeded.status).toBe(200)

        exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).toBe('done')
      })
    })

    // The `repro-test` is a structured `container-coding` kind (phase G): it writes a failing
    // reproduction test (or concedes `not_reproducible`) and returns a `{ outcome, testPaths,
    // notes }` assessment. A concede NEVER fails the run — a post-completion resolver folds the
    // outcome into `step.output` and the run advances to the coder either way. These assert both
    // the reproduced and the conceded path reach the coder identically on every runtime.
    describe('bug-triage reproduction (phase G)', () => {
      const runRepro = async (
        outcome: 'reproduced' | 'not_reproducible',
        customResult: Record<string, unknown>,
      ): Promise<ExecutionInstance> => {
        const app = harness.makeApp({ customResult })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: `Reproduce & fix (${outcome})`,
          agentKinds: ['repro-test', 'coder'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      }

      it('records a reproduced outcome, then advances to the coder', async () => {
        const exec = await runRepro('reproduced', {
          outcome: 'reproduced',
          testPaths: ['test/submit.test.ts'],
          notes: 'Fails for the reported reason (unhandled rejection).',
        })
        expect(exec.status).toBe('done')

        const repro = exec.steps.find((s) => s.agentKind === 'repro-test')!
        expect(repro.state).toBe('done')
        // The structured outcome is kept on `step.custom` for the generic-structured view.
        expect((repro.custom as { outcome?: string } | undefined)?.outcome).toBe('reproduced')
        // The post-completion resolver rendered a prose digest onto `step.output`.
        expect(repro.output).toContain('Reproduction test')
        expect(repro.output).toContain('Reproduced')
        expect(repro.output).toContain('`test/submit.test.ts`')

        // The coder ran after the reproduction step — a repro-test never blocks the run.
        expect(exec.steps.find((s) => s.agentKind === 'coder')?.state).toBe('done')
      })

      it('concedes not_reproducible without failing the run, still reaching the coder', async () => {
        const exec = await runRepro('not_reproducible', {
          outcome: 'not_reproducible',
          testPaths: [],
          notes: 'Needs production data to trigger; could not reproduce locally.',
        })
        // Conceding is a SUCCESSFUL run (only infra/eviction fails a repro-test).
        expect(exec.status).toBe('done')

        const repro = exec.steps.find((s) => s.agentKind === 'repro-test')!
        expect(repro.state).toBe('done')
        expect((repro.custom as { outcome?: string } | undefined)?.outcome).toBe('not_reproducible')
        expect(repro.output).toContain('Not reproducible')
        expect(repro.output).toContain('Needs production data')

        // The coder still runs — a conceded reproduction does not stop the pipeline.
        expect(exec.steps.find((s) => s.agentKind === 'coder')?.state).toBe('done')
      })
    })

    // Slack is an extra notification transport; both facades wire the same module +
    // channel. These assert the per-workspace routing and the per-account member map
    // persist + read back identically on each store (the persistence-parity concern).
    // Connecting a workspace (auth.test / OAuth) needs real Slack network, so it is
    // exercised by the integration package's unit tests, not here.
    describe('slack', () => {
      it('round-trips per-workspace notification routing', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A workspace that never configured Slack reads back the (no-op) defaults.
        const initial = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.mentionsEnabled).toBe(false)

        const put = await app.call<SlackNotificationSettings>(
          'PUT',
          `/workspaces/${wsId}/slack/settings`,
          {
            routes: { merge_review: { enabled: true, channel: '#releases' } },
            mentionsEnabled: true,
          },
        )
        expect(put.status).toBe(200)
        expect(put.body.routes.merge_review).toEqual({ enabled: true, channel: '#releases' })
        expect(put.body.mentionsEnabled).toBe(true)

        const after = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(after.body.routes.merge_review?.channel).toBe('#releases')
        expect(after.body.mentionsEnabled).toBe(true)
      })

      it('round-trips the per-account member mapping (de-duped by github user id)', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const empty = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        const put = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'PUT',
          `/workspaces/${wsId}/slack/member-mapping`,
          {
            entries: [
              { userId: 'usr_1', slackUserId: 'U1', role: 'engineering' },
              { userId: 'usr_1', slackUserId: 'U1b', role: 'product' },
              { userId: 'usr_2', slackUserId: 'U2', role: 'product' },
            ],
          },
        )
        expect(put.status).toBe(200)
        // De-duped by user id (last write wins): 2 entries, not 3.
        expect(put.body.entries).toHaveLength(2)
        expect(put.body.entries.find((e) => e.userId === 'usr_1')?.slackUserId).toBe('U1b')

        const after = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(after.body.entries).toHaveLength(2)
        // The notification role round-trips on both stores (drives @-mention audience).
        expect(after.body.entries.find((e) => e.userId === 'usr_1')?.role).toBe('product')
        expect(after.body.entries.find((e) => e.userId === 'usr_2')?.role).toBe('product')
      })
    })

    // The user-identity + onboarding layer (users / user_identities / invitations).
    // Driven through the facade's real services + store so a repository that maps a
    // column differently, or a facade that forgot to wire the identity layer, fails the
    // same assertion on every runtime. A unique email suffix keeps the persisted store
    // (shared across a file's tests) collision-free.
    describe('identity & onboarding', () => {
      const uniqueEmail = (local: string) => `${local}-${crypto.randomUUID()}@conformance.test`

      it('creates a user on first identity sight and is idempotent on (provider, subject)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('gh')
        const subject = uniqueEmail('sub-gh')
        const first = await ob.users.findOrCreateByIdentity('github', subject, {
          name: 'Octo Cat',
          email,
          emailVerified: true,
        })
        expect(first.id).toMatch(/^usr_/)
        expect(first.email).toBe(email.toLowerCase())

        // A repeat login for the same (provider, subject) returns the SAME user.
        const again = await ob.users.findOrCreateByIdentity('github', subject, { email })
        expect(again.id).toBe(first.id)
        expect((await ob.users.findByIdentity('github', subject))?.id).toBe(first.id)
        expect((await ob.users.get(first.id))?.id).toBe(first.id)
        const identities = await ob.users.listIdentities(first.id)
        expect(identities.some((i) => i.provider === 'github')).toBe(true)
      })

      it('links a second VERIFIED-email provider onto the same user (no email collision)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('shared')
        const viaGithub = await ob.users.findOrCreateByIdentity('github', uniqueEmail('s-gh'), {
          email,
          emailVerified: true,
        })
        const viaGoogle = await ob.users.findOrCreateByIdentity('google', uniqueEmail('s-goog'), {
          email,
          emailVerified: true,
        })
        // Same person, two logins — NOT a duplicate user / unique-index collision.
        expect(viaGoogle.id).toBe(viaGithub.id)
        const identities = await ob.users.listIdentities(viaGithub.id)
        expect(identities.map((i) => i.provider).sort()).toEqual(['github', 'google'])
      })

      it('does NOT merge accounts on an UNVERIFIED same-email login', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('unver')
        const verified = await ob.users.findOrCreateByIdentity('github', uniqueEmail('u-gh'), {
          email,
          emailVerified: true,
        })
        const unverified = await ob.users.findOrCreateByIdentity('google', uniqueEmail('u-goog'), {
          email,
          emailVerified: false,
        })
        // An unverified email is never trusted to claim the existing user — the second
        // identity creates a distinct user (its own email stays null to avoid the index).
        expect(unverified.id).not.toBe(verified.id)
        expect(unverified.email).toBeNull()
      })

      it('does NOT merge a verified login onto a password-squatted email (pre-hijack guard)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('squat')
        // A password signup self-asserts the email without proving ownership.
        const squatter = await ob.users.signupWithPassword({ email, password: 'squatter pass' })
        // A genuinely-verified OAuth login for the same address must NOT land on the
        // squatter's account — it takes the email onto a fresh, distinct user.
        const victim = await ob.users.findOrCreateByIdentity('google', uniqueEmail('victim'), {
          email,
          emailVerified: true,
        })
        expect(victim.id).not.toBe(squatter.id)
        expect(victim.email).toBe(email.toLowerCase())
        // The email is released from the squatting, password-only account.
        expect((await ob.users.get(squatter.id))?.email).toBeNull()
      })

      it('signs up + verifies a password user, and rejects duplicate email / bad password', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('pw')
        const user = await ob.users.signupWithPassword({
          email,
          password: 'correct horse battery',
          name: 'PW User',
        })
        expect(user.id).toMatch(/^usr_/)

        // Right password verifies to the same user; wrong password + unknown email → null.
        const ok = await ob.users.verifyPassword({ email, password: 'correct horse battery' })
        expect(ok?.id).toBe(user.id)
        expect(await ob.users.verifyPassword({ email, password: 'wrong' })).toBeNull()
        expect(
          await ob.users.verifyPassword({ email: uniqueEmail('nope'), password: 'whatever' }),
        ).toBeNull()

        // A second signup for the same email is refused (no duplicate / takeover).
        await expect(
          ob.users.signupWithPassword({ email, password: 'another password' }),
        ).rejects.toMatchObject({ name: 'ConflictError' })
      })

      it('lists every account a user can switch between (batched multi-membership resolve)', async () => {
        const ob = harness.makeApp().onboarding()
        // An org owner belongs to BOTH the org and their auto-seeded personal account, so the
        // switcher list resolves more than one membership's account in a single batched read —
        // which must map identically on every store.
        const org = await ob.makeOrgOwner('Switcher Org')
        const accounts = await ob.accountsForUser({
          id: org.ownerUserId,
          login: 'switcher-owner',
          name: 'Switcher Owner',
        })
        expect(accounts.some((a) => a.id === org.accountId && a.type === 'org')).toBe(true)
        expect(accounts.some((a) => a.type === 'personal')).toBe(true)
        // Personal account is listed first (the stable switcher order).
        expect(accounts[0]?.type).toBe('personal')
        // Every listed account carries the caller's role(s) — proving the membership join, not
        // just the id resolve, survives the batched read.
        expect(accounts.every((a) => a.roles.length > 0)).toBe(true)
      })

      it('resolves ONE personal account under concurrent first sign-in (no duplicate-key race)', async () => {
        const ob = harness.makeApp().onboarding()
        // The personal-account owner must be a real users row first — the
        // `accounts.owner_user_id → users(id)` foreign key rejects an account for a
        // nonexistent user. `findOrCreateByIdentity` creates only the user + identity (no
        // account), so the first-sign-in race on ensurePersonalAccount below is unchanged.
        const owner = await ob.users.findOrCreateByIdentity(
          'github',
          `race_${crypto.randomUUID()}`,
          {
            name: 'Race Owner',
          },
        )
        const user = { id: owner.id, login: 'race-owner', name: 'Race Owner' }
        // Fire the first-load resolution many times at once: each runs ensurePersonalAccount
        // before any INSERT commits, so a check-then-create would race to a duplicate-key 500
        // on the personal-account unique index. The atomic get-or-create must instead converge
        // every caller on the same single account, with no rejection.
        const ids = await ob.concurrentPersonalAccounts(user, 8)
        expect(ids).toHaveLength(8)
        expect(new Set(ids).size).toBe(1)
        // And a follow-up read returns that same one account — no orphan duplicates were left.
        const after = await ob.accountsForUser(user)
        const personal = after.filter((a) => a.type === 'personal')
        expect(personal).toHaveLength(1)
        expect(personal[0]?.id).toBe(ids[0])
      })

      it('invites + redeems org membership bound to the invited email', async () => {
        const app = harness.makeApp()
        const ob = app.onboarding()
        if (!ob.invitations) return // facade without the invitation repository wired
        const invitations = ob.invitations
        const org = await ob.makeOrgOwner('Conformance Org')

        const inviteeEmail = uniqueEmail('invitee')
        const invitee = await ob.users.findOrCreateByIdentity('google', uniqueEmail('inv-goog'), {
          email: inviteeEmail,
          emailVerified: true,
        })
        const created = await invitations.invite(org.accountId, org.ownerUserId, inviteeEmail)
        const peeked = await invitations.peek(created.token)
        expect(peeked?.accountId).toBe(org.accountId)
        expect(peeked?.email).toBe(inviteeEmail.toLowerCase())

        // A mismatched email cannot redeem the invite (leaked-link / allowlist-bypass guard).
        await expect(
          invitations.accept(created.token, invitee.id, 'someone-else@conformance.test'),
        ).rejects.toMatchObject({ name: 'ConflictError' })

        // The intended invitee redeems and gains membership.
        const accountId = await invitations.accept(created.token, invitee.id, inviteeEmail)
        expect(accountId).toBe(org.accountId)
        const members = await ob.members(org.accountId)
        expect(members.some((m) => m.userId === invitee.id)).toBe(true)
      })
    })
  })
}

// The aggregate the Cloudflare Worker runs (one file → one D1, `singleWorker`): every
// group, each self-wrapping in its own `[name] conformance` describe block. The Postgres
// runtimes instead call the individual group functions from separate spec files so they
// parallelise across vitest workers.
