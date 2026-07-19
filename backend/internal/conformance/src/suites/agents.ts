import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { clearGateProviders, registerBuiltinGates } from '@cat-factory/gates'
import {
  type Block,
  type CiStatusProvider,
  type GateProbe,
  type MergeabilityVerdict,
  type Pipeline,
  type PullRequestMergeabilityProvider,
  type PullRequestReviewProvider,
  type PullRequestReviewSnapshot,
  type RepoFiles,
  type SandboxExperiment,
  type SandboxFixture,
  type SandboxPromptVersion,
  type WorkspaceSnapshot,
  clearRegisteredGates,
  clearRegisteredStepResolvers,
  registerGate,
  registerStepResolver,
} from '@cat-factory/kernel'
import {
  clearRegisteredPromptFragments,
  registerPromptFragment,
} from '@cat-factory/prompt-fragments'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeCi, makeFakeDocQuality, makeFakeReleaseHealth } from '../fakeGateProviders.js'
import type { ConformanceHarness } from '../harness.js'

export function defineAgentConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('sandbox (prompt/model testing surface)', () => {
      it('lists baselines, clones+versions prompts, seeds fixtures and defines experiments', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/sandbox`

        // Overview seeds the builtin fixtures on first load and exposes the testable
        // agent-kind catalog + the shipped baselines (synthetic, never persisted).
        const overview = await call<{
          agentKinds: { agentKind: string }[]
          prompts: SandboxPromptVersion[]
          fixtures: SandboxFixture[]
          experiments: SandboxExperiment[]
          maxCells: number
        }>('GET', `${base}/overview`)
        expect(overview.status).toBe(200)
        expect(overview.body.agentKinds.some((k) => k.agentKind === 'requirements-review')).toBe(
          true,
        )
        expect(overview.body.prompts.some((p) => p.origin === 'baseline')).toBe(true)
        expect(overview.body.fixtures.length).toBeGreaterThan(0)
        // The cell cap is surfaced so the UI gates on the SAME limit instead of re-encoding it.
        expect(overview.body.maxCells).toBeGreaterThan(0)
        const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!
        expect(fixture).toBeTruthy()

        // Clone the requirements-review baseline into an editable candidate lineage (v1).
        const cloned = await call<SandboxPromptVersion>('POST', `${base}/prompts/clone`, {
          agentKind: 'requirements-review',
          basePromptId: 'requirement-review',
          name: 'My reviewer',
        })
        expect(cloned.status).toBe(201)
        expect(cloned.body.origin).toBe('candidate')
        expect(cloned.body.version).toBe(1)
        expect(cloned.body.systemText.length).toBeGreaterThan(0)

        // Append an edited version onto the lineage (v2 on the same lineage id).
        const v2 = await call<SandboxPromptVersion>('POST', `${base}/prompts`, {
          parentId: cloned.body.id,
          systemText: `${cloned.body.systemText}\n\nAlways check authz.`,
        })
        expect(v2.status).toBe(201)
        expect(v2.body.version).toBe(2)
        expect(v2.body.lineageId).toBe(cloned.body.lineageId)

        // Both candidate versions + the baselines come back from the prompt listing.
        const prompts = await call<SandboxPromptVersion[]>('GET', `${base}/prompts`)
        expect(prompts.body.filter((p) => p.lineageId === cloned.body.lineageId)).toHaveLength(2)

        // Define a draft experiment over the baseline prompt × one model × the fixture.
        const experiment = await call<SandboxExperiment>('POST', `${base}/experiments`, {
          name: 'Reviewer shootout',
          agentKind: 'requirements-review',
          judgeModel: 'anthropic:claude-opus-4-8',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['anthropic:claude-opus-4-8'],
            fixtureIds: [fixture.id],
          },
        })
        expect(experiment.status).toBe(201)
        expect(experiment.body.status).toBe('draft')
        expect(experiment.body.judgeModel.length).toBeGreaterThan(0)

        // The experiment + its (still empty) result grid read back.
        const detail = await call<{
          experiment: SandboxExperiment
          runs: unknown[]
          grades: unknown[]
        }>('GET', `${base}/experiments/${experiment.body.id}`)
        expect(detail.status).toBe(200)
        expect(detail.body.experiment.id).toBe(experiment.body.id)
        expect(detail.body.runs).toHaveLength(0)
        expect(detail.body.grades).toHaveLength(0)

        // A non-runnable matrix is rejected at create time.
        const empty = await call('POST', `${base}/experiments`, {
          name: 'Bad',
          agentKind: 'requirements-review',
          matrix: { promptVersionIds: [], models: [], fixtureIds: [] },
        })
        expect(empty.status).toBeGreaterThanOrEqual(400)

        // A zero token budget is rejected at create (it would otherwise fail every cell).
        const zeroBudget = await call('POST', `${base}/experiments`, {
          name: 'No budget',
          agentKind: 'requirements-review',
          judgeModel: 'anthropic:claude-opus-4-8',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['anthropic:claude-opus-4-8'],
            fixtureIds: [fixture.id],
          },
          budgetTokens: 0,
        })
        expect(zeroBudget.status).toBeGreaterThanOrEqual(400)
      })

      it('drives the run/grade lifecycle to a terminal grid identically across runtimes', async () => {
        // Force the model provider ON for both runtimes (the Worker binds `AI`, Node has no
        // binding) so `launch` reaches the run-driver identically rather than 503/400-ing at
        // provider resolution on one facade only.
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: true,
        })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/sandbox`

        const overview = await call<{ fixtures: SandboxFixture[] }>('GET', `${base}/overview`)
        const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!

        // Define a 2-cell experiment against a deliberately UNCONFIGURED provider: the
        // run-driver resolves the model per cell and the resolve throws (no key wired in
        // the suite), so every candidate fails WITHOUT any network call. This exercises the
        // whole driver path — expand→persist→run→settle, plus the relaunch delete ordering
        // (grades before runs) — identically on D1 and Postgres, which the CRUD-only block
        // above never reached. A graded happy path needs a fake judge model and is a
        // tracked follow-up.
        const created = await call<SandboxExperiment>('POST', `${base}/experiments`, {
          name: 'Driver parity',
          agentKind: 'requirements-review',
          judgeModel: 'no-such-vendor:none',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['no-such-vendor:a', 'no-such-vendor:b'],
            fixtureIds: [fixture.id],
          },
        })
        expect(created.status).toBe(201)

        const launched = await call<{
          experiment: SandboxExperiment
          runs: { status: string; error?: string }[]
          grades: unknown[]
        }>('POST', `${base}/experiments/${created.body.id}/launch`)
        expect(launched.status).toBe(200)
        // Every candidate failed → no cell graded → the experiment settles `failed`, never
        // a misleading `done` with an unscored grid, and never stuck `running`.
        expect(launched.body.experiment.status).toBe('failed')
        expect(launched.body.runs).toHaveLength(2)
        expect(launched.body.runs.every((r) => r.status === 'failed')).toBe(true)
        expect(launched.body.grades).toHaveLength(0)

        // A relaunch replaces the grid in place rather than accumulating cells.
        const relaunched = await call<{ runs: unknown[] }>(
          'POST',
          `${base}/experiments/${created.body.id}/launch`,
        )
        expect(relaunched.status).toBe(200)
        expect(relaunched.body.runs).toHaveLength(2)

        // Two CONCURRENT launches must not duplicate the grid: the experiment's atomic claim
        // (`claimForRun`) lets exactly one win the run at a time, so whichever interleaving the
        // real store produces, the grid still settles to exactly 2 cells (never 4) — and at
        // least one launch succeeds rather than both 409-ing.
        const [first, second] = await Promise.all([
          call('POST', `${base}/experiments/${created.body.id}/launch`),
          call('POST', `${base}/experiments/${created.body.id}/launch`),
        ])
        expect([first.status, second.status].some((s) => s === 200)).toBe(true)
        const afterRace = await call<{ runs: unknown[] }>(
          'GET',
          `${base}/experiments/${created.body.id}`,
        )
        expect(afterRace.body.runs).toHaveLength(2)
      })
    })

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

      it('folds the service fragments into code-aware agents only', async () => {
        // Register a deployment-style custom fragment into the universal pool, select it
        // as a service's standards, and assert the engine folds it into a `code-aware`
        // step's prompt (coder) but not a non-code-aware one (documenter).
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

          // Set the service-level selection on the seeded auth frame (task_login's owner).
          await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
            serviceFragmentIds: ['test.svc-standard'],
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

          // The coder is `code-aware`: it receives the service's fragment.
          const coder = exec.steps.find((s) => s.agentKind === 'coder')!
          expect(coder.output).toContain('[frags]test.svc-standard[/frags]')
          expect(coder.selectedFragmentIds).toEqual(['test.svc-standard'])

          // The doc-outliner is `doc-aware`: it folds the same service fragments (the
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

        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceFragmentIds: ['db.managed-standard'],
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
        // it on a service and asserting a `coder` run resolves it proves the fragment is in
        // the universal pool and reaches a code-aware agent identically on D1 and Postgres —
        // a rename/removal of the design fragment fails here. (The document body's own
        // materialisation into the agent context is covered by the generic document-source
        // path; design sources ride it unchanged.)
        const app = harness.makeApp({ echoFragments: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceFragmentIds: ['design.context'],
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

    describe('registered custom kind pre/post-ops', () => {
      // A registered custom agent kind decomposes into preOps → agent → postOps, with the
      // deterministic repo work (read a baseline artifact, render + commit files) running
      // as BACKEND TypeScript over the checkout-free RepoFiles port — never in a container.
      // This asserts the engine actually RUNS those hooks (and binds them to the run's repo)
      // identically on every runtime, so a facade that forgot to wire `resolveRunRepoContext`
      // fails here rather than silently skipping a custom kind's render.
      it('runs a kind’s pre-op + post-op, committing rendered files via the checkout-free RepoFiles', async () => {
        // An in-memory RepoFiles capturing what the hooks read + commit (the suite's stand-in
        // for a facade's GitHubClient-backed RepoFiles), so the assertion needs no real GitHub.
        const reads: string[] = []
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async (path) => {
            reads.push(path)
            return null
          },
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        // App-owned DI: a deployment news a registry (pre-loaded with the built-ins) and
        // registers its kind on it BY REFERENCE, then injects the SAME instance into the
        // container build — no module-global, no `clear*()`. The suite threads it through
        // `makeApp`'s `agentKindRegistry` option (into both the container and the fake).
        const agentKindRegistry = defaultAgentKindRegistry()
        agentKindRegistry.register({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit the service for compliance.',
          // A read-only container-explore step returning structured JSON (surfaced as
          // `result.custom`) — exactly the generic manifest-driven `agent` dispatch.
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
          // Presentation makes it a first-class palette block, so the workspace snapshot's
          // custom-kind projection advertises it (the snapshot assertion below).
          presentation: {
            label: 'Conformance Auditor',
            icon: 'i-lucide-shield-check',
            color: '#10b981',
            description: 'Audits the service for compliance.',
            category: 'review',
            resultView: 'generic-structured',
          },
          // PRE-op: read a baseline artifact (no checkout). Proves pre-ops run + are bound
          // to the resolved branch.
          preOps: [
            async (ctx) => {
              await ctx.repo.getFile('compliance/POLICY.md', ctx.branch)
            },
          ],
          // POST-op: render a file from the agent's structured output + commit it. The
          // backend-side rendering that used to live in the harness.
          postOps: [
            async (ctx) => {
              const custom = ctx.result?.custom as { findings?: string } | undefined
              await ctx.repo.commitFiles({
                branch: ctx.branch,
                message: 'chore: compliance report',
                files: [
                  {
                    path: 'compliance/REPORT.md',
                    content: `# Compliance report\n\n${custom?.findings ?? '(none)'}\n`,
                  },
                ],
              })
            },
          ],
        })

        const app = harness.makeApp(
          { customResult: { findings: 'all clear' } },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }), agentKindRegistry },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The registered kind is advertised in the workspace snapshot's custom-kind palette on
        // every runtime — proving the injected instance reaches the HTTP snapshot projection,
        // not just the engine (the module-global registration this replaces used to do this).
        const snap = await app.call<{ customAgentKinds?: { kind: string }[] }>(
          'GET',
          `/workspaces/${wsId}`,
        )
        expect(
          (snap.body.customAgentKinds ?? []).some((k) => k.kind === 'conformance-auditor'),
        ).toBe(true)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Compliance audit',
          agentKinds: ['conformance-auditor'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The pre-op read the baseline artifact on the resolved branch…
        expect(reads).toContain('compliance/POLICY.md')
        // …and the post-op committed the rendered file from the agent's `custom` output —
        // via the checkout-free RepoFiles port, identically on D1 and Postgres. The kind
        // declares no clone target, so it resolves to the per-block work branch
        // `cat-factory/<blockId>` the container agent would use — NOT the default branch,
        // so a committing post-op never silently lands on `main`.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('cat-factory/task_login')
        expect(commits[0]?.files[0]?.path).toBe('compliance/REPORT.md')
        expect(commits[0]?.files[0]?.content).toContain('all clear')
      })

      // Apriori WORKING branch (slice 2): when the task names an existing branch as the run's
      // starting point, the backend repo-ops must read/commit that branch instead of the
      // deterministic `cat-factory/<blockId>` one — the RunDispatcher branch-swap, asserted
      // identically on D1 and Postgres so a facade can't diverge on where a post-op commits.
      it('commits a custom kind’s post-op onto the task’s apriori working branch, not cat-factory/*', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          // The apriori working branch already exists (probe-only ensure finds it): headSha
          // truthy for every ref, so the swap resolves to it rather than creating one.
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        const agentKindRegistry = defaultAgentKindRegistry()
        agentKindRegistry.register({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit the service for compliance.',
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
          presentation: {
            label: 'Conformance Auditor',
            icon: 'i-lucide-shield-check',
            color: '#10b981',
            description: 'Audits the service for compliance.',
            category: 'review',
            resultView: 'generic-structured',
          },
          postOps: [
            async (ctx) => {
              await ctx.repo.commitFiles({
                branch: ctx.branch,
                message: 'chore: compliance report',
                files: [{ path: 'compliance/REPORT.md', content: '# ok\n' }],
              })
            },
          ],
        })

        const app = harness.makeApp(
          { customResult: { findings: 'all clear' } },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }), agentKindRegistry },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Name an existing branch as the run's working branch (single working entry).
        const patched = await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          aprioriBranches: [{ name: 'feature/spike', mode: 'working' }],
        })
        expect(patched.status).toBe(200)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Compliance audit',
          agentKinds: ['conformance-auditor'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The post-op committed onto the apriori working branch, NOT `cat-factory/task_login`.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('feature/spike')
      })
    })

    describe('spike research pipeline (pl_spike / pl_spike_direct)', () => {
      // A spike is a timeboxed research task: the read-only built-in `spike` explore agent
      // returns structured findings and a BACKEND post-op DELIVERS them, following the pipeline:
      //   - `pl_spike` (default): commit to a WORK branch + open a PR (recorded on the block via
      //     the RepoOp seam) so the `conflicts → ci → human-review → merger` tail reviews + merges
      //     it — protected base branches are respected.
      //   - `pl_spike_direct`: commit `docs/research/<slug>.md` STRAIGHT onto the base branch (no
      //     PR); with no `merger` the task reaches `done` via the engine's no-PR completion path.
      // Both are asserted identically on every runtime so a facade (or the shared RepoOp/PR-record
      // seam) can't diverge.
      const SPIKE_FINDINGS = {
        question: 'Should we adopt library X?',
        summary: 'X fits our needs with one caveat around bundle size.',
        findings: [{ title: 'Good DX', detail: 'Typed API, small surface.' }],
        optionsCompared: [{ option: 'X', assessment: 'Best fit' }],
        recommendation: 'Adopt X behind a flag.',
        openQuestions: ['Bundle-size budget?'],
        confidence: 0.7,
      }

      it('runs pl_spike by opening + recording a findings PR, then merging it to `done`', async () => {
        // The PR-delivery seam end-to-end: the spike post-op sees a merge tail (opensPr), so it
        // commits the findings to a WORK branch, opens a PR onto base, and returns its ref — which
        // the engine records as `block.pullRequest`, exactly like a container-coding step. The
        // `conflicts → ci → human-review` tail passes through (no providers wired) and the merger
        // merges the recorded PR. Runtime-symmetric: the RepoOp PR-record path is shared engine code.
        const commits: { branch: string }[] = []
        const opened: { head: string; base: string }[] = []
        const branches = new Set<string>(['main'])
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async (b) => (branches.has(b) ? `${b}-sha` : null),
          createBranch: async (b) => {
            branches.add(b)
          },
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch })
            branches.add(input.branch)
            return { sha: 'commit-sha' }
          },
          openPullRequest: async (input) => {
            opened.push({ head: input.head, base: input.base })
            return {
              repoGithubId: 1,
              number: 7,
              githubId: 700,
              title: input.title,
              state: 'open',
              headRef: input.head,
              baseRef: input.base,
              headSha: null,
              merged: false,
              author: 'bot',
              updatedAt: 0,
              syncedAt: 0,
              url: 'https://github.test/acme/repo/pull/7',
            }
          },
        }
        const app = harness.makeApp(
          {
            customResult: SPIKE_FINDINGS,
            confidence: 1,
            mergeAssessment: { complexity: 0, risk: 0, impact: 0, rationale: 'Docs-only change.' },
          },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_spike',
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        const spikeStep = exec.steps.find((s) => s.agentKind === 'spike')!
        expect(spikeStep.custom).toMatchObject({ recommendation: 'Adopt X behind a flag.' })
        // Findings committed to the per-block WORK branch (not base), and a PR opened onto base.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('cat-factory/task_login')
        expect(opened).toEqual([{ head: 'cat-factory/task_login', base: 'main' }])
        // The engine recorded the opened PR on the block (the RepoOp PR-record seam) so the tail
        // acts on it — a real link, not the projection that drops the URL.
        const block = await app.blockRepository().get(wsId, 'task_login')
        expect(block?.pullRequest?.url).toBe('https://github.test/acme/repo/pull/7')
        expect(block?.pullRequest?.branch).toBe('cat-factory/task_login')
        // The merger merged the recorded PR → the task is `done` (not stalled at pr_ready).
        expect(block?.status).toBe('done')
      })

      it('runs pl_spike_direct to a `done` task with findings committed on the base branch (no PR)', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('pl_spike_direct opens no PR')
          },
        }
        const app = harness.makeApp(
          { customResult: SPIKE_FINDINGS },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_spike_direct',
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const spikeStep = exec.steps.find((s) => s.agentKind === 'spike')!
        expect(spikeStep.custom).toMatchObject({ recommendation: 'Adopt X behind a flag.' })
        // No merger + no PR ⇒ the TASK block finishes `done` via the no-PR completion path.
        expect((await app.blockRepository().get(wsId, 'task_login'))?.status).toBe('done')
        // The post-op committed the rendered findings to `docs/research/*.md` on the BASE branch.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('main')
        expect(commits[0]?.files[0]?.path).toMatch(/^docs\/research\/.+\.md$/)
        expect(commits[0]?.files[0]?.content).toContain('Adopt X behind a flag.')
      })

      it('settles a repo-less pl_spike_direct on step.custom without a commit (docs-only)', async () => {
        // With no repo resolvable (GitHub unwired, or a docs-only spike under an unlinked
        // service) the engine skips the post-op — the findings still settle on `step.custom`
        // and the task reaches `done`, so a research spike never fails just because it has no
        // repo to write its findings to.
        const app = harness.makeApp({ customResult: SPIKE_FINDINGS })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_spike_direct',
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const spikeStep = exec.steps.find((s) => s.agentKind === 'spike')!
        expect(spikeStep.custom).toMatchObject({ recommendation: 'Adopt X behind a flag.' })
        expect((await app.blockRepository().get(wsId, 'task_login'))?.status).toBe('done')
      })

      it('reaches `done` even when the direct findings commit is rejected (best-effort durable copy)', async () => {
        // The findings already settle on `step.custom` (the UI's source of truth), so a repo
        // that refuses the DIRECT write — a protected base branch, a token without push, a
        // transient API error — must NOT discard an otherwise-successful investigation. The
        // post-op swallows the failure (direct mode is best-effort; PR mode is not).
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async () => {
            throw new Error('protected branch: refusing the push')
          },
          openPullRequest: async () => {
            throw new Error('pl_spike_direct opens no PR')
          },
        }
        const app = harness.makeApp(
          { customResult: SPIKE_FINDINGS },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_spike_direct',
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const spikeStep = exec.steps.find((s) => s.agentKind === 'spike')!
        expect(spikeStep.custom).toMatchObject({ recommendation: 'Adopt X behind a flag.' })
        expect((await app.blockRepository().get(wsId, 'task_login'))?.status).toBe('done')
      })
    })

    describe('registered custom gate + step resolver', () => {
      afterEach(() => {
        clearRegisteredGates()
        clearRegisteredStepResolvers()
        // The built-in gates (ci / conflicts / post-release-health) live in the SAME registry
        // as the test's `license-check` gate, so clearing wipes them too — restore them so
        // later assertions (and a real harness build) still see the platform's own gates.
        registerBuiltinGates()
        // NOTE: the agent-kind registry is now app-owned (per-test instance injected via
        // `makeApp({ agentKindRegistry })`), so there is nothing global to clear here.
      })

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
      const registerLicenseGate = (verdicts: boolean[]): void => {
        let i = 0
        registerGate('license-check', (ctx) => ({
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
        registerLicenseGate([true]) // clean on first probe
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'license-fixer'] },
          { agentKindRegistry },
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
        registerLicenseGate([false, true]) // red first, clean after the fixer ran
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'license-fixer'],
            pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
          },
          { agentKindRegistry },
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
        registerStepResolver('conformance-auditor', () => ({
          kind: 'conformance-auditor',
          applies: (result) => result.custom !== undefined,
          resolve: async () => ({ output: 'resolver-rewrote-this' }),
        }))
        const app = harness.makeApp({ customResult: { ok: true } }, { agentKindRegistry })
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
      afterEach(() => clearGateProviders())

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
      afterEach(() => clearGateProviders())

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
      afterEach(() => clearGateProviders())

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
      afterEach(() => clearGateProviders())

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
      afterEach(() => clearGateProviders())

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

    describe('built-in blueprints post-op', () => {
      // The migrated `blueprints` kind dispatches the generic `agent` (read-only structured
      // explore) and returns its tree; the deterministic render + commit of the in-repo
      // `blueprints/` artifact — which used to live in the executor-harness `/blueprint`
      // handler — now runs as a BACKEND built-in post-op over the checkout-free RepoFiles,
      // keyed by the engine's built-in op map (NOT the registry). This asserts the engine
      // runs that post-op + commits identically on every runtime, so a facade that forgot to
      // wire `resolveRunRepoContext` fails here rather than silently dropping the artifact.
      it('renders + commits the blueprints/ artifact via RepoFiles when GitHub is wired', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        const app = harness.makeApp(
          {
            blueprintService: {
              name: 'Widgets',
              summary: 'A widget service.',
              modules: [{ name: 'Billing', summary: 'Invoices', references: ['src/billing.ts'] }],
            },
          },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Map service',
          agentKinds: ['blueprints'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The post-op committed the rendered artifact (no PR open ⇒ the default branch),
        // identically on D1 and Postgres — proving the built-in post-op map is engine-side,
        // not facade-specific.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('main')
        const paths = commits[0]?.files.map((f) => f.path) ?? []
        expect(paths).toContain('blueprints/blueprint.json')
        expect(paths).toContain('blueprints/version.json')
        expect(paths).toContain('blueprints/modules/billing.md')
      })
    })

    describe('built-in spec-writer post-op', () => {
      // The migrated `spec-writer` kind dispatches the generic `agent` (read-only structured
      // explore) and returns the complete spec doc; the deterministic SHARD + commit of the
      // in-repo `spec/` artifact — which used to live in the executor-harness `/spec` handler —
      // now runs as a BACKEND built-in post-op over the checkout-free RepoFiles, onto the
      // per-block WORK branch (not the default branch — the spec merges WITH the feature). This
      // asserts the engine runs that post-op + commits identically on every runtime.
      it('shards + commits the spec/ artifact onto the work branch via RepoFiles', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        const app = harness.makeApp(
          {
            spec: {
              service: 'Widgets',
              summary: 'A widget service.',
              modules: [
                {
                  name: 'Auth',
                  summary: 'Authentication',
                  groups: [
                    {
                      name: 'Login',
                      summary: 'Signing in',
                      requirements: [
                        {
                          title: 'Password login',
                          statement: 'The system SHALL authenticate by password.',
                          kind: 'functional',
                          priority: 'must',
                          acceptance: [
                            { given: 'a user', when: 'they sign in', outcome: 'a session opens' },
                          ],
                        },
                      ],
                      rules: [],
                    },
                  ],
                },
              ],
            },
          },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Write spec',
          agentKinds: ['spec-writer'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The post-op sharded the doc onto the per-block work branch (created from base when
        // absent), identically on D1 and Postgres.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('cat-factory/task_login')
        const paths = commits[0]?.files.map((f) => f.path) ?? []
        expect(paths).toContain('spec/service.json')
        expect(paths).toContain('spec/overview.md')
        expect(paths).toContain('spec/modules/auth/login.json')
        expect(paths).toContain('spec/features/auth/login.feature')
      })
    })

    describe('task estimator + consensus', () => {
      it('parses a task-estimator step output onto block.estimate, persisted identically', async () => {
        const app = harness.makeApp({
          taskEstimate: { complexity: 0.7, risk: 0.8, impact: 0.6, rationale: 'fake estimate' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Estimate + code',
          agentKinds: ['task-estimator', 'coder'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        await app.drive(wsId)

        // The estimator's JSON output round-trips onto the block's `estimate` column —
        // the same shape from D1 (SQLite) and Postgres.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === 'task_login')!
        expect(block.estimate).toBeTruthy()
        expect(block.estimate!.complexity).toBe(0.7)
        expect(block.estimate!.risk).toBe(0.8)
        expect(block.estimate!.impact).toBe(0.6)
        expect(block.estimate!.rationale).toContain('fake estimate')
      })

      describe('technical-label inference (spec phase)', () => {
        // Drive a spec-writer → spec-companion pipeline and assert the engine infers the
        // block's `technical` label from the writer's `noBusinessSpecs` + the companion's
        // `technicalCorroborated`, honouring human authority — identically on both runtimes.
        const runSpecPhase = async (
          opts: { noBusinessSpecs?: boolean; spec?: unknown; technicalCorroborated?: boolean },
          preset?: { technical?: boolean | null },
        ) => {
          const app = harness.makeApp(opts)
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id
          if (preset) {
            await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, preset)
          }
          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Spec phase',
            agentKinds: ['spec-writer', 'spec-companion'],
          })
          const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
            pipelineId: pipeline.body.id,
          })
          expect(start.status).toBe(201)
          await app.drive(wsId)
          const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
          return snapshot.body.blocks.find((b) => b.id === 'task_login')!
        }

        it('infers technical=true when the writer produced no business specs and the companion corroborates', async () => {
          const block = await runSpecPhase({ noBusinessSpecs: true, technicalCorroborated: true })
          expect(block.technical).toBe(true)
        })

        it('infers the symmetric business case (false) when specs were produced', async () => {
          const block = await runSpecPhase({
            spec: { service: 'Auth', summary: '', modules: [] },
            technicalCorroborated: false,
          })
          expect(block.technical).toBe(false)
        })

        it('leaves the label undetermined when the companion gives no opinion', async () => {
          const block = await runSpecPhase({ noBusinessSpecs: true })
          expect(block.technical == null).toBe(true)
        })

        it('never overrides a human-set label', async () => {
          // The human marked it BUSINESS up front; the spec phase would infer TECHNICAL,
          // but human authority wins and the stored value is left untouched.
          const block = await runSpecPhase(
            { noBusinessSpecs: true, technicalCorroborated: true },
            { technical: false },
          )
          expect(block.technical).toBe(false)
        })
      })

      it('persists a consensus config on a pipeline step, surfaced on the snapshot', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Consensus architect',
          agentKinds: ['architect', 'coder'],
          consensus: [
            {
              enabled: true,
              strategy: 'debate',
              rounds: 2,
              participants: [
                { id: 'cp1', role: 'Pragmatist' },
                { id: 'cp2', role: 'Skeptic' },
              ],
              gating: { enabled: true, minRisk: 0.6 },
            },
            null,
          ],
        })
        expect(created.body.consensus?.[0]?.enabled).toBe(true)
        expect(created.body.consensus?.[0]?.strategy).toBe('debate')

        // Round-trips through the store on a fresh snapshot read (D1 + Postgres alike).
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const reloaded = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
        expect(reloaded.consensus?.[0]?.strategy).toBe('debate')
        expect(reloaded.consensus?.[0]?.participants).toHaveLength(2)
        expect(reloaded.consensus?.[1] ?? null).toBeNull()
      })
    })

    describe('human-testing gate', () => {
      // The gate is a runtime-neutral engine step: it parks for a human, dispatches the
      // Tester's `fixer` from findings, and advances on confirm — identically on every
      // facade. The ephemeral-environment provider is NOT wired in the conformance harness,
      // so the gate runs in its degraded (manual) mode — which still exercises all the
      // engine wiring (routing, park, the pendingAction re-entry + signal, helper dispatch
      // via the shared async executor, the recordStepResult helper-completion hook, advance).
      it('parks for a human, dispatches the fixer on request-fix, and advances on confirm', async () => {
        const app = harness.makeApp({
          asyncKinds: ['coder', 'fixer'],
          // The coder opens a PR so the gate's fixer has a branch to push to.
          pullRequest: {
            url: 'https://github.com/o/r/pull/1',
            number: 1,
            branch: 'feat/login',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + human test',
          agentKinds: ['coder', 'human-test'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        // Drive: the coder runs (async), then the human-test gate parks awaiting the human.
        // With no env provider wired the gate is in degraded (manual) mode — no live env.
        let execs = await app.drive(wsId)
        let exec = execs.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        let step = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(step.state).toBe('waiting_decision')
        expect(step.humanTest?.phase).toBe('awaiting_human')
        expect(step.humanTest?.environment ?? null).toBeNull()
        expect(step.humanTest?.degradedReason).toBeTruthy()

        // Request a fix from findings: the gate dispatches the Tester's `fixer` against the
        // PR branch; on its completion the gate re-parks (degraded again, no env to rebuild).
        const fix = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/human-test/request-fix`,
          { findings: 'The login button does nothing.' },
        )
        expect(fix.status).toBe(200)
        execs = await app.drive(wsId)
        exec = execs.find((e) => e.blockId === 'task_login')!
        step = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(step.state).toBe('waiting_decision')
        expect(step.humanTest?.attempts).toBe(1)
        expect(step.humanTest?.rounds?.[0]?.kind).toBe('fix')
        expect(step.humanTest?.rounds?.[0]?.helperKind).toBe('fixer')
        expect(step.humanTest?.rounds?.[0]?.outcome).toBe('completed')

        // Confirm: the gate (the last step) finishes and the run completes.
        const confirm = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/human-test/confirm`,
        )
        expect(confirm.status).toBe(200)
        execs = await app.drive(wsId)
        exec = execs.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const done = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(done.state).toBe('done')
        expect(done.humanTest?.phase).toBe('passed')
      })
    })

    describe('prompt-fragment library (managed catalog)', () => {
      it('lists (200 not 503), creates, edits and removes a tier-owned fragment', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/prompt-fragments`

        // The library module is wired on every facade (the test env opts in): a fresh
        // workspace lists no tier-owned fragments (a 200), not the 503 an unconfigured
        // library returns.
        const initial = await call<{ id: string }[]>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body).toEqual([])

        // Create a hand-authored fragment at the workspace tier.
        const created = await call<{ id: string; title: string }>('POST', base, {
          id: 'perf',
          title: 'Performance',
          summary: 'Keep the hot path allocation-free.',
          body: 'Avoid allocations in the request hot path; prefer streaming.',
          tags: ['backend'],
        })
        expect(created.status).toBe(201)
        expect(created.body.id).toBe('perf')
        expect(created.body.title).toBe('Performance')

        // It lists back at this tier (the merged/built-in catalog is a separate read).
        const listed = await call<{ id: string }[]>('GET', base)
        expect(listed.body.map((f) => f.id)).toEqual(['perf'])

        // Edit its summary.
        const patched = await call<{ summary: string }>('PATCH', `${base}/perf`, {
          summary: 'Keep the hot path allocation-free and streamed.',
        })
        expect(patched.status).toBe(200)
        expect(patched.body.summary).toBe('Keep the hot path allocation-free and streamed.')

        // Remove it; the tier list goes empty again.
        const del = await call('DELETE', `${base}/perf`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ id: string }[]>('GET', base)
        expect(afterDelete.body).toEqual([])
      })
    })
  })
}
