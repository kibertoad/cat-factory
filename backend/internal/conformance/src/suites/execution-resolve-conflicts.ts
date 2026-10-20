import type {
  Block,
  ExecutionInstance,
  MergeabilityVerdict,
  OpenedPullRequest,
  RepoFiles,
  ResolveRunRepoContext,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { makeFakeMergeability } from '../fakeGateProviders.js'
import { mintPublicApiKey } from './shared.js'

// A `resolve-conflicts` task driven entirely through `/api/v1` by a plain `write` key: the door an
// integration with a "Resolve conflicts" button uses. Conformance rather than a unit test because
// the attached pull request rides each facade's block mapper, and the run it starts is driven by
// each facade's own engine wiring.

/** PRs the fake provider knows on `o/r`; any other number is a positive "no such pull request". */
const PULLS: Record<number, Partial<OpenedPullRequest>> = {
  7: {},
  8: { state: 'closed' },
  9: { crossRepository: true },
}

const pullRequest = (number: number): OpenedPullRequest | null => {
  const over = PULLS[number]
  if (!over) return null
  return {
    repoGithubId: 1,
    number,
    githubId: number * 100,
    title: `PR ${number}`,
    state: 'open',
    headRef: `feature/pr-${number}`,
    baseRef: 'main',
    headSha: 'head-sha',
    merged: false,
    author: 'someone',
    updatedAt: null,
    syncedAt: 0,
    url: `https://github.com/o/r/pull/${number}`,
    crossRepository: false,
    ...over,
  }
}

const resolveRunRepoContext: ResolveRunRepoContext = async () => ({
  repo: { getPullRequest: async (n: number) => pullRequest(n) } as unknown as RepoFiles,
  baseBranch: 'main',
  repoId: 'repo_1',
  owner: 'o',
  name: 'r',
})

async function setUp(harness: ConformanceHarness, verdicts: MergeabilityVerdict[]) {
  const app = harness.makeApp(
    { asyncKinds: ['conflict-resolver'] },
    { resolveRunRepoContext, gateProviders: { mergeability: makeFakeMergeability(verdicts) } },
  )
  const { workspace } = await app.createOrgWorkspace({ seed: true })
  const wsId = workspace.id
  const auth = await mintPublicApiKey(app, wsId, 'write', 'resolve-conflicts')
  const frame = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
    type: 'service',
    position: { x: 500, y: 500 },
  })
  return { app, wsId, auth, tasks: `/api/v1/services/${frame.body.id}/tasks` }
}

async function createTask(
  app: ConformanceApp,
  tasks: string,
  auth: Record<string, string>,
  fields: Record<string, unknown>,
) {
  return app.call<{ taskId: string; error?: { details?: { reason?: string } } }>(
    'POST',
    tasks,
    {
      title: 'Resolve conflicts',
      description: 'From the review tool.',
      taskType: 'resolve-conflicts',
      fields,
    },
    auth,
  )
}

async function blockById(
  app: ConformanceApp,
  wsId: string,
  id: string,
): Promise<Block | undefined> {
  const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
  return snap.body.blocks.find((b) => b.id === id)
}

async function startAndDrive(
  app: ConformanceApp,
  wsId: string,
  taskId: string,
  auth: Record<string, string>,
): Promise<ExecutionInstance> {
  const started = await app.call('POST', `/api/v1/tasks/${taskId}/start`, {}, auth)
  expect(started.status).toBe(202)
  return (await app.drive(wsId)).find((e) => e.blockId === taskId)!
}

export function defineResolveConflictsSuite(harness: ConformanceHarness): void {
  describe('resolve-conflicts task (attached pull request)', () => {
    it('refuses a PR it could not push onto, naming why', async () => {
      const { app, auth, tasks } = await setUp(harness, ['mergeable'])
      const reasonFor = async (fields: Record<string, unknown>) => {
        const res = await createTask(app, tasks, auth, fields)
        expect(res.status).toBe(422)
        return res.body.error?.details?.reason
      }
      expect(await reasonFor({ prNumber: 8 })).toBe('attached_pr_not_open')
      expect(await reasonFor({ prNumber: 9 })).toBe('attached_pr_from_fork')
      expect(await reasonFor({ prNumber: 404 })).toBe('attached_pr_not_found')
      expect(await reasonFor({ prUrl: 'https://github.com/other/repo/pull/7' })).toBe(
        'attached_pr_repo_mismatch',
      )
      expect(await reasonFor({})).toBe('task_type_fields_invalid')
    })

    it('attaches the PR, starts on a write key with an empty body, and passes a clean PR as done', async () => {
      const { app, wsId, auth, tasks } = await setUp(harness, ['mergeable'])
      const created = await createTask(app, tasks, auth, { prNumber: 7 })
      expect(created.status).toBe(201)
      const taskId = created.body.taskId
      const block = await blockById(app, wsId, taskId)
      expect(block?.pipelineId).toBe('pl_resolve_conflicts')
      expect(block?.pullRequest).toEqual({
        url: 'https://github.com/o/r/pull/7',
        number: 7,
        branch: 'feature/pr-7',
      })

      const exec = await startAndDrive(app, wsId, taskId, auth)
      expect(exec.status).toBe('done')
      const gate = exec.steps.find((s) => s.agentKind === 'conflicts')
      expect(gate?.state).toBe('done')
      // Already mergeable: nothing was dispatched and nothing pushed.
      expect(gate?.gate?.attempts ?? 0).toBe(0)
      // The PR is somebody else's to merge, so the task finishes without a confirm-and-merge card.
      expect((await blockById(app, wsId, taskId))?.status).toBe('done')
    })

    it('fails the run with a reason once the resolver cannot clear the conflict', async () => {
      const { app, wsId, auth, tasks } = await setUp(harness, ['conflicted'])
      const created = await createTask(app, tasks, auth, { prNumber: 7 })
      const exec = await startAndDrive(app, wsId, created.body.taskId, auth)
      expect(exec.status).toBe('failed')
      const run = await app.call<{ status: string; error: { message: string } | null }>(
        'GET',
        `/api/v1/tasks/${created.body.taskId}/run`,
        undefined,
        auth,
      )
      expect(run.body.status).toBe('failed')
      expect(run.body.error?.message).toContain('could not be resolved automatically')
    })
  })
}
