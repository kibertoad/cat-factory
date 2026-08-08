import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { ConflictError } from '@cat-factory/kernel'
import type {
  AgentRunContext,
  Pipeline,
  RepoFiles,
  SandboxExperiment,
  SandboxFixture,
  SandboxPromptVersion,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defineAgentFragmentConformance } from './agent-fragments.js'
import { defineAgentGateConformance } from './agent-gates.js'
import { defineTaskTypeConformance } from './agent-task-types.js'
import { defineToolServerConformance } from './agent-tool-servers.js'
import { defineValidationChecksConformance } from './validation-checks.js'
import { defineReproductionProofConformance } from './reproduction-proof.js'
import type { ConformanceHarness } from '../harness.js'

export function defineAgentConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    registerSandboxAndCustomKindTests(harness)
    registerKindCapabilityTests(harness)
    defineToolServerConformance(harness)
    defineTaskTypeConformance(harness)
    registerSpikeAndPostOpTests(harness)
    registerEstimatorAndGateTests(harness)
  })
}

/**
 * The prompt/model sandbox surface and a deployment-registered custom kind's pre/post-op
 * stages (the manifest-driven extension model's core contract).
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerSandboxAndCustomKindTests(harness: ConformanceHarness): void {
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
      expect(overview.body.agentKinds.some((k) => k.agentKind === 'requirements-review')).toBe(true)
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

  defineAgentFragmentConformance(harness)

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
        {
          resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }),
          agentKindRegistry,
        },
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
      expect((snap.body.customAgentKinds ?? []).some((k) => k.kind === 'conformance-auditor')).toBe(
        true,
      )

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Compliance audit',
        purpose: 'build',
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
        {
          resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }),
          agentKindRegistry,
        },
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
        purpose: 'build',
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

  // NOTE on the other half of ADR 0029: TOOL SERVERS are deliberately not asserted here, and
  // that is not an oversight to be corrected by adding a case. They resolve inside
  // `ContainerAgentExecutor` (what is servable depends on the resolved harness and the
  // facade-wired credential resolver), and the conformance harness replaces exactly that
  // component with `FakeAgentExecutor` — so a case here would assert the fake, not the runtimes.
  // Their coverage is `packages/server/src/agents/toolServers.test.ts` (resolution, the secret
  // boundary, and the reserved-platform-key floor) plus the harness's own suites.
  //
  // What IS runtime-specific about them — the facades wiring a `ToolSecretResolver` — used to be
  // symmetric by construction, because both hard-coded `createEnvToolSecretResolver`. It no longer
  // is: each facade now takes a `createToolSecretResolver` factory and falls back to that default,
  // so the parity claim is about THREADING an optional field through four links, which a typecheck
  // cannot make and a behavioural test here would still be asserting the fake. It is pinned per
  // facade instead, by the paired structural guards
  // `runtimes/{node,cloudflare}/test/tool-secret-seam.coverage.*`.
}

/**
 * Registered kind capabilities (skills), the agent-failure identity a step records, and a
 * deployment-registered custom task type.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerKindCapabilityTests(harness: ConformanceHarness): void {
  describe('registered kind capabilities (skills)', () => {
    // A registered kind can declare the SKILLS it applies — a bundled playbook shipped in the
    // deployment's own code, or a reference to the account's repo-synced catalog. This asserts
    // the injected registry's declaration reaches the DISPATCHED run context on every runtime:
    // the engine resolves it, so a facade that threads the registry into the HTTP layer but not
    // into the engine fails here rather than shipping an agent that silently works without its
    // playbook. The fake executor stands in for `ContainerAgentExecutor`, whose job body the
    // context is rendered into.
    it('a kind’s bundled skill reaches the dispatched run context', async () => {
      const contexts: AgentRunContext[] = []
      const agentKindRegistry = defaultAgentKindRegistry()
      agentKindRegistry.registerSkill({
        id: 'conformance-playbook',
        name: 'conformance-playbook',
        description: 'How this org audits.',
        instructions: 'Start from the diff.',
        resources: [{ relPath: 'rubric.md', content: '# rubric' }],
      })
      agentKindRegistry.register({
        kind: 'conformance-auditor',
        systemPrompt: 'You audit the service for compliance.',
        agent: { surface: 'container-explore' },
        skills: ['conformance-playbook'],
      })

      const app = harness.makeApp({ onContext: (c) => contexts.push(c) }, { agentKindRegistry })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Compliance audit',
        purpose: 'build',
        agentKinds: ['conformance-auditor'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const executions = await app.drive(wsId)

      const dispatched = contexts.find((c) => c.agentKind === 'conformance-auditor')
      expect(dispatched?.skills?.map((s) => s.skillId)).toEqual(['conformance-playbook'])
      // A bundled skill's resources always carry their bodies (nothing was fetched), and its
      // version is the deployment's — so it is never pinned onto the step.
      expect(dispatched?.skills?.[0]?.origin).toBe('bundled')
      expect(dispatched?.skills?.[0]?.resources[0]?.body).toBe('# rubric')
      const exec = executions.find((e) => e.blockId === 'task_login')
      expect(exec?.steps[0]?.skillVersions).toBeUndefined()
    })

    // The `binary-output` trait is the one trait with a UI consequence: a step of such a kind
    // is REFUSED at pipeline save and at run start without a `stepOptions.binaryOutput`
    // selection, so the pipeline builder has to know which kinds need the picker. Nothing else
    // in the snapshot carries the trait vocabulary, so this asserts the boolean projection
    // reaches the HTTP snapshot — and that it is asked of the REGISTRY, so a trait ASSIGNED to
    // an already-registered kind projects exactly like a declared one. Without it the builder
    // either offers the picker on every step or lets a generator step save into a refusal.
    it('projects the binary-output trait onto the snapshot’s custom-kind palette', async () => {
      const agentKindRegistry = defaultAgentKindRegistry()
      agentKindRegistry.register({
        kind: 'conformance-imager',
        systemPrompt: 'You generate images.',
        agent: { surface: 'container-explore' },
        traits: ['binary-output'],
        presentation: {
          label: 'Conformance Imager',
          icon: 'i-lucide-image',
          color: '#a855f7',
          description: 'Generates product imagery.',
          category: 'build',
        },
      })
      // Registered WITHOUT the trait, then assigned it — the path a deployment takes to opt an
      // existing kind in, and the one a `def.traits` read would miss.
      agentKindRegistry.register({
        kind: 'conformance-assigned-imager',
        systemPrompt: 'You also generate images.',
        agent: { surface: 'container-explore' },
        presentation: {
          label: 'Conformance Assigned Imager',
          icon: 'i-lucide-image',
          color: '#a855f7',
          description: 'Generates product imagery too.',
          category: 'build',
        },
      })
      agentKindRegistry.assignTraits('conformance-assigned-imager', ['binary-output'])
      agentKindRegistry.register({
        kind: 'conformance-auditor',
        systemPrompt: 'You audit the service for compliance.',
        agent: { surface: 'container-explore' },
        presentation: {
          label: 'Conformance Auditor',
          icon: 'i-lucide-shield-check',
          color: '#10b981',
          description: 'Audits the service for compliance.',
          category: 'review',
        },
      })

      const app = harness.makeApp({}, { agentKindRegistry })
      const { workspace } = await app.createWorkspace()
      const snap = await app.call<{
        customAgentKinds?: { kind: string; binaryOutput?: boolean }[]
      }>('GET', `/workspaces/${workspace.id}`)
      const byKind = new Map((snap.body.customAgentKinds ?? []).map((k) => [k.kind, k]))
      expect(byKind.get('conformance-imager')?.binaryOutput).toBe(true)
      expect(byKind.get('conformance-assigned-imager')?.binaryOutput).toBe(true)
      // A kind WITHOUT the trait carries no flag at all — the stock product's shape, so the
      // builder's gate reads false rather than "the field is missing, better show it anyway".
      expect(byKind.get('conformance-auditor')?.binaryOutput).toBeUndefined()
    })
  })

  // B3 (observability-logging-gaps.md): a run that dies on a THROWN error must carry that
  // error's machine-readable `details.reason` onto `AgentFailure.reason`, on BOTH runtimes.
  // The SPA's `AgentFailureCard` branches on that field to offer the remedy (connect a
  // provider, wire the deploy runner); with it dropped the user gets prose to read and no
  // action to take. The Cloudflare driver dropped it on every path and the shared driver
  // dropped it on the advance-THROW path specifically, so this drives the throw path — a
  // pre-op that raises a reasoned `ConflictError` mid-advance — and asserts both the reason
  // and the message survive the trip through each facade's real store.
  describe('failure identity', () => {
    it('propagates a thrown DomainError’s details.reason onto the run’s AgentFailure', async () => {
      const agentKindRegistry = defaultAgentKindRegistry()
      agentKindRegistry.register({
        kind: 'conformance-reasoned-failure',
        systemPrompt: 'You never get to run.',
        agent: { surface: 'container-explore', output: { kind: 'structured' } },
        preOps: [
          () => {
            throw new ConflictError(
              'This pipeline uses models with no configured provider.',
              'providers_unconfigured',
            )
          },
        ],
      })

      // Pre-ops only run once a run-repo context resolves, so wire an inert one — the
      // hook throws before it touches any of these.
      const repo: RepoFiles = {
        getFile: async () => null,
        listDirectory: async () => [],
        headSha: async () => 'base-sha',
        createBranch: async () => {},
        deleteBranch: async () => {},
        commitFiles: async () => ({ sha: 'commit-sha' }),
        openPullRequest: async () => {
          throw new Error('not exercised by this test')
        },
      }
      const app = harness.makeApp(
        {},
        {
          resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }),
          agentKindRegistry,
        },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Reasoned failure',
        purpose: 'build',
        agentKinds: ['conformance-reasoned-failure'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      // The reason is the whole point: it is what a client keys a remedy off, and it has to
      // survive the driver, `failRun`, and the runtime's own failure column mapping.
      expect(exec.failure?.reason).toBe('providers_unconfigured')
      expect(exec.failure?.message ?? '').toContain('no configured provider')
    })
  })
}

/**
 * The spike research pipelines and the built-in blueprints / spec-writer post-ops.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerSpikeAndPostOpTests(harness: ConformanceHarness): void {
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
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
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
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
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
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
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

  defineAgentGateConformance(harness)

  defineValidationChecksConformance(harness)

  defineReproductionProofConformance(harness)

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
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Map service',
        purpose: 'build',
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
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Write spec',
        purpose: 'build',
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
}

/**
 * The tester promotion post-op, the task estimator + consensus panel selection, the
 * human-testing gate, and the managed prompt-fragment catalog.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerEstimatorAndGateTests(harness: ConformanceHarness): void {
  describe('built-in tester promotion post-op', () => {
    // A requirement in `spec/` is `aspirational` (agreed, not yet observed) until a tester
    // actually exercises it. The promotion from `aspirational` → `established` is deterministic
    // backend TS over the checkout-free RepoFiles — NOT a model decision and NOT a side table —
    // so it must fire and commit identically on D1 and Postgres.
    it('promotes a tester-verified requirement to established, committing via RepoFiles', async () => {
      const committed = new Map<string, string>([
        ['spec/service.json', JSON.stringify({ service: 'Widgets', summary: '' }, null, 2) + '\n'],
        [
          'spec/modules/auth/_module.json',
          JSON.stringify({ name: 'Auth', summary: '' }, null, 2) + '\n',
        ],
        [
          'spec/modules/auth/login.json',
          JSON.stringify(
            {
              name: 'Login',
              summary: '',
              requirements: [
                {
                  id: 'req-password-login',
                  title: 'Password login',
                  statement: 'The system SHALL authenticate by password.',
                  kind: 'functional',
                  priority: 'must',
                  state: 'aspirational',
                  sourceBlockIds: [],
                  acceptance: [
                    {
                      id: 'req-password-login-ac-1',
                      given: 'a user',
                      when: 'they sign in',
                      outcome: 'a session opens',
                    },
                  ],
                },
              ],
              rules: [],
            },
            null,
            2,
          ) + '\n',
        ],
      ])
      const commits: { branch: string; files: { path: string; content: string }[] }[] = []
      const repo: RepoFiles = {
        getFile: async (path) => {
          const content = committed.get(path)
          return content === undefined ? null : { content, sha: 'sha' }
        },
        listDirectory: async (path) => {
          const prefix = `${path.replace(/\/+$/, '')}/`
          const files = new Set<string>()
          const dirs = new Set<string>()
          for (const p of committed.keys()) {
            if (!p.startsWith(prefix)) continue
            const rest = p.slice(prefix.length)
            const slash = rest.indexOf('/')
            if (slash === -1) files.add(p)
            else dirs.add(`${prefix}${rest.slice(0, slash)}`)
          }
          return [
            ...[...files].map((p) => ({
              path: p,
              name: p.split('/').pop()!,
              type: 'file' as const,
              sha: 'sha',
            })),
            ...[...dirs].map((p) => ({
              path: p,
              name: p.split('/').pop()!,
              type: 'dir' as const,
              sha: 'sha',
            })),
          ]
        },
        headSha: async () => 'base-sha',
        createBranch: async () => {},
        deleteBranch: async () => {},
        commitFiles: async (input) => {
          commits.push({ branch: input.branch, files: input.files })
          for (const f of input.files) committed.set(f.path, f.content)
          return { sha: 'commit-sha' }
        },
        openPullRequest: async () => {
          throw new Error('not exercised by this test')
        },
      }

      const app = harness.makeApp(
        {
          testReports: [
            {
              greenlight: true,
              summary: 'exercised the login flow',
              tested: ['password login'],
              outcomes: [{ name: 'password login', status: 'passed', detail: 'a session opened' }],
              concerns: [],
              requirementVerdicts: [
                { requirementId: 'req-password-login', status: 'met', detail: 'observed' },
              ],
            },
          ],
        },
        { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Test only',
        purpose: 'build',
        agentKinds: ['tester-api'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')

      // The verified requirement is now standing behaviour, on both runtimes.
      expect(commits).toHaveLength(1)
      const shard = commits[0]!.files.find((f) => f.path === 'spec/modules/auth/login.json')
      expect(shard).toBeDefined()
      expect(JSON.parse(shard!.content).requirements[0].state).toBe('established')
      // BRANCH, pinned deliberately: this pipeline opens no PR, so the promotion lands on the
      // base branch. That is the intended reading of a tester-only regression sweep — the
      // tester exercised THAT tree, and there is no PR to defer the bookkeeping to. A run
      // that does open a PR promotes on the PR branch instead, so it is reviewed in the same
      // spec diff as the requirement it promotes (see `RunRepoOpsController`).
      expect(commits[0]!.branch).toBe('main')
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
        purpose: 'build',
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
          purpose: 'build',
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
        purpose: 'build',
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
        purpose: 'build',
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
}
