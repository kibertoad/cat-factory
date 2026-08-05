import { describe, expect, it } from 'vitest'
import type {
  AgentRunContext,
  ExecutionInstance,
  Pipeline,
  RepoContentEntry,
  RepoFiles,
} from '@cat-factory/kernel'
import type {
  DetectedValidationChecks,
  ServiceValidationConfig,
  ValidationReport,
} from '@cat-factory/contracts'
import type { ConformanceHarness } from '../harness.js'

// PRE-PR VALIDATION conformance (docs/initiatives/pre-pr-validation.md).
//
// A service frame declares check commands; a PR-opening coding dispatch must carry them so the
// executor-harness can run them against the checkout BEFORE opening a pull request. Two halves
// have to behave identically on D1 and Postgres:
//
//  1. CONFIG RESOLUTION — the row is stored/read the same way, and a TASK's dispatch resolves the
//     commands by walking UP to its service frame (the config lives on the frame, never the task).
//  2. JOB-BODY THREADING — the resolved commands land on the `AgentRunContext` the container
//     executor turns into the harness job body. The `FakeAgentExecutor` stands in for that
//     executor, so its `onContext` observer is where the suite sees what would have ridden the
//     body. And the report the harness sends back is recorded on the step.
//
// The unconfigured case is asserted too, because "no config ⇒ byte-for-byte current behaviour" is
// the feature's core compatibility promise: a facade that resolved an empty config into the body
// (or wired the resolver only on one runtime) fails here rather than shipping.
export function defineValidationChecksConformance(harness: ConformanceHarness): void {
  describe('pre-PR validation checks', () => {
    /** Save a service frame's checks over the real HTTP route. */
    const saveChecks = async (
      app: ReturnType<ConformanceHarness['makeApp']>,
      wsId: string,
      blockId: string,
      body: {
        checks: { label: string; command: string }[]
        maxAttempts?: number
        dependencyInstall?: string
      },
    ) =>
      app.call<ServiceValidationConfig>(
        'PUT',
        `/workspaces/${wsId}/services/${blockId}/validation-checks`,
        body,
      )

    /** A single-step coder pipeline — the PR-opening dispatch the feature gates. */
    const coderPipeline = async (app: ReturnType<ConformanceHarness['makeApp']>, wsId: string) =>
      (
        await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
      ).body

    it('stores, reads back and lists a service frame’s checks', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const saved = await saveChecks(app, wsId, 'blk_auth', {
        checks: [
          { label: 'lint', command: 'pnpm lint' },
          { label: 'test', command: 'pnpm test' },
        ],
        maxAttempts: 4,
      })
      expect(saved.status).toBe(200)
      expect(saved.body.checks).toEqual([
        { label: 'lint', command: 'pnpm lint' },
        { label: 'test', command: 'pnpm test' },
      ])
      expect(saved.body.maxAttempts).toBe(4)

      // Read back through the per-block route + the workspace listing (both hit the store).
      const read = await app.call<ServiceValidationConfig>(
        'GET',
        `/workspaces/${wsId}/services/blk_auth/validation-checks`,
      )
      expect(read.body.checks).toHaveLength(2)
      expect(read.body.maxAttempts).toBe(4)

      const list = await app.call<ServiceValidationConfig[]>(
        'GET',
        `/workspaces/${wsId}/validation-checks`,
      )
      expect(list.body.map((c) => c.blockId)).toContain('blk_auth')
    })

    it('defaults the attempt budget and clears the config on an empty list', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const saved = await saveChecks(app, wsId, 'blk_auth', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
      })
      expect(saved.body.maxAttempts).toBe(3)

      // An empty list DELETES the row — a cleared inspector must restore the exact pre-feature
      // behaviour, not leave an empty config that still has to be resolved on every dispatch.
      const cleared = await saveChecks(app, wsId, 'blk_auth', { checks: [] })
      expect(cleared.body.checks).toEqual([])
      const list = await app.call<ServiceValidationConfig[]>(
        'GET',
        `/workspaces/${wsId}/validation-checks`,
      )
      expect(list.body.map((c) => c.blockId)).not.toContain('blk_auth')
    })

    describe('dependency prepopulation', () => {
      // The install shares the per-frame row with the checks but is INDEPENDENT of them, so both
      // runtimes have to agree on three things a single-runtime test would not catch: the column
      // round-trips, an install-only config SURVIVES a save with no checks, and it reaches the
      // dispatched context. See docs/initiatives/agent-dependency-prepopulation.md.
      it('round-trips the install alongside the checks', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const saved = await saveChecks(app, wsId, 'blk_auth', {
          checks: [{ label: 'lint', command: 'pnpm lint' }],
          dependencyInstall: 'pnpm install --frozen-lockfile',
        })
        expect(saved.body.dependencyInstall).toBe('pnpm install --frozen-lockfile')

        const list = await app.call<ServiceValidationConfig[]>(
          'GET',
          `/workspaces/${wsId}/validation-checks`,
        )
        expect(list.body.find((c) => c.blockId === 'blk_auth')?.dependencyInstall).toBe(
          'pnpm install --frozen-lockfile',
        )
      })

      it('keeps an install-only config, and clears the row only when BOTH are empty', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // No checks at all — prepopulate the checkout, verify nothing. A delete rule keyed on
        // `checks` alone would drop this the moment it was saved, on precisely the repo shape
        // the feature exists for.
        const saved = await saveChecks(app, wsId, 'blk_auth', {
          checks: [],
          dependencyInstall: 'pnpm install',
        })
        expect(saved.body.checks).toEqual([])
        expect(saved.body.dependencyInstall).toBe('pnpm install')
        const kept = await app.call<ServiceValidationConfig[]>(
          'GET',
          `/workspaces/${wsId}/validation-checks`,
        )
        expect(kept.body.map((c) => c.blockId)).toContain('blk_auth')

        const cleared = await saveChecks(app, wsId, 'blk_auth', { checks: [] })
        expect(cleared.body.dependencyInstall).toBeUndefined()
        const list = await app.call<ServiceValidationConfig[]>(
          'GET',
          `/workspaces/${wsId}/validation-checks`,
        )
        expect(list.body.map((c) => c.blockId)).not.toContain('blk_auth')
      })

      it('threads an install-only frame config onto a task’s dispatched context', async () => {
        const contexts: AgentRunContext[] = []
        const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await saveChecks(app, wsId, 'blk_auth', {
          checks: [],
          dependencyInstall: 'pnpm install --frozen-lockfile',
        })

        const pipeline = await coderPipeline(app, wsId)
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.id,
        })
        await app.drive(wsId)

        const coderContext = contexts.find((c) => c.agentKind === 'coder')
        expect(coderContext?.dependencyInstall).toBe('pnpm install --frozen-lockfile')
        // Independent of the checks: the frame declared none, so nothing gates the PR.
        expect(coderContext?.validationChecks?.checks ?? []).toEqual([])
      })

      it('carries no install when the service declared none', async () => {
        const contexts: AgentRunContext[] = []
        const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await coderPipeline(app, wsId)
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.id,
        })
        await app.drive(wsId)

        const coderContext = contexts.find((c) => c.agentKind === 'coder')
        expect(coderContext).toBeDefined()
        expect(coderContext?.dependencyInstall).toBeUndefined()
      })
    })

    it('refuses checks on a non-frame block (they would never be resolved)', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      // `task_login` is a TASK inside `blk_auth`. Resolution only ever walks UP to the frame, so
      // a config stored here would silently never run — reject it at the write boundary instead.
      const res = await saveChecks(app, workspace.id, 'task_login', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
      })
      expect(res.status).toBe(422)
    })

    it('threads a task’s SERVICE-FRAME checks onto the dispatched agent context', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Configured on the FRAME; the run is on a TASK inside it — the frame-chain walk is the
      // thing under test (a facade that keyed resolution off the run block would see nothing).
      await saveChecks(app, wsId, 'blk_auth', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
        maxAttempts: 2,
      })

      const pipeline = await coderPipeline(app, wsId)
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      expect(start.status).toBe(201)
      await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.validationChecks).toEqual({
        checks: [{ label: 'lint', command: 'pnpm lint' }],
        maxAttempts: 2,
      })
    })

    it('carries NO checks when the service configured none (unchanged behaviour)', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs = await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext).toBeDefined()
      // Absent — not an empty object — so the job body carries no `validationChecks` field at all
      // and the harness runs the code path it ran before this feature existed.
      expect(coderContext?.validationChecks).toBeUndefined()
      // And the run itself is unaffected.
      const exec = execs.find((e) => e.blockId === 'task_login')
      expect(exec?.status).toBe('done')
      expect(exec?.steps[0]?.validation ?? null).toBeNull()
    })

    it('records the harness’s validation report on the step', async () => {
      const report: ValidationReport = {
        passed: true,
        attempts: 2,
        maxAttempts: 3,
        at: 1700,
        outcomes: [
          {
            label: 'lint',
            command: 'pnpm lint',
            exitCode: 0,
            passed: true,
            outputTail: 'all clean',
            durationMs: 120,
          },
        ],
      }
      const app = harness.makeApp({ validationReport: report })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await saveChecks(app, wsId, 'blk_auth', { checks: [{ label: 'lint', command: 'pnpm lint' }] })

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs: ExecutionInstance[] = await app.drive(wsId)
      const exec = execs.find((e) => e.blockId === 'task_login')

      // The captured proof the checkout was green before the PR opened — persisted on the step's
      // `detail` blob, so it survives a reload and both runtimes must round-trip it identically.
      expect(exec?.steps[0]?.validation?.passed).toBe(true)
      expect(exec?.steps[0]?.validation?.attempts).toBe(2)
      expect(exec?.steps[0]?.validation?.outcomes[0]).toMatchObject({
        label: 'lint',
        exitCode: 0,
        outputTail: 'all clean',
      })
    })

    // AUTODETECTION. The rules themselves are unit-tested in kernel; what has to hold
    // identically on every runtime is the WIRING — the endpoint reaches the repo through the
    // same `resolveRunRepoContext` seam the engine binds pre/post-ops with, and states the
    // no-repo case rather than returning an empty list that reads as "nothing recognised".
    describe('autodetection', () => {
      const detect = (app: ReturnType<ConformanceHarness['makeApp']>, wsId: string) =>
        app.call<DetectedValidationChecks>(
          'GET',
          `/workspaces/${wsId}/services/blk_auth/validation-checks/detect`,
        )

      /** An in-memory repo root: one listing plus the manifests the detector asks for. */
      const fakeRepo = (files: Record<string, string>): RepoFiles => ({
        listDirectory: async () =>
          Object.keys(files).map((name): RepoContentEntry => ({
            path: name,
            name,
            type: 'file',
            sha: `sha-${name}`,
          })),
        getFile: async (path) =>
          files[path] === undefined ? null : { content: files[path], sha: `sha-${path}` },
        headSha: async () => 'base-sha',
        createBranch: async () => {},
        deleteBranch: async () => {},
        commitFiles: async () => ({ sha: 'commit-sha' }),
        openPullRequest: async () => {
          throw new Error('not exercised by this test')
        },
      })

      it('suggests checks from the service repo’s manifests', async () => {
        const repo = fakeRepo({
          'package.json': JSON.stringify({
            packageManager: 'pnpm@9.0.0',
            scripts: { lint: 'oxlint .', build: 'tsc -b', test: 'vitest' },
          }),
          'pnpm-lock.yaml': 'lockfileVersion: 9',
        })
        const app = harness.makeApp(
          {},
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }) },
        )
        const { workspace } = await app.createWorkspace()

        const res = await detect(app, workspace.id)
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('ok')
        expect(res.body.ecosystems).toEqual(['node'])
        expect(res.body.checks).toEqual([
          { label: 'install', command: 'pnpm install --frozen-lockfile' },
          { label: 'lint', command: 'pnpm run lint' },
          { label: 'build', command: 'pnpm run build' },
          { label: 'test', command: 'pnpm run test' },
        ])
        // The same read also suggests the dependency-prepopulation install, so pressing Detect
        // once fills both halves of the panel.
        expect(res.body.dependencyInstall).toBe('pnpm install --frozen-lockfile')

        // Detection is a SUGGESTION: it must not have written the service's config, or the
        // operator's next board load would claim checks no run was ever told to run.
        const list = await app.call<ServiceValidationConfig[]>(
          'GET',
          `/workspaces/${workspace.id}/validation-checks`,
        )
        expect(list.body.map((c) => c.blockId)).not.toContain('blk_auth')
      })

      it('reports an unlinked repo as such rather than as an empty result', async () => {
        // No `resolveRunRepoContext` wired — the same shape a workspace with no VCS
        // connection produces. The status is what lets the panel say WHY it found nothing.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()

        const res = await detect(app, workspace.id)
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
          status: 'repo_unavailable',
          ecosystems: [],
          checks: [],
          truncated: false,
        })
      })
    })
  })
}
