import type {
  AgentRunContext,
  DelegatedExecutorDefinition,
  DelegationBrief,
  RepoFiles,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import {
  DelegatedExecutorRegistrationError,
  DomainError,
  defaultDelegatedExecutorRegistry,
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
// branch the platform never recorded. Both halves are asserted here: the declaration is honoured,
// and the executor that declared it cannot be registered on a facade with nothing to write with.

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
      await executor.startJob(context())
    },
    starts,
  }
}

function context(): AgentRunContext {
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

  it('refuses the BUILD on a facade that wired no repository client', async () => {
    // At the entry point, not at the dispatch: the alternative is a registration that boots clean
    // and refuses every run of that executor hours later, naming a branch instead of the wiring.
    expect(() => build('platform-creates')).toThrow(DelegatedExecutorRegistrationError)
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

  it('builds on a facade with no repository client at all', () => {
    expect(() => build('executor-creates')).not.toThrow()
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
