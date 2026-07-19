import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import {
  type CiStatusProvider,
  type GateProbe,
  type GateRegistry,
  type MergeabilityVerdict,
  type Pipeline,
  type PullRequestMergeabilityProvider,
  type PullRequestReviewProvider,
  type PullRequestReviewSnapshot,
  defaultStepResolverRegistry,
} from '@cat-factory/kernel'
import { makeFakeCi, makeFakeDocQuality, makeFakeReleaseHealth } from '../fakeGateProviders.js'
import type { ConformanceHarness } from '../harness.js'

// The polling-GATE half of the agent conformance group, extracted from `suites/agents.ts` for
// file-size hygiene (a cohesive cluster: the deployment-registered custom gate + step resolver,
// plus each externalized built-in `@cat-factory/gates` gate driven over a faked provider). Called
// from `defineAgentConformance` so it runs under the same `[name] conformance` describe on every
// runtime — the gate + step-resolver registries are injected app-owned instances via `makeApp`.
export function defineAgentGateConformance(harness: ConformanceHarness): void {
  describe('registered custom gate + step resolver', () => {
    // The gate + step-resolver registries are now app-owned (per-test instances injected via
    // `makeApp({ gateRegistry, stepResolverRegistry })`), so there is nothing global to clear.
    // A fresh gate registry with the built-in `@cat-factory/gates` suite installed, into which
    // a test then registers its custom `license-check` gate — exactly what a facade builds via
    // the shared `gateRegistryWithBuiltins()` helper (so this also covers that helper on every
    // runtime).
    const makeGateRegistry = (): GateRegistry => gateRegistryWithBuiltins()

    // A deployment-registered polling gate is the OTHER half of the extension story
    // (alongside custom agent kinds): a deterministic precheck that passes through when
    // clean and only escalates to a registered helper agent on a red verdict. The engine
    // merges it into the (otherwise built-in) gate registry and drives it through the SAME
    // generic gate machine — so a facade that forgot to wire the registry merge, or one
    // whose gate state machine drifts, fails here rather than shipping. Mirrors the
    // built-in `ci`→`ci-fixer` gate, with the provider faked in-test (no real GitHub).

    // The custom gate's helper is just a registered agent kind — no new dispatch path.
    // Registered on a per-test app-owned registry (injected via makeApp), not a global.
    const registerLicenseFixer = (registry: ReturnType<typeof defaultAgentKindRegistry>): void =>
      registry.register({
        kind: 'license-fixer',
        systemPrompt: 'You add missing license headers and push.',
        agent: { surface: 'container-coding', clone: { branch: 'pr' } },
      })

    // Register the `license-check` gate over a fake provider whose verdict is supplied
    // per-probe (a queue; the last entry repeats) so a test can drive pass / escalate.
    const registerLicenseGate = (gateRegistry: GateRegistry, verdicts: boolean[]): void => {
      let i = 0
      gateRegistry.register('license-check', (ctx) => ({
        kind: 'license-check',
        helperKind: 'license-fixer',
        wired: () => true,
        unwiredOutput: 'license gate skipped',
        probe: async (): Promise<GateProbe> => {
          const clean = verdicts[Math.min(i, verdicts.length - 1)] ?? true
          i += 1
          return clean
            ? { status: 'pass', headSha: 'sha', passOutput: 'license gate passed' }
            : { status: 'fail', headSha: 'sha', failureSummary: 'missing headers' }
        },
        onExhausted: async ({ workspaceId, block, instance }) => {
          await ctx.raiseNotification(workspaceId, {
            type: 'decision_required',
            blockId: block.id,
            executionId: instance.id,
            title: 'License headers still missing',
            body: 'spent',
          })
          return { error: 'license headers still missing' }
        },
      }))
    }

    it('passes through on a clean precheck without spinning up the helper', async () => {
      const agentKindRegistry = defaultAgentKindRegistry()
      registerLicenseFixer(agentKindRegistry)
      const gateRegistry = makeGateRegistry()
      registerLicenseGate(gateRegistry, [true]) // clean on first probe
      const app = harness.makeApp(
        { asyncKinds: ['coder', 'license-fixer'] },
        { agentKindRegistry, gateRegistry },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + license check',
        agentKinds: ['coder', 'license-check'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'license-check')!
      expect(step.state).toBe('done')
      // Clean precheck ⇒ the helper was NEVER dispatched (no attempts spent).
      expect(step.gate?.attempts ?? 0).toBe(0)
      expect(step.output).toContain('license gate passed')
    })

    it('escalates to the helper on a red precheck, then advances when it re-probes clean', async () => {
      const agentKindRegistry = defaultAgentKindRegistry()
      registerLicenseFixer(agentKindRegistry)
      const gateRegistry = makeGateRegistry()
      registerLicenseGate(gateRegistry, [false, true]) // red first, clean after the fixer ran
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'license-fixer'],
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
        },
        { agentKindRegistry, gateRegistry },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + license check',
        agentKinds: ['coder', 'license-check'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'license-check')!
      expect(step.state).toBe('done')
      // One escalation: the helper was dispatched once, then the re-probe passed.
      expect(step.gate?.attempts).toBe(1)
      expect(step.gate?.attemptLog?.[0]?.outcome).toBe('completed')
    })

    // A registered step resolver runs deterministic backend follow-up keyed on the
    // finished step's agentKind — here it rewrites a custom kind's step output. Asserts
    // the engine merges registered resolvers into the (built-in merger) resolver registry
    // and runs them in recordStepResult, identically on every runtime.
    it('runs a registered step resolver after its agent step completes', async () => {
      const agentKindRegistry = defaultAgentKindRegistry()
      agentKindRegistry.register({
        kind: 'conformance-auditor',
        systemPrompt: 'You audit.',
        agent: { surface: 'container-explore', output: { kind: 'structured' } },
      })
      const stepResolverRegistry = defaultStepResolverRegistry()
      stepResolverRegistry.register('conformance-auditor', () => ({
        kind: 'conformance-auditor',
        applies: (result) => result.custom !== undefined,
        resolve: async () => ({ output: 'resolver-rewrote-this' }),
      }))
      const app = harness.makeApp(
        { customResult: { ok: true } },
        { agentKindRegistry, stepResolverRegistry },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Audit',
        agentKinds: ['conformance-auditor'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'conformance-auditor')!
      expect(step.output).toBe('resolver-rewrote-this')
    })
  })

  describe('built-in ci gate (externalized to @cat-factory/gates)', () => {
    // The platform's OWN `ci` gate is now authored as an external package through the public
    // `registerGate` seam — no longer inline in the engine. Driving it here over a faked
    // CiStatusProvider proves the externalized built-in still passes-through on green CI and
    // escalates to `ci-fixer` on red, identically on every runtime: if the gate package, the
    // wire-handle, or a facade's import drifted, this fails instead of shipping.

    // The single-repo fake CI provider (`makeFakeCi`, imported from `./fakeGateProviders`)
    // supplies its check verdict per-probe (a queue; the last entry repeats), so a test can
    // drive green / red→green like the registered-gate test does. It is injected THROUGH
    // `makeApp` (`gateProviders`), not wired directly: a facade build resets the
    // deployment-global gate providers up-front and the Worker rebuilds the container per
    // request, so a directly-wired provider would be cleared before the gate probes.
    // Threading it into the build re-wires it on every rebuild, on every runtime.

    // A multi-repo (service-connections phase 4) fake CI provider: the task opened an
    // own-service PR AND one peer PR, and the gate aggregates the verdict across BOTH. Each
    // repo's greenness is supplied per probe (a queue; last entry repeats) so a test can drive
    // "peer red → own green" then "both green".
    const makeFakeMultiRepoCi = (rounds: [boolean, boolean][]): CiStatusProvider => {
      let i = 0
      return {
        getStatus: async () => {
          const [ownGreen, peerGreen] = rounds[Math.min(i, rounds.length - 1)] ?? [true, true]
          i += 1
          const checks = (green: boolean, name: string) => [
            { name, status: 'completed', conclusion: green ? 'success' : 'failure', url: null },
          ]
          return {
            repos: [
              { repo: 'o/own', headSha: 'ownsha', checks: checks(ownGreen, 'own-build') },
              { repo: 'o/peer', headSha: 'peersha', checks: checks(peerGreen, 'peer-build') },
            ],
          }
        },
      }
    }

    it('passes through on green CI without spinning up ci-fixer', async () => {
      const app = harness.makeApp(
        { asyncKinds: ['coder', 'ci-fixer'] },
        { gateProviders: { ciStatus: makeFakeCi([true]) } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + CI',
        agentKinds: ['coder', 'ci'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'ci')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts ?? 0).toBe(0)
      expect(step.output).toContain('CI gate passed')
    })

    // Race-audit 2.2 driver-half / 2.3 END-TO-END: a human cancels the run WHILE the gate is
    // mid-probe (the driver's load→CAS window). The gate's post-probe write then lands on the
    // row `cancel()` deleted. A blind `upsert` would RE-INSERT a zombie `running` run; the
    // CAS-guarded driver write is refused, thrown as `RunContendedError`, caught at the poll
    // entry point, and re-driven — which no-ops on the now-gone run. Proven on every runtime.
    it('a cancel during a gate poll cannot resurrect the run (driver writes are CAS-guarded)', async () => {
      // Fires exactly once, on the first probe, via the real HTTP cancel surface — reproducing
      // a human cancel landing inside the gate's probe→persist window.
      let cancel: (() => Promise<void>) | null = null
      const provider: CiStatusProvider = {
        getStatus: async () => {
          if (cancel) {
            const fire = cancel
            cancel = null
            await fire()
          }
          // CI still in-flight → the gate takes its `pending` branch, whose persist is the
          // write that now hits the deleted row.
          return {
            repos: [
              {
                repo: 'o/r',
                headSha: 'sha',
                checks: [{ name: 'build', status: 'in_progress', conclusion: null, url: null }],
              },
            ],
          }
        },
      }
      const app = harness.makeApp(
        { asyncKinds: ['coder'] },
        { gateProviders: { ciStatus: provider } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      cancel = async () => {
        await app.call('DELETE', `/workspaces/${wsId}/blocks/task_login/executions`)
      }

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + CI',
        agentKinds: ['coder', 'ci'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      // Drives coder → done → ci gate → probe (cancels) → pending-write refused → re-drive → stop.
      await app.drive(wsId)

      // The run stays cancelled (no zombie re-insert) and the block is back to `planned`.
      expect(await app.executionRepository().getByBlock(wsId, 'task_login')).toBeNull()
      expect((await app.blockRepository().get(wsId, 'task_login'))?.status).toBe('planned')
    })

    it('escalates to ci-fixer on red CI, then advances when it re-probes green', async () => {
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'ci-fixer'],
          // Model a container-reusing runner: the gate's `ci-fixer` helper shares the
          // re-dispatch shape the per-round dispatch epoch fixes, so exercise it under a
          // pooled harness whose JobRegistry survives between rounds.
          pooledContainer: true,
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
        },
        // red first, green after the fixer ran
        { gateProviders: { ciStatus: makeFakeCi([false, true]) } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + CI',
        agentKinds: ['coder', 'ci'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'ci')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts).toBe(1)
      const attempt = step.gate?.attemptLog?.[0]
      expect(attempt?.outcome).toBe('completed')
      // The round records WHAT it was handed to fix (the failing-check summary + the
      // structured red checks), not only that a round happened — the gate analogue of the
      // Tester attempt's concerns, surfaced per-runtime.
      expect(attempt?.instructions).toBeTruthy()
      expect(attempt?.failingChecks?.map((c) => c.name)).toEqual(['build'])
    })

    it('aggregates CI across a multi-repo task: a red PEER PR escalates, both green advances', async () => {
      // Service-connections phase 4: a cross-service task opens one PR per changed repo, and the
      // CI gate aggregates the verdict across ALL of them. Here the OWN PR is green but a PEER
      // PR is red on the first probe → the gate must NOT advance (a red peer fails the gate),
      // escalate the ci-fixer once, then advance when the re-probe sees both green. The per-repo
      // head shas are persisted on the gate state so the UI can group checks by service.
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'ci-fixer'],
          pooledContainer: true,
          pullRequest: {
            url: 'https://github.com/o/own/pull/1',
            number: 1,
            branch: 'feat/login',
          },
        },
        // round 1: own green, peer RED → fail+escalate; round 2: both green → advance
        {
          gateProviders: {
            ciStatus: makeFakeMultiRepoCi([
              [true, false],
              [true, true],
            ]),
          },
        },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + CI',
        agentKinds: ['coder', 'ci'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'ci')!
      expect(step.state).toBe('done')
      // The red PEER PR fails the aggregate verdict → one ci-fixer attempt.
      expect(step.gate?.attempts).toBe(1)
      // Both repos' heads are tracked on the multi-repo gate state.
      expect(step.gate?.headShas).toMatchObject({ 'o/own': 'ownsha', 'o/peer': 'peersha' })
      // The failing round names the failing peer check (with its repo).
      const failing = step.gate?.attemptLog?.[0]?.failingChecks ?? []
      expect(failing.map((c) => c.name)).toContain('peer-build')
      expect(failing.find((c) => c.name === 'peer-build')?.repo).toBe('o/peer')
    })
  })

  describe('built-in conflicts gate (externalized to @cat-factory/gates)', () => {
    // The `conflicts` gate probes PR mergeability and, on a conflict, loops the
    // `conflict-resolver`. Driving it over a faked mergeability provider proves the externalized
    // gate + its wire-handle behave identically on every runtime — and, for the multi-repo
    // (service-connections phase 4) case, that a conflicted PEER PR now ESCALATES the resolver
    // (tagged with the peer as its target) instead of fast-failing to a manual give-up.

    // A multi-repo fake mergeability provider: an own-service PR plus one peer PR, each verdict
    // supplied per-probe (a queue; last entry repeats), so a test can drive "peer conflicted →
    // both mergeable" across the resolver round.
    const makeFakeMultiRepoMergeability = (
      rounds: [MergeabilityVerdict, MergeabilityVerdict][],
    ): PullRequestMergeabilityProvider => {
      let i = 0
      return {
        getMergeability: async () => {
          const [own, peer] = rounds[Math.min(i, rounds.length - 1)] ?? ['mergeable', 'mergeable']
          i += 1
          return {
            repos: [
              { repo: 'o/own', headSha: 'ownsha', verdict: own },
              { repo: 'o/peer', frameId: 'blk_email', headSha: 'peersha', verdict: peer },
            ],
          }
        },
      }
    }

    it('escalates a conflicted PEER PR to the conflict-resolver, then advances when both merge cleanly', async () => {
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'conflict-resolver'],
          // A container-reusing runner (the resolver re-dispatch shape the per-round epoch fixes).
          pooledContainer: true,
          pullRequest: {
            url: 'https://gh/o/own/pull/1',
            number: 1,
            branch: 'cat-factory/task_login',
          },
        },
        // round 1: own mergeable, peer CONFLICTED → escalate; round 2: both mergeable → advance
        {
          gateProviders: {
            mergeability: makeFakeMultiRepoMergeability([
              ['mergeable', 'conflicted'],
              ['mergeable', 'mergeable'],
            ]),
          },
        },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + conflicts',
        agentKinds: ['coder', 'conflicts'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      // Run COMPLETES (not blocked): previously a peer-only conflict declined escalation and
      // fast-failed to a manual give-up (attempts 0, run failed). Now it escalates the resolver
      // and, once the re-probe is clean, advances — so `done` + one attempt is the whole change.
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'conflicts')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts).toBe(1)
      // (Which repo the resolver targets — the peer — is asserted in the server package's
      // job-body unit test, since the gate resets `conflictTarget` to null on the passing probe.)
    })
  })

  describe('built-in doc-quality gate (externalized to @cat-factory/gates)', () => {
    // The forward document pipelines' structural gate: a deterministic precheck of the drafted
    // document that passes through when well-formed and escalates to the registered `doc-fixer`
    // helper on a red verdict. Driving it over a faked DocQualityProvider proves the externalized
    // gate + its wire-handle + each facade's import + the doc-fixer registered helper behave
    // identically on every runtime — a drift fails here instead of shipping.

    // The fake doc-quality provider (`makeFakeDocQuality`, imported from
    // `./fakeGateProviders`) supplies its verdict per-probe (a queue; last repeats).

    it('passes through on a well-formed document without spinning up doc-fixer', async () => {
      const app = harness.makeApp(
        { asyncKinds: ['coder', 'doc-fixer'] },
        { gateProviders: { docQuality: makeFakeDocQuality([true]) } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Doc + quality',
        agentKinds: ['coder', 'doc-quality'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'doc-quality')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts ?? 0).toBe(0)
      expect(step.output).toContain('Document-quality gate passed')
    })

    it('escalates to doc-fixer on a malformed document, then advances when it re-probes clean', async () => {
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'doc-fixer'],
          pooledContainer: true,
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/doc' },
        },
        // malformed first, well-formed after the doc-fixer ran
        { gateProviders: { docQuality: makeFakeDocQuality([false, true]) } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Doc + quality',
        agentKinds: ['coder', 'doc-quality'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'doc-quality')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts).toBe(1)
      expect(step.gate?.attemptLog?.[0]?.outcome).toBe('completed')
    })
  })

  describe('built-in post-release-health gate (externalized to @cat-factory/gates)', () => {
    // The post-release-health gate watches a MERGED release's observability signals and, on a
    // regression, escalates the INVESTIGATE-don't-fix `on-call` helper (which reverts nothing),
    // then settles the gate via its `resolveHelperCompletion` hook — raising a
    // `release_regression` notification instead of re-probing. Driving it over a faked
    // ReleaseHealthProvider proves the externalized gate + its wire-handle + the on-call helper's
    // structured assessment channel + the release-regression notification behave identically on
    // every runtime; a facade that wired the release-health path into only one runtime fails here
    // instead of shipping. The gate only watches a release that actually shipped, so the merger
    // auto-merges first (`confidence: 1` → block `done`); a `regressed` probe then escalates.

    it('escalates on-call on a regressed release and raises a release_regression notification', async () => {
      const app = harness.makeApp(
        {
          confidence: 1,
          asyncKinds: ['on-call'],
          onCallAssessment: {
            culpritConfidence: 0.9,
            recommendation: 'revert',
            rationale: 'the released diff correlates with the regressed signal',
            evidence: [],
          },
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
        },
        { gateProviders: { releaseHealth: makeFakeReleaseHealth(['regressed']) } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // The gate is observability-gated: a pipeline carrying it is rejected at CREATE unless the
      // workspace has an observability connection. The credentials are never used at runtime (the
      // verdict comes from the fake provider) — only the connection ROW is required.
      const conn = await app.call('PUT', `/workspaces/${wsId}/observability/connection`, {
        provider: 'datadog',
        credentials: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' },
      })
      expect(conn.status).toBe(200)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merge + post-release-health',
        agentKinds: ['coder', 'merger', 'post-release-health'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      // The merger auto-merged (→ block `done`), the gate probed `regressed` and escalated the
      // on-call helper, whose completion settled the gate (it re-probes nothing) so the run
      // finished. One escalation, and the block stays merged.
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'post-release-health')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts).toBe(1)
      expect((await app.blockRepository().get(wsId, 'task_login'))?.status).toBe('done')

      // The investigation raised exactly the human-actionable release-regression notification.
      const open = await app.notificationRepository().listOpen(wsId)
      expect(open.map((n) => n.type)).toContain('release_regression')
    })
  })

  describe('built-in human-review gate (externalized to @cat-factory/gates)', () => {
    // The `human-review` gate watches the PR for a human code review and loops the `fixer` to
    // address review threads, advancing once approved with no unresolved threads. Driving it
    // over a faked PullRequestReviewProvider proves the externalized gate + its wire-handle +
    // each facade's import behave identically: the gate dispatches the fixer, resolves the
    // handed thread on the helper's completion, then advances — or a drift fails here.

    const APPROVED_CLEAN: PullRequestReviewSnapshot = {
      headSha: 'sha',
      requiredApprovingReviewCount: 1,
      assignedReviewers: [],
      approvals: 1,
      unresolvedThreads: [],
      comments: [],
    }

    it('passes through when approved with no unresolved threads', async () => {
      const app = harness.makeApp(
        { asyncKinds: ['coder', 'fixer'] },
        {
          gateProviders: {
            prReview: { getReview: async () => APPROVED_CLEAN, resolveThreads: async () => {} },
          },
        },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + review',
        agentKinds: ['coder', 'human-review'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'human-review')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts ?? 0).toBe(0)
    })

    it('loops the fixer on an unresolved thread, resolves it, then advances', async () => {
      // Approved (so dispatch is immediate, no grace/clock dependence) WITH one unresolved
      // thread → dispatch the fixer; onHelperComplete resolves the thread; the re-probe then
      // sees it clean and advances.
      const resolvedThreads: string[] = []
      let resolved = false
      // The gate only resolves a fixer round's threads once the fixer actually pushed a commit
      // (the PR head advanced). Model that: the head is `sha1` on the dispatch probe and
      // advances to `sha2` afterwards, so onHelperComplete confirms progress and resolves.
      let reviews = 0
      const provider: PullRequestReviewProvider = {
        getReview: async () => {
          reviews += 1
          const headSha = reviews >= 2 ? 'sha2' : 'sha'
          return resolved
            ? { ...APPROVED_CLEAN, headSha }
            : {
                ...APPROVED_CLEAN,
                headSha,
                unresolvedThreads: [
                  {
                    threadId: 'T1',
                    author: 'alice',
                    bodyExcerpt: 'rename this',
                    path: 'src/a.ts',
                    line: 1,
                    isBot: false,
                    latestCommentAt: 0,
                  },
                ],
              }
        },
        resolveThreads: async (_ws, _b, ids) => {
          resolvedThreads.push(...ids)
          resolved = true
        },
      }
      const app = harness.makeApp(
        {
          asyncKinds: ['coder', 'fixer'],
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
        },
        { gateProviders: { prReview: provider } },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + review',
        agentKinds: ['coder', 'human-review'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = exec.steps.find((s) => s.agentKind === 'human-review')!
      expect(step.state).toBe('done')
      expect(step.gate?.attempts).toBe(1)
      expect(resolvedThreads).toEqual(['T1'])
    })
  })
}
