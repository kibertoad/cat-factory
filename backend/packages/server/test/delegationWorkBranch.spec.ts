import type {
  AgentRunContext,
  DelegatedExecutorDefinition,
  DelegationBrief,
  RepoFiles,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import type { AprioriBranch } from '@cat-factory/contracts'
import {
  DomainError,
  defaultDelegatedExecutorRegistry,
  getErrorMessage,
  noopLogger,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { buildDelegatedAgentExecutor } from '../src/agents/delegatedExecutorHost.js'
import { githubRepoOrigin } from '../src/agents/containerAgentBody.js'

// WHO CREATES THE WORK BRANCH, which before this declaration was nobody.
//
// A container step's work branch comes into existence as part of the harness's own clone. Nothing
// did that for a delegated step, so an external CI system told to check out `branches.work` failed
// at checkout, and a runner that substitutes a branch of its own on a missing ref succeeded on a
// branch the platform never recorded. What is asserted here: the declaration is honoured, every
// way the write can fail is refused under its own reason rather than the executor's, and a branch
// the TASK named is probed rather than created.

const REPO = {
  installationId: 7,
  repoId: '1001',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}

interface FakeRepo {
  repoFiles: RepoFiles
  created: { branch: string; fromSha: string }[]
}

/**
 * A `RepoFiles` over an in-memory ref table.
 *
 * `heads` is the repository's state, so a test says what exists by naming it rather than by
 * scripting a call sequence: the idempotence assertions below are about what the engine does with
 * a ref that is already there, which a call counter cannot express.
 */
function fakeRepoFiles(
  heads: Record<string, string>,
  onCreate?: (branch: string) => void,
): FakeRepo {
  const created: { branch: string; fromSha: string }[] = []
  const repoFiles = {
    async headSha(branch: string) {
      return heads[branch] ?? null
    },
    async createBranch(branch: string, fromSha: string) {
      onCreate?.(branch)
      created.push({ branch, fromSha })
      heads[branch] = fromSha
    },
  } as unknown as RepoFiles
  return { repoFiles, created }
}

function runRepoContext(repoFiles: RepoFiles): ResolveRunRepoContext {
  return async () => ({ repo: repoFiles, baseBranch: 'main', repoId: '1001' })
}

function build(
  workBranch: DelegatedExecutorDefinition['workBranch'],
  resolveRunRepoContext?: ResolveRunRepoContext,
  onStart?: () => void,
  aprioriBranches?: AprioriBranch[],
): { start: () => Promise<void>; starts: DelegationBrief[] } {
  const agentKindRegistry = defaultAgentKindRegistry()
  agentKindRegistry.register({
    kind: 'acme:impl',
    systemPrompt: 'implement it',
    agent: { surface: 'delegated', executor: 'acme:executor' },
  })
  const starts: DelegationBrief[] = []
  const executors = defaultDelegatedExecutorRegistry()
  executors.register({
    id: 'acme:executor',
    presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
    poll: { intervalMs: 1000, maxDurationMs: 60_000 },
    telemetry: 'not-reported',
    workBranch,
    create: () => ({
      async start(brief) {
        onStart?.()
        starts.push(brief)
        return { externalId: 'run-99' }
      },
      async poll() {
        return { state: 'running' as const }
      },
    }),
  })
  const executor = buildDelegatedAgentExecutor({
    delegatedExecutorRegistry: executors,
    agentKindRegistry,
    resolveRepoTarget: async () => REPO,
    resolveRepoOrigin: githubRepoOrigin,
    ...(resolveRunRepoContext ? { resolveRunRepoContext } : {}),
    urlSafetyPolicy: undefined,
    logger: noopLogger,
    clock: { now: () => 0 },
  })
  return {
    start: async () => {
      await executor.startJob(context(aprioriBranches))
    },
    starts,
  }
}

function context(aprioriBranches?: AprioriBranch[]): AgentRunContext {
  return {
    agentKind: 'acme:impl',
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Do it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...(aprioriBranches ? { aprioriBranches } : {}),
  }
}

/** The `details.reason` a refusal carries, which is what the SPA maps to translated copy. */
function reasonOf(error: unknown): string | undefined {
  return error instanceof DomainError
    ? (error.details as { reason?: string } | undefined)?.reason
    : undefined
}

describe("workBranch: 'platform-creates'", () => {
  it('creates the work branch at the base head before the executor is called', async () => {
    const heads: Record<string, string> = { main: 'sha-main' }
    const repo = fakeRepoFiles(heads)
    const workHeadAtStart: (string | undefined)[] = []
    const { start, starts } = build('platform-creates', runRepoContext(repo.repoFiles), () => {
      workHeadAtStart.push(heads['cat-factory/blk_1'])
    })
    await start()
    expect(repo.created).toEqual([{ branch: 'cat-factory/blk_1', fromSha: 'sha-main' }])
    expect(starts).toHaveLength(1)
    // BEFORE, not after: the dispatch is fire-and-forget and the external checkout happens on the
    // other system's schedule, so a ref created afterwards races a job that has already failed.
    expect(workHeadAtStart).toEqual(['sha-main'])
  })

  it('leaves an existing work branch alone, so a replayed dispatch writes nothing', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main', 'cat-factory/blk_1': 'sha-work' })
    const { start } = build('platform-creates', runRepoContext(repo.repoFiles))
    await start()
    await start()
    expect(repo.created).toEqual([])
  })

  it('accepts a lost race when the winner left the branch there', async () => {
    // Settled by CONTENT rather than by reading a provider's refusal: GitHub answers a lost create
    // 422 and GitLab 400, and neither status distinguishes "somebody else made it" from "this
    // write failed". Re-reading the ref answers the only question that matters.
    const heads: Record<string, string> = { main: 'sha-main' }
    const repo = fakeRepoFiles(heads, (branch) => {
      heads[branch] = 'sha-from-the-winner'
      throw new Error('422 Reference already exists')
    })
    const { start, starts } = build('platform-creates', runRepoContext(repo.repoFiles))
    await start()
    expect(starts).toHaveLength(1)
  })

  it('refuses the dispatch when the create genuinely failed', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' }, () => {
      throw new Error('403 Resource not accessible by integration')
    })
    const { start, starts } = build('platform-creates', runRepoContext(repo.repoFiles))
    await expect(start()).rejects.toMatchObject({ code: 'unavailable' })
    // Refused rather than dispatched anyway: the executor said its system cannot make the branch.
    expect(starts).toEqual([])
  })

  it('names the branch failure as its own reason, not as the executor failing', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' }, () => {
      throw new Error('403 Resource not accessible by integration')
    })
    const { start } = build('platform-creates', runRepoContext(repo.repoFiles))
    // `delegated_executor_failed` would send an operator to the external system's logs, and the
    // external system was never contacted.
    await expect(start().catch((error: unknown) => reasonOf(error))).resolves.toBe(
      'delegated_work_branch_unprepared',
    )
  })

  it('refuses when the recorded base branch is not in the repository', async () => {
    // Never forked from the default branch instead: a service whose recorded base is wrong would
    // then produce every change against a branch nobody chose.
    const repo = fakeRepoFiles({})
    const { start } = build('platform-creates', runRepoContext(repo.repoFiles))
    await expect(start().catch((error: unknown) => reasonOf(error))).resolves.toBe(
      'delegated_work_branch_unprepared',
    )
    expect(repo.created).toEqual([])
  })

  it('refuses the DISPATCH on a deployment that configured no VCS provider', async () => {
    // At the dispatch, not at the build: the arm is built inside the Worker's per-request
    // container assembly, so refusing there would 500 the board, the API and the settings page an
    // operator would go and fix this on. Here it costs exactly the step that needed the branch.
    const { start, starts } = build('platform-creates')
    await expect(start().catch((error: unknown) => reasonOf(error))).resolves.toBe(
      'delegated_work_branch_unprepared',
    )
    expect(starts).toEqual([])
  })

  it('wraps a failing PROBE in the same reason as a failing write', async () => {
    // Unwrapped, the SPA has nothing to map and the operator reads the generic 500 copy, which
    // reads as an engine bug rather than as the provider blip it was.
    const repo = fakeRepoFiles({ main: 'sha-main' })
    repo.repoFiles.headSha = () => Promise.reject(new Error('502 Bad Gateway'))
    const { start } = build('platform-creates', runRepoContext(repo.repoFiles))
    await expect(start().catch((error: unknown) => reasonOf(error))).resolves.toBe(
      'delegated_work_branch_unprepared',
    )
  })

  it('keeps the CREATE failure when the race re-read fails too', async () => {
    // The re-read exists only to tell a lost race from a failed write. Letting it throw would
    // replace the actionable cause (the app lacks write access) with a probe error naming nothing.
    const repo = fakeRepoFiles({ main: 'sha-main' })
    const head = repo.repoFiles.headSha.bind(repo.repoFiles)
    let probes = 0
    repo.repoFiles.headSha = (branch: string) =>
      ++probes > 2 ? Promise.reject(new Error('502 Bad Gateway')) : head(branch)
    repo.repoFiles.createBranch = () =>
      Promise.reject(new Error('403 Resource not accessible by integration'))
    const { start } = build('platform-creates', runRepoContext(repo.repoFiles))
    const error = await start().catch((e: unknown) => e)
    expect(reasonOf(error)).toBe('delegated_work_branch_unprepared')
    expect(getErrorMessage(error)).toContain('403 Resource not accessible by integration')
  })
})

