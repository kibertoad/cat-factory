import {
  type Block,
  type ExecutionInstance,
  type ForkDecisionStepState,
  InitiativePresetRegistry,
  type Pipeline,
  type RequirementReview,
  type RiskPolicy,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { spawnedInitiative } from './shared.js'

// Execution-engine conformance, slice 2: spec-increment ingest, requirements/clarity
// substitution, initiative-preset steering, run restart, the implementation-fork decision loop,
// and the producer/companion review gates. Re-opens the same `execution engine` describe group.
export function defineExecutionReviewConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    it('applies the task as a spec increment and ingests the spec-writer document', async () => {
      // The spec-writer step runs on the implementation branch BEFORE the coder,
      // applying ONLY this task's requirements as an increment onto the baseline spec
      // (no cross-task aggregation — an unmerged sibling task is invisible). Driving it
      // identically on both runtimes pins the strict ingest + artifact handoff so they
      // can't drift.
      const spec = {
        service: 'Auth',
        summary: 'Authentication service',
        modules: [
          {
            name: 'Access',
            summary: 'User access',
            groups: [
              {
                name: 'Login',
                requirements: [
                  {
                    id: 'req-login',
                    title: 'Login',
                    statement: 'The system SHALL let a user log in.',
                    kind: 'functional',
                    priority: 'must',
                    acceptance: [
                      {
                        id: 'ac-1',
                        given: 'a registered user',
                        when: 'they sign in',
                        outcome: 'a session starts',
                      },
                    ],
                  },
                ],
                rules: [],
              },
            ],
          },
        ],
      }
      const app = harness.makeApp({ spec })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Requirements only',
        agentKinds: ['spec-writer'],
      })
      expect(pipeline.status).toBe(201)

      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'spec-writer')!
      expect(step.state).toBe('done')
      // The doc parsed + ingested cleanly, and the engine replaced the step's
      // reviewable output (the raw container transcript summary) with a rendering of
      // the SPEC ITSELF — the universal artifact-review handoff a companion grades.
      // Pinned on both runtimes so a facade can't drift back to surfacing the
      // transcript (which made the spec-companion loop on an "unreviewable" artifact).
      expect(step.output).not.toContain('[spec-writer]')
      expect(step.output).toContain('# Specification: Auth')
      expect(step.output).toContain('The system SHALL let a user log in.')
      expect(step.output).toContain(
        'GIVEN a registered user WHEN they sign in THEN a session starts',
      )
    })

    it('skips a disabled step at run start but keeps it in the saved pipeline', async () => {
      // A step the pipeline marks `enabled[i] === false` is kept in the saved
      // pipeline (so it can be toggled back on) but skipped when the run is built —
      // the execution instance contains only the enabled steps. Disabling the FIRST
      // step also exercises "the first SURVIVING step starts working". Driven on both
      // runtimes so the skip can't drift between the facades.
      const app = harness.makeApp({ confidence: 1 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Docs (researcher disabled)',
        agentKinds: ['researcher', 'documenter', 'integrator'],
        enabled: [false, true, true],
      })
      expect(pipeline.status).toBe(201)
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      // The disabled researcher never ran — the run is built only from the enabled
      // steps — while the saved pipeline still carries all three.
      expect(exec.steps.map((s) => s.agentKind)).toEqual(['documenter', 'integrator'])
      const saved = (await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)).body.find(
        (p) => p.id === pipeline.body.id,
      )!
      expect(saved.agentKinds).toEqual(['researcher', 'documenter', 'integrator'])
      expect(saved.enabled).toEqual([false, true, true])
    })

    it("substitutes a block's reworked requirements for its description in every step", async () => {
      // Once a task's requirements have been reworked ("incorporated"), that
      // standard-format document — not the raw description — is what every agent step
      // consumes. This must hold on EVERY runtime: the Cloudflare facade wires the D1
      // review store, the Node facade the Drizzle one, and both feed the engine through
      // the optional `requirementReviewRepository`. Asserting it here means a facade
      // that forgets to wire that store (the old Node gap) fails a shared test instead
      // of silently shipping divergent agent context.
      const REWORKED = '# Login — Requirements\n\nThe system SHALL keep sessions for 24h.'
      const app = harness.makeApp({ confidence: 1, echoDescription: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await app.seedIncorporatedReview(wsId, 'task_login', REWORKED)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const step = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(step.state).toBe('done')
      // The agent was handed the reworked document, not the seeded task's description.
      expect(step.output).toContain(`[desc]${REWORKED}[/desc]`)
    })

    it("substitutes a block's clarified bug report for its description in every step", async () => {
      // The clarity mirror of the requirements substitution above: once a bug task's
      // report has been triaged + clarified ("incorporated"), that clarified report — not
      // the raw description — is what every agent step consumes. This must hold on EVERY
      // runtime: the Cloudflare facade wires the D1 clarity store, the Node facade the
      // Drizzle one, both feeding the engine through the optional `clarityReviewRepository`.
      // A facade that forgets to wire that store fails this shared test.
      const CLARIFIED = '# Login — Bug Report\n\n## Steps to Reproduce\n1. POST /login twice.'
      const app = harness.makeApp({ confidence: 1, echoDescription: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await app.seedIncorporatedClarityReview(wsId, 'task_login', CLARIFIED)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const step = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(step.state).toBe('done')
      // The agent was handed the clarified report, not the seeded task's description.
      expect(step.output).toContain(`[desc]${CLARIFIED}[/desc]`)
    })

    it("folds an initiative preset's per-kind steering onto a spawned run's agent context", async () => {
      // D1: a task SPAWNED by an initiative (carrying `block.initiativeId`) must receive the
      // preset's standing per-kind methodology in its agent context on EVERY runtime — the
      // Cloudflare facade resolves it from the D1 initiative store, Node/local from Drizzle,
      // both through the same `AgentContextBuilder`. A facade that failed to wire the initiative
      // store into the context builder would silently ship a bare child prompt. The preset is
      // registered on a fresh app-owned registry injected via `makeApp` — the DI seam that
      // replaced the old module-global registration.
      const ADDITION = 'Follow the org connector architecture and consume the build handoff.'
      const initiativePresetRegistry = new InitiativePresetRegistry()
      initiativePresetRegistry.register({
        descriptor: {
          id: 'preset_spawned_conf',
          presentation: {
            label: 'Connector factory',
            icon: 'i',
            color: '#000',
            description: 'x',
          },
          fields: [],
          planningPipelineId: 'pl_initiative',
          interview: 'full',
          humanReviewDefault: true,
          defaultFragmentIds: [],
        },
        promptAdditions: { coder: ADDITION },
      })
      const app = harness.makeApp({ confidence: 1, echoPreset: true }, { initiativePresetRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Seed the initiative entity anchored to an initiative block id, then link the seeded
      // task to it (an epic-style `initiativeId` membership — exactly what the loop's
      // `buildTaskBlock` stamps on a spawned child).
      const anchorBlockId = 'init_anchor'
      await app.initiativeRepository().insert(wsId, spawnedInitiative(anchorBlockId))
      await app.blockRepository().update(wsId, 'task_login', { initiativeId: anchorBlockId })

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const step = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(step.state).toBe('done')
      // The coder was handed the preset label + its `coder` promptAddition (and nothing else —
      // no goal/qa bleeds onto a spawned run).
      expect(step.output).toContain(`[preset]Connector factory|${ADDITION}[/preset]`)
    })

    it('serves an injected custom preset descriptor in the snapshot + accepts create-with-preset', async () => {
      // D5: the app-owned initiative-preset registry the facade injects surfaces the custom
      // preset in the workspace snapshot's `initiativePresets` (the SPA picker) AND is accepted
      // by create-initiative — identically on every runtime, replacing the module-global registry.
      const CUSTOM_ID = 'preset_conf_custom'
      const initiativePresetRegistry = new InitiativePresetRegistry()
      initiativePresetRegistry.register({
        descriptor: {
          id: CUSTOM_ID,
          presentation: {
            label: 'Conformance custom',
            icon: 'i-lucide-x',
            color: '#123456',
            description: 'A conformance-injected custom preset.',
          },
          fields: [{ key: 'toolName', label: 'Tool', type: 'text', required: true }],
          planningPipelineId: 'pl_initiative',
          interview: 'full',
          humanReviewDefault: true,
          defaultFragmentIds: [],
        },
      })
      const app = harness.makeApp({ confidence: 1 }, { initiativePresetRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // The snapshot carries the injected descriptor (+ the built-in generic, always resolvable).
      const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const presetIds = (snapshot.body.initiativePresets ?? []).map((p) => p.id)
      expect(presetIds).toContain(CUSTOM_ID)
      expect(presetIds).toContain('preset_generic')

      // Create an initiative on the seeded service frame naming the injected preset — it is
      // accepted (an unknown preset id would be a create-time ValidationError). Anchor it to a
      // SEEDED service frame (`blk_auth`) rather than minting one over `POST /blocks`: raw
      // service-frame creation is deliberately off the mothership-mode SPA path (the mothership
      // persistence RPC does not proxy `serviceRepository.insert`), so a seeded frame keeps this
      // assertion — about preset acceptance, not frame creation — identical on every runtime.
      const created = await app.call('POST', `/workspaces/${wsId}/initiatives`, {
        frameId: 'blk_auth',
        title: 'Custom-preset initiative',
        presetId: CUSTOM_ID,
        presetInputs: { toolName: 'acme' },
      })
      expect(created.status).toBe(201)
    })

    it('restarts a run from a chosen step, preserving prior outputs and the block requirements', async () => {
      // "Restart from this step" re-runs the pipeline from a human-chosen step
      // (even on a finished run), keeping the earlier steps' outputs as handoff
      // context and resetting that step + every later one. The requirements a
      // restarted step receives must survive the restart: they live on the
      // requirement-review record, not the run, so a restarted spec-writer/coder
      // still reads the incorporated document. Driving it on BOTH runtimes pins the
      // restart endpoint + the handoff so neither facade can drift.
      const REWORKED = '# Login — Requirements\n\nSessions SHALL persist for 24h.'
      const app = harness.makeApp({ confidence: 1, echoDescription: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      await app.seedIncorporatedReview(wsId, 'task_login', REWORKED)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Spec then code',
        agentKinds: ['spec-writer', 'coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const firstRun = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(firstRun.status).toBe('done')
      expect(firstRun.steps.map((s) => s.state)).toEqual(['done', 'done'])
      const originalSpec = firstRun.steps[0]!.output
      expect(originalSpec).toContain('[spec-writer]')
      const originalCoder = firstRun.steps[1]!.output
      expect(originalCoder).toBeTruthy()

      // Restart from the LAST step (coder). The earlier spec-writer is preserved
      // untouched; the coder is reset to re-run. A fresh run id is minted and the
      // response comes back already running on the chosen step.
      const restarted = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/executions/${firstRun.id}/restart`,
        { fromStepIndex: 1 },
      )
      expect(restarted.status).toBe(200)
      expect(restarted.body.id).not.toBe(firstRun.id)
      expect(restarted.body.status).toBe('running')
      expect(restarted.body.currentStep).toBe(1)
      // Step 0 is preserved verbatim (output + done state are the handoff context).
      expect(restarted.body.steps[0]!.state).toBe('done')
      expect(restarted.body.steps[0]!.output).toBe(originalSpec)
      // Step 1 was reset (no stale output; re-running, not done).
      expect(restarted.body.steps[1]!.state).not.toBe('done')
      expect(restarted.body.steps[1]!.output).toBeFalsy()
      // The restart DISCARDED the coder's completed output; rather than losing it, the run
      // records it in an output history attributed to that step — so the step-detail
      // execution history can surface superseded SUCCESSFUL outputs, not only failures.
      expect(restarted.body.outputHistory).toEqual([
        expect.objectContaining({ stepIndex: 1, output: originalCoder }),
      ])

      const afterCoder = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(afterCoder.status).toBe('done')
      expect(afterCoder.id).toBe(restarted.body.id)
      // The restarted coder still received the block's incorporated requirements —
      // not the raw description — proving the restart preserved the requirements handoff.
      expect(afterCoder.steps[1]!.output).toContain(`[desc]${REWORKED}[/desc]`)

      // Restarting from step 0 re-runs the spec-writer itself, which must ALSO still
      // receive the incorporated requirements (the explicit spec-writer guarantee).
      const restartedHead = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/executions/${afterCoder.id}/restart`,
        { fromStepIndex: 0 },
      )
      expect(restartedHead.status).toBe(200)
      expect(restartedHead.body.currentStep).toBe(0)
      expect(restartedHead.body.steps.every((s) => s.state !== 'done')).toBe(true)

      const afterHead = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(afterHead.status).toBe('done')
      expect(afterHead.steps[0]!.output).toContain(`[desc]${REWORKED}[/desc]`)
      // The successful-output trail accumulates across restarts and round-trips through the
      // facade's persistence (it rides the run's `detail` JSON like the failure trail): the
      // first restart discarded the coder (step 1); the head restart then discarded the re-run
      // spec-writer (step 0) + coder (step 1) — each attributed to the step that produced it.
      expect(afterHead.outputHistory?.map((o) => o.stepIndex)).toEqual([1, 0, 1])
      expect(
        afterHead.outputHistory?.some((o) => o.stepIndex === 0 && o.output === originalSpec),
      ).toBe(true)

      // An out-of-range step index is rejected (422) rather than stranding the run.
      const bad = await app.call('POST', `/workspaces/${wsId}/executions/${afterHead.id}/restart`, {
        fromStepIndex: 9,
      })
      expect(bad.status).toBe(422)
    })

    it('wires the requirements-review re-review endpoint and rejects it out of order', async () => {
      // The dedicated review window resumes a parked run through bespoke endpoints
      // (re-review / proceed / resolve-exceeded) routed via the execution service. They
      // must be mounted on EVERY facade. A re-review is only valid once an incorporation
      // has produced a document (status `merged`); on a settled (`incorporated`) review
      // the guard rejects it with 409 BEFORE any model call — so this is deterministic
      // (no live reviewer) yet proves the route is wired and the guard holds identically.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.seedIncorporatedReview(wsId, 'task_login', '# Login — Requirements')

      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/requirement-review/re-review`,
      )
      expect(res.status).toBe(409)
    })

    it('wires the async-incorporate endpoint and refuses it while a finding is open', async () => {
      // Incorporation is asynchronous: the route records the human's intent on the parked
      // run and signals the durable driver to fold + re-review in the background. Its
      // pre-LLM guard — every finding must be answered or dismissed first — must hold on
      // EVERY facade and fires BEFORE any model call or run signal, so this is
      // deterministic (no live reviewer) yet proves the route is mounted identically and
      // the guard rejects an out-of-order incorporate. A `ready` review with one still-open
      // finding is seeded straight into each facade's real review store.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.seedReadyReview(wsId, 'task_login')

      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/requirement-review/incorporate`,
        {},
      )
      // The unanswered finding fails the guard (a `validation` domain error → 422) before
      // any model call or run signal — identically on both facades.
      expect(res.status).toBe(422)
    })

    // ---- Implementation-fork decision phase (Coder step) ----------------
    // The optional fork-decision phase surfaces materially different implementation
    // approaches before the Coder writes code and parks for a human choice. It rides the
    // coder step's `forkDecision` state (no side table), so the propose→park→choose→coder
    // loop, the single-path auto-advance, and the default pass-through must all behave
    // identically on every facade. The read-only `fork-proposer` is a structured kind, so
    // the shared fake returns `customResult` as its proposal — no real container needed.

    it('passes through (skips) the fork phase when the risk policy gate is off (the default)', async () => {
      // Tri-state `auto` + the built-in preset's DISABLED fork gating ⇒ never propose. The
      // Coder runs directly; the step records `skipped` and the run never parks. This is the
      // default every existing pipeline gets, so it must not regress.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Code only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.state).toBe('done')
      expect(coder.output).toContain('[coder]')
      expect(coder.forkDecision?.status).toBe('skipped')
    })

    it('proposes, parks, and re-runs the Coder with the chosen fork folded in', async () => {
      // Tri-state `always` forces the phase; the structured proposer returns two materially
      // different forks (via `customResult`), so the run PARKS. The human reads the forks and
      // chooses one; the Coder then dispatches (Phase B) and the run completes.
      const app = harness.makeApp({
        customResult: {
          seamSummary: 'the login mapper seam',
          forks: [
            {
              title: 'Patch the call site',
              summary: 'targeted fix',
              approach: 'edit AuthController directly',
              tradeoffs: ['fast', 'localized'],
              recommended: true,
            },
            {
              title: 'Refactor the seam',
              summary: 'introduce an abstraction',
              approach: 'extract a SessionGateway',
              tradeoffs: ['cleaner', 'wider blast radius'],
            },
          ],
          singlePath: false,
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Fork task',
        agentConfig: { 'coder.forkDecision': 'always' },
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Fork + code',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      // Drive to the park: the coder step waits on the human's fork choice.
      const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(parked.status).toBe('blocked')
      const parkedCoder = parked.steps.find((s) => s.agentKind === 'coder')!
      expect(parkedCoder.state).toBe('waiting_decision')
      expect(parkedCoder.forkDecision?.status).toBe('awaiting_choice')
      expect(parkedCoder.forkDecision?.forks).toHaveLength(2)

      // The GET route returns the same live state.
      const view = await app.call<ForkDecisionStepState | null>(
        'GET',
        `/workspaces/${wsId}/executions/${parked.id}/fork-decision`,
      )
      expect(view.status).toBe(200)
      expect(view.body?.status).toBe('awaiting_choice')
      const chosenId = view.body!.forks![0]!.id

      // Choose a proposed fork; the run re-arms and the Coder dispatches (Phase B).
      const choose = await app.call<ForkDecisionStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/fork-decision/choose`,
        { forkId: chosenId },
      )
      expect(choose.status).toBe(200)
      expect(choose.body.status).toBe('chosen')

      const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(done.status).toBe('done')
      const finalCoder = done.steps.find((s) => s.agentKind === 'coder')!
      expect(finalCoder.state).toBe('done')
      expect(finalCoder.forkDecision?.status).toBe('chosen')
      expect(finalCoder.forkDecision?.chosen?.forkId).toBe(chosenId)
    })

    it('auto-advances a single path without parking', async () => {
      // The proposer's escape hatch (`singlePath`) fires for a trivial/obvious task: no park,
      // the Coder dispatches directly, and the step records `single_path`.
      const app = harness.makeApp({
        customResult: {
          seamSummary: 'obvious one-liner',
          forks: [],
          singlePath: true,
          singlePathReason: 'Any competent engineer would implement it the same way.',
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Trivial fork task',
        agentConfig: { 'coder.forkDecision': 'always' },
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Fork + code (single path)',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(exec.status).toBe('done')
      const coder = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coder.state).toBe('done')
      expect(coder.forkDecision?.status).toBe('single_path')
    })

    it('mounts the fork chat endpoint and degrades it identically when no model can run', async () => {
      // A human can chat about the surfaced forks before deciding. The chat rides the coder
      // step (no side table), and the reply is computed by an inline model IN THE DURABLE
      // DRIVER. In the suite no chat model can actually run (Node's default ref resolves to an
      // unregistered provider; Cloudflare's resolves its Workers-AI binding but the call can't
      // run in tests), so the responder must DEGRADE GRACEFULLY and IDENTICALLY: the route is
      // mounted on every facade, the human turn is recorded + the run re-parks `awaiting_choice`
      // with a canned assistant reply, and pick / custom still work — the divergence the
      // cross-runtime suite guards.
      const app = harness.makeApp({
        customResult: {
          seamSummary: 'the login mapper seam',
          forks: [
            {
              title: 'Patch the call site',
              summary: 's',
              approach: 'a1',
              tradeoffs: ['fast'],
              recommended: true,
            },
            { title: 'Refactor the seam', summary: 's', approach: 'a2', tradeoffs: ['clean'] },
          ],
          singlePath: false,
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/mod_sessions/tasks`, {
        title: 'Fork chat task',
        agentConfig: { 'coder.forkDecision': 'always' },
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Fork chat + code',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(parked.status).toBe('blocked')

      // Send a chat message: the human turn is recorded immediately (status `answering`).
      const sent = await app.call<ForkDecisionStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/fork-decision/chat`,
        { text: 'Which is safer?' },
      )
      expect(sent.status).toBe(200)
      expect(sent.body.status).toBe('answering')
      expect(sent.body.chat?.filter((m) => m.role === 'human')).toHaveLength(1)

      // The durable driver re-enters, computes the (canned, no-model) reply, and re-parks.
      const answered = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(answered.status).toBe('blocked')
      const answeredCoder = answered.steps.find((s) => s.agentKind === 'coder')!
      expect(answeredCoder.forkDecision?.status).toBe('awaiting_choice')
      const answeredChat = answeredCoder.forkDecision?.chat ?? []
      expect(answeredChat.filter((m) => m.role === 'human')).toHaveLength(1)
      expect(answeredChat.filter((m) => m.role === 'assistant')).toHaveLength(1)

      // Choosing still works after the chat exchange: the Coder dispatches (Phase B).
      const chosenId = answeredCoder.forkDecision!.forks![0]!.id
      const choose = await app.call<ForkDecisionStepState>(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/fork-decision/choose`,
        { forkId: chosenId },
      )
      expect(choose.status).toBe(200)
      expect(choose.body.status).toBe('chosen')
      const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(done.status).toBe('done')
    })

    it('wires the async recommend endpoint and degrades it identically when the Writer cannot run', async () => {
      // Requesting Requirement-Writer recommendations appends `pending` placeholders and, on a
      // parked run, lets the durable driver fill them per finding; off-path (a `ready` review
      // seeded with no pipeline parked on it) the Writer runs inline. The route must be mounted
      // on EVERY facade and resolve through the same execution-service seam. In the suite no
      // reviewer model can actually run — Node's default ref resolves to an unregistered
      // provider, Cloudflare's resolves its Workers-AI binding but the call can't run in tests —
      // so the inline fill must DEGRADE GRACEFULLY and IDENTICALLY: drop the placeholder, reopen
      // the finding for manual answering, and return 200 with the review (NOT 500 on the runtime
      // whose resolve throws). The full happy-path Writer loop is covered by the orchestration
      // unit tests, which a fake model can drive.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await app.seedReadyReview(wsId, 'task_login')

      const res = await app.call<RequirementReview>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/requirement-review/recommend`,
        { items: [{ itemId: 'rri_seed_task_login' }] },
      )
      expect(res.status).toBe(200)
      // The Writer couldn't run, so no recommendation survives and the finding is back to `open`
      // for the human to answer by hand — the same end state on both runtimes.
      expect(res.body.recommendations).toEqual([])
      expect(res.body.items.find((i) => i.id === 'rri_seed_task_login')?.status).toBe('open')
    })

    it('passes a companion gate when the rating clears the threshold', async () => {
      // A companion step grades the prior producer; at/above its threshold the run
      // proceeds. `reviewer` is the coder's companion, so ['coder','reviewer'] runs the
      // coder then grades it — a passing rating (default 1) finishes the run.
      const app = harness.makeApp({ confidence: 1 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + companion',
        agentKinds: ['coder', 'reviewer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
      const verdict = companionStep.companion?.verdicts.at(-1)
      expect(verdict?.rating).toBe(1)
      expect(verdict?.passed).toBe(true)
    })

    it('always loops the producer on the FIRST batch when the review raised comments, even above threshold', async () => {
      // First review batch: ANY comments loop the producer back regardless of rating —
      // so the first round of findings is always handed to the implementer. The
      // threshold only governs the SECOND pass onward. A steady 0.85 (above the 0.8
      // bar) WITH comments therefore loops once, then passes the second grade.
      const app = harness.makeApp({ confidence: 1, companionRatings: [0.85, 0.85] })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + first-batch companion',
        agentKinds: ['coder', 'reviewer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
      // First batch failed despite clearing the threshold (forced loop), second passed.
      expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
      expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.85)).toBe(true)
      expect(companionStep.companion?.attempts).toBe(1)
    })

    it('fails the run when a companion verdict cannot be parsed (no silent 100% pass)', async () => {
      // The bug: a truncated/malformed reviewer reply was silently treated as a perfect
      // pass (rating 1 ≥ threshold) and the real review was dropped. Now an unparseable
      // verdict — even after the repair retry — fails the run for human attention.
      const app = harness.makeApp({ confidence: 1, companionMalformed: true })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + unparseable companion',
        agentKinds: ['coder', 'reviewer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(exec.failure?.kind).toBe('companion_rejected')
      // The RICH failure record survives the drive: the driver funnels the inline gate's
      // `job_failed` through the single `failRun` with the gate's own kind/message/detail,
      // and never re-fails the (already-failed) run with a generic record. Guards the
      // regression where a second `failRun` clobbered this with kind `job_failed`,
      // message "companion_rejected" and a misleading "container reported a failure" hint.
      expect(exec.failure?.message).toContain('did not return a parseable assessment')
      // The companion's raw (unparseable) reply is stored as the detail for triage —
      // the whole point of the failure, lost when the record was clobbered.
      expect(exec.failure?.detail).toContain('my reply got cut off')
      // The companion step was NOT marked done / passed off as a clean review.
      const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
      expect(companionStep.state).not.toBe('done')
    })

    it('classifies a container-start (dispatch) failure as `dispatch`, not a generic run failure', async () => {
      // When the container/runner never accepts the job (startJob throws), the engine
      // must classify it as a `dispatch` failure ("Container failed to start") and carry
      // the verbatim provider error as the detail — identically on both runtimes — rather
      // than a generic "Run failed" with a misleading "inspect the container logs" hint.
      const app = harness.makeApp({
        asyncKinds: ['coder'],
        dispatchThrowKinds: ['coder'],
        dispatchThrowMessage: 'Container dispatch failed (HTTP 503): no capacity',
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(exec.failure?.kind).toBe('dispatch')
      // The verbatim provider/runtime response is preserved as the detail for triage.
      expect(exec.failure?.detail).toContain('HTTP 503')
      // The step did not falsely complete; the container is surfaced as errored (the
      // details say the container failed to start, not a generic "run failed").
      const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coderStep.state).not.toBe('done')
      expect(coderStep.container?.status).toBe('errored')
    })

    it("maps a polled job's structured failureCause → AgentFailureKind and surfaces the detail", async () => {
      // The harness now reports a STRUCTURED `failureCause` (+ extended `detail`) on a failed
      // job view; the engine must classify the failure from it WITHOUT regex-matching the error
      // — a watchdog `inactivity-timeout` becomes `timeout`, and the harness detail is surfaced.
      // Asserted identically on both runtimes so a facade/transport that drops the cause (the
      // way the Node pool transport once did) fails here instead of silently degrading to `agent`.
      const app = harness.makeApp({
        asyncKinds: ['coder'],
        pollFailKinds: ['coder'],
        pollFailCause: 'inactivity-timeout',
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build only',
        agentKinds: ['coder'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      // The watchdog cause classifies as `timeout`, not the generic `agent`.
      expect(exec.failure?.kind).toBe('timeout')
      // The harness's extended diagnostic is surfaced as the failure detail.
      expect(exec.failure?.detail).toContain('Phase timings')
      // The step's container is surfaced as errored (the run details show the container
      // faulted), persisted before the failure funnels through `failRun`.
      const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
      expect(coderStep.container?.status).toBe('errored')
    })

    it('routes a merger PR to human review when the assessment is unexplained (empty rationale)', async () => {
      // Engine guard: auto-merge only on a CREDIBLE within-threshold assessment. Scores
      // within every ceiling but an EMPTY rationale (the shape a merger that failed to
      // examine the diff degrades to) must NOT silently merge — it routes to merge_review
      // and the task is left pr_ready, never `done`.
      const app = harness.makeApp({
        confidence: 1,
        mergeAssessment: { complexity: 0, risk: 0, impact: 0, rationale: '' },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merger',
        agentKinds: ['coder', 'merger'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const task = snap.blocks.find((b) => b.id === 'task_login')!
      expect(task.status).toBe('pr_ready')
      expect(task.status).not.toBe('done')
      // The engine records its structured decision on the merger step (`step.custom`) so
      // the SPA can explain WHY review was needed — here, an assessment WITH scores but no
      // rationale routes to review as `no_rationale` (distinct from a truly absent one),
      // not an auto-merge.
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
        outcome?: string
        reason?: string
      }
      expect(decision.outcome).toBe('awaiting_review')
      expect(decision.reason).toBe('no_rationale')
    })

    it('runs the merger merge at its step even when a later step follows it', async () => {
      // Regression guard for the parity-critical bug where a step AFTER `merger` silently
      // disabled auto-merge: the real merge is a DETERMINISTIC post-completion resolver
      // registered on the `merger` kind, so it fires when the MERGER STEP finishes — not
      // only when the merger happens to be the pipeline's last step. With a credible
      // within-threshold assessment the task must reach `done` even though a trailing
      // pass-through gate follows. (The original trailing step was `post-release-health`;
      // that gate is now opt-in + observability-gated, so the unwired `ci` gate — likewise
      // a pass-through here — stands in as the trailing step.)
      const app = harness.makeApp({
        confidence: 1,
        mergeAssessment: {
          complexity: 0,
          risk: 0,
          impact: 0,
          rationale: 'Trivial, well-tested change.',
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merger + trailing gate',
        agentKinds: ['coder', 'merger', 'ci'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const task = snap.blocks.find((b) => b.id === 'task_login')!
      // The merge ran at the (non-final) merger step → the block is `done`, not left
      // unmerged as `pr_ready`.
      expect(task.status).toBe('done')
      // The auto-merge decision is recorded on the merger step for the SPA to render.
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
        outcome?: string
        reason?: string
        thresholds?: { presetName?: string }
      }
      expect(decision.outcome).toBe('auto_merged')
      expect(decision.reason).toBe('within_thresholds')
      expect(decision.thresholds?.presetName).toBeTruthy()
    })

    it('never auto-merges a task pinned to a "human review only" preset, even on a credible within-threshold assessment', async () => {
      // The "Manual review only" built-in preset (`autoMergeEnabled: false`) is the
      // human-review-only policy: a task pinned to it must ALWAYS route its PR to a human,
      // regardless of how low the assessment scores are. This drives the full task-threshold
      // wiring end-to-end — `block.riskPolicyId` → `resolveRiskPolicy` repository lookup →
      // `MergeResolver` — which the resolver unit test can't (it injects the preset directly).
      // A maximally-mergeable assessment (0/0/0 + a real rationale) would auto-merge under the
      // default preset; here it must NOT, proving the pinned preset — not the default — governs.
      const app = harness.makeApp({
        confidence: 1,
        mergeAssessment: {
          complexity: 0,
          risk: 0,
          impact: 0,
          rationale: 'Trivial, well-tested change.',
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      // Listing the catalog lazily seeds the built-ins so `mp_manual_review` is a real row the
      // task can pin (the resolver reads it back via the repository, which does not self-seed).
      const presets = await app.call<RiskPolicy[]>('GET', `/workspaces/${wsId}/risk-policies`)
      expect(presets.body.some((p) => p.id === 'mp_manual_review')).toBe(true)
      // Pin the human-review-only preset on the task.
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        riskPolicyId: 'mp_manual_review',
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merger',
        agentKinds: ['coder', 'merger'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const task = snap.blocks.find((b) => b.id === 'task_login')!
      // Human review only: the PR is left open for a human — never auto-merged.
      expect(task.status).toBe('pr_ready')
      expect(task.status).not.toBe('done')
      // The recorded decision names the pinned preset and the disabled-auto-merge reason so the
      // SPA banner is precise (distinct from an over-threshold `exceeded_thresholds`).
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
        outcome?: string
        reason?: string
        thresholds?: { presetName?: string; autoMergeEnabled?: boolean }
      }
      expect(decision.outcome).toBe('awaiting_review')
      expect(decision.reason).toBe('auto_merge_disabled')
      expect(decision.thresholds?.presetName).toBe('Manual review only')
      expect(decision.thresholds?.autoMergeEnabled).toBe(false)
    })

    it('routes to human review when a task pinned to a strict preset gets an over-threshold assessment', async () => {
      // The auto-merge ceilings a task's PICKED preset carries must actually gate the merge —
      // not just the workspace default. Pin a custom strict preset (low ceilings) and return an
      // assessment that clears the default's ceilings but exceeds the strict one's: the merge
      // must be blocked, proving the pinned preset's thresholds — resolved via the repository —
      // are the ones compared, and the exceeded axes are reported precisely.
      const app = harness.makeApp({
        confidence: 1,
        mergeAssessment: {
          complexity: 0.45,
          risk: 0.1,
          impact: 0.45,
          rationale: 'Touches several modules with moderate coupling.',
        },
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const strict = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
        name: 'Strict',
        maxComplexity: 0.3,
        maxRisk: 0.3,
        maxImpact: 0.3,
        ciMaxAttempts: 10,
        maxRequirementIterations: 6,
        maxRequirementConcernAllowed: 'none',
      })
      expect(strict.status).toBe(201)
      await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
        riskPolicyId: strict.body.id,
      })
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merger',
        agentKinds: ['coder', 'merger'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const task = snap.blocks.find((b) => b.id === 'task_login')!
      expect(task.status).toBe('pr_ready')
      expect(task.status).not.toBe('done')
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
        outcome?: string
        reason?: string
        exceededAxes?: string[]
        thresholds?: { presetName?: string }
      }
      expect(decision.outcome).toBe('awaiting_review')
      expect(decision.reason).toBe('exceeded_thresholds')
      // complexity (0.45) and impact (0.45) clear the default (0.5) but exceed the strict 0.3;
      // risk (0.1) is within — so only the two breaching axes are reported.
      expect(decision.exceededAxes?.sort()).toEqual(['complexity', 'impact'])
      expect(decision.thresholds?.presetName).toBe('Strict')
    })

    it('parks for a human when a companion spends its rework budget (no longer fails)', async () => {
      // Below the threshold the companion loops the producer back for automatic rework;
      // once the budget is spent the run no longer fails — it PARKS on the shared
      // iteration-cap gate for a human (one more round / proceed / stop & reset),
      // mirroring the requirements reviewer at its cap. A fixed low rating drives
      // straight to the cap on both runtimes.
      const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + strict companion',
        agentKinds: ['coder', 'reviewer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      // Parked, not failed.
      expect(exec.status).toBe('blocked')
      expect(exec.failure).toBeFalsy()
      const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
      expect(companionStep.state).toBe('waiting_decision')
      expect(companionStep.approval?.status).toBe('pending')
      expect(companionStep.companion?.exceeded).toBe(true)
      // The full automatic budget was spent before parking, and the recorded verdicts
      // carry the critic's REAL low rating (not the pass-through `1` for an unparseable
      // assessment). The fake critic emits anchor-based comments (no `quotedSource`),
      // so this also guards that `stepReviewCommentSchema` accepts the real shape.
      expect(companionStep.companion?.attempts).toBe(companionStep.companion?.maxAttempts)
      expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.4)).toBe(true)
      expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(false)

      // The generic approve resolver can't short-circuit the iteration-cap gate.
      const stray = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/steps/${companionStep.approval!.id}/approve`,
        {},
      )
      expect(stray.status).toBe(409)
    })

    it('grants one more round at the companion cap, then completes when it passes', async () => {
      // `extra-round` raises the budget by one and loops the producer back through the
      // companion to re-grade. Four low grades drive to the cap; the post-extra-round
      // grade passes, so the run completes — proving the human can rescue a stuck run.
      const app = harness.makeApp({
        confidence: 1,
        companionRatings: [0.4, 0.4, 0.4, 0.4, 1],
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + rescued companion',
        agentKinds: ['coder', 'reviewer'],
      })
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(parked.status).toBe('blocked')
      const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!
      const budgetAtCap = gate.companion!.maxAttempts

      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
        { choice: 'extra-round' },
      )
      expect(res.status).toBe(200)

      const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(done.status).toBe('done')
      const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
      // The budget was raised by exactly one and the gate is no longer flagged exceeded.
      expect(companionStep.companion?.maxAttempts).toBe(budgetAtCap + 1)
      expect(companionStep.companion?.exceeded).toBeFalsy()
      expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(true)
    })

    it('proceeds past the companion cap, advancing with the current output', async () => {
      // `proceed` accepts the producer's current (below-bar) output and advances past
      // the gate; since the companion is the final step, the run completes.
      const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + proceed companion',
        agentKinds: ['coder', 'reviewer'],
      })
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
        { choice: 'proceed' },
      )
      expect(res.status).toBe(200)

      const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(done.status).toBe('done')
      const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
      expect(companionStep.state).toBe('done')
      expect(companionStep.companion?.exceeded).toBeFalsy()
    })

    it('stops and resets the task to phase zero at the companion cap', async () => {
      // `stop-reset` tears the run down and returns the block to `planned` (editable),
      // identical to the requirements gate's stop-reset — the same `cancel()` path.
      const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + reset companion',
        agentKinds: ['coder', 'reviewer'],
      })
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

      const res = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
        { choice: 'stop-reset' },
      )
      expect(res.status).toBe(200)

      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const task = snap.blocks.find((b) => b.id === 'task_login')!
      expect(task.status).toBe('planned')
      // The run record is gone — the task is back to phase zero, editable.
      expect(snap.executions.some((e) => e.blockId === 'task_login')).toBe(false)
    })

    it('rejects a companion separated from its producer by another step (strict adjacency)', async () => {
      // A companion must run IMMEDIATELY after a producer it can review — the builder
      // surfaces companions as toggles attached to their producer, and the validation
      // enforces that adjacency on EVERY facade. ['coder','tester-api','reviewer'] slips
      // `tester` between the coder and its `reviewer` companion, so the pipeline save is
      // rejected (a `validation` domain error → 422) before any run is created.
      const app = harness.makeApp({ confidence: 1 })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const res = await app.call('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + gap companion',
        agentKinds: ['coder', 'tester-api', 'reviewer'],
      })
      expect(res.status).toBe(422)
    })
  })
}