describe('a task that names its own working branch', () => {
  const APRIORI: AprioriBranch[] = [{ name: 'feature/spike', mode: 'working' }]

  it('dispatches onto the branch the task named, not `cat-factory/<blockId>`', async () => {
    // The pull request, the `ci` gate and the merger all ride the task's branch, so a dispatch
    // onto the derived one lands the external work on a ref nothing downstream looks at.
    const repo = fakeRepoFiles({ main: 'sha-main', 'feature/spike': 'sha-spike' })
    const built = build('platform-creates', runRepoContext(repo.repoFiles), undefined, APRIORI)
    await built.start()
    expect(built.starts[0]?.branches.work).toBe('feature/spike')
    // And NOTHING was created: the platform never creates a branch a task named, because an empty
    // ref where the user's branch should be looks exactly like the run ignoring their choice.
    expect(repo.created).toEqual([])
  })

  it('refuses the dispatch when that branch is not in the repository', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' })
    const built = build('platform-creates', runRepoContext(repo.repoFiles), undefined, APRIORI)
    await expect(built.start().catch((error: unknown) => reasonOf(error))).resolves.toBe(
      'delegated_work_branch_unprepared',
    )
    expect(repo.created).toEqual([])
    expect(built.starts).toEqual([])
  })

  it('names it on the brief for an executor that makes its own branch too', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' })
    const built = build('executor-creates', runRepoContext(repo.repoFiles), undefined, APRIORI)
    await built.start()
    expect(built.starts[0]?.branches.work).toBe('feature/spike')
  })
})

describe("workBranch: 'executor-creates'", () => {
  it('writes nothing, so a run whose work never landed leaves no empty ref', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' })
    const { start, starts } = build('executor-creates', runRepoContext(repo.repoFiles))
    await start()
    expect(repo.created).toEqual([])
    expect(starts).toHaveLength(1)
  })

  it('dispatches on a deployment that configured no VCS provider at all', async () => {
    const { start, starts } = build('executor-creates')
    await start()
    expect(starts).toHaveLength(1)
  })
})

describe('the brief', () => {
  it('names the block the repo-files resolver is keyed by', async () => {
    const repo = fakeRepoFiles({ main: 'sha-main' })
    const { start, starts } = build('executor-creates', runRepoContext(repo.repoFiles))
    await start()
    // The dispatch is the only moment "before starting" exists, so an executor staging its own
    // context layer needs the key there rather than on the handle alone.
    expect(starts[0]?.blockId).toBe('blk_1')
  })
})
