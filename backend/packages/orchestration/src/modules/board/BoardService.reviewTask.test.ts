import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, OpenedPullRequest, RepoFiles, RunRepoContext } from '@cat-factory/kernel'
import { createRecordingLogger, DomainError } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

const WS = 'ws_1'

/** The one service frame every case creates its task under. */
const frameBlock = (): Block => ({
  id: 'frame_svc',
  title: 'Service',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'ready',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'frame',
  parentId: null,
})

/** Blocks the fake repository inserts, so a case can assert nothing was written on a refusal. */
let inserted: Block[]

function build(extra?: Partial<BoardServiceDependencies>) {
  inserted = []
  const byId = new Map([[frameBlock().id, frameBlock()]])
  const deps = {
    workspaceRepository: { get: async (id: string) => ({ id }) },
    blockRepository: {
      get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
      listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
      insert: async (block: Block) => {
        inserted.push(block)
      },
    },
    serviceRepository: { getByFrameBlock: async () => null },
    idGenerator: { next: (prefix: string) => `${prefix}_new` },
    clock: { now: () => 0 },
    executionEventPublisher: {
      async executionChanged() {},
      async boardChanged() {},
      async bootstrapChanged() {},
      async notificationChanged() {},
      async llmCallObserved() {},
    },
  } as unknown as BoardServiceDependencies
  return new BoardService({ ...deps, ...extra })
}

/** A run-repo context whose bound repo answers `getPullRequest` however the case says. */
function repoContext(
  getPullRequest: RepoFiles['getPullRequest'],
  repo: { owner?: string; name?: string } = { owner: 'o', name: 'r' },
): RunRepoContext {
  return {
    repo: (getPullRequest ? { getPullRequest } : {}) as unknown as RepoFiles,
    baseBranch: 'main',
    repoId: 'repo_1',
    ...repo,
  }
}

const openPr = (number: number, url: string): OpenedPullRequest =>
  ({ number, url }) as OpenedPullRequest

// A `review` task targets an EXISTING open PR. BoardService.addTask folds the PR reference
// (URL or #number) and any review focus into the task description, so the read-only
// `pr-reviewer` (which reads the target from its prompt) knows WHICH PR to review. It also
// pins the review task to the PR-review pipeline. These pin that folding + default.
describe('BoardService review-task description folding', () => {
  it('folds the PR URL + focus preamble ahead of the description and pins pl_review', async () => {
    const task = await build().addTask(
      WS,
      'frame_svc',
      {
        title: 'Review the auth PR',
        taskType: 'review',
        description: 'Extra notes.',
        taskTypeFields: {
          prUrl: 'https://github.com/o/r/pull/7',
          reviewFocus: 'the token refresh',
        },
      },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(task.description).toBe(
      'Review pull request https://github.com/o/r/pull/7. Review focus: the token refresh\n\nExtra notes.',
    )
    // A review task defaults to the PR-review pipeline.
    expect(task.pipelineId).toBe('pl_review')
  })

  it('uses #number when only prNumber is given, with no trailing description', async () => {
    const task = await build().addTask(
      WS,
      'frame_svc',
      {
        title: 'Review PR 42',
        taskType: 'review',
        taskTypeFields: { prNumber: 42 },
      },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(task.description).toBe('Review pull request #42.')
  })

  it('prefers prUrl over prNumber when both are present', async () => {
    const task = await build().addTask(
      WS,
      'frame_svc',
      {
        title: 'Review',
        taskType: 'review',
        taskTypeFields: { prUrl: 'https://github.com/o/r/pull/9', prNumber: 42 },
      },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(task.description).toBe('Review pull request https://github.com/o/r/pull/9.')
  })
})

// A review task targets an EXISTING pull request, so the reference is validated against the very
// repo the review will run against BEFORE the block is written — and the confirmed PR's own web
// url is what the task records. These pin the refusal, the canonicalisation, and (just as
// important) every case that must NOT refuse.
describe('BoardService review-task PR validation', () => {
  const addReviewTask = (service: BoardService, taskTypeFields: Record<string, unknown>) =>
    service.addTask(
      WS,
      'frame_svc',
      { title: 'Review', taskType: 'review', taskTypeFields },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )

  it('refuses a PR the provider reports as absent, before creating the block', async () => {
    const service = build({ resolveRunRepoContext: async () => repoContext(async () => null) })
    const error = await addReviewTask(service, { prNumber: 4242 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('validation')
    expect((error as DomainError).details).toMatchObject({
      reason: 'review_pr_not_found',
      prNumber: 4242,
    })
    // Refused BEFORE the write: no half-created review task pointing at nothing.
    expect(inserted).toHaveLength(0)
  })

  it('canonicalises a bare number to the provider url it confirmed, and folds that in', async () => {
    const service = build({
      resolveRunRepoContext: async () =>
        repoContext(async (n) => openPr(n, `https://github.com/o/r/pull/${n}`)),
    })
    const task = await addReviewTask(service, { prNumber: 42 })
    expect(task.taskTypeFields).toMatchObject({
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
    })
    expect(task.description).toBe('Review pull request https://github.com/o/r/pull/42.')
  })

  it('refuses a prUrl naming a different repo than the one this service reviews', async () => {
    const probed: number[] = []
    const service = build({
      resolveRunRepoContext: async () =>
        repoContext(async (n) => {
          probed.push(n)
          return openPr(n, `https://github.com/o/r/pull/${n}`)
        }),
    })
    const error = await addReviewTask(service, {
      prUrl: 'https://github.com/other/repo/pull/42',
    }).catch((e: unknown) => e)
    expect((error as DomainError).details).toMatchObject({
      reason: 'review_pr_repo_mismatch',
      expected: 'o/r',
    })
    // Refused on the mismatch alone — never "validated" against the same number on OUR repo,
    // which is exactly the silent retarget this check exists to prevent.
    expect(probed).toEqual([])
  })

  it('accepts a prUrl on the linked repo, case-insensitively', async () => {
    const service = build({
      resolveRunRepoContext: async () =>
        repoContext(async (n) => openPr(n, `https://github.com/o/r/pull/${n}`), {
          owner: 'O',
          name: 'R',
        }),
    })
    const task = await addReviewTask(service, { prUrl: 'https://github.com/o/r/pull/7' })
    expect(task.taskTypeFields?.prNumber).toBe(7)
  })

  it('creates the task when the probe FAILS — an outage is not evidence the PR is missing', async () => {
    const logger = createRecordingLogger()
    const service = build({
      logger,
      resolveRunRepoContext: async () =>
        repoContext(async () => {
          throw new Error('502 Bad Gateway')
        }),
    })
    const task = await addReviewTask(service, { prNumber: 42 })
    expect(task.taskTypeFields?.prNumber).toBe(42)
    // The swallow is REPORTED, or a permanently-broken token would look like a working check.
    expect(logger.lines.some((l) => l.msg.includes('board.validateReviewPullRequest'))).toBe(true)
  })

  it('passes through when the repo resolver itself throws (a frame with no repo linked)', async () => {
    // `resolveRepoTarget` throws for a block under no repo-linked service. That is a real
    // misconfiguration, but it is not this validation's to judge — refusing here would reject the
    // create with a message about repo linkage rather than about the pull request.
    const service = build({
      resolveRunRepoContext: async () => {
        throw new Error('Block is not under a service linked to a GitHub repository')
      },
    })
    const task = await addReviewTask(service, { prNumber: 42 })
    expect(task.taskTypeFields?.prNumber).toBe(42)
  })

  it('passes through when no repo resolves, or the provider cannot read a PR', async () => {
    const noRepo = await addReviewTask(build({ resolveRunRepoContext: async () => null }), {
      prNumber: 42,
    })
    expect(noRepo.taskTypeFields?.prNumber).toBe(42)
    const noCapability = await addReviewTask(
      build({ resolveRunRepoContext: async () => repoContext(undefined) }),
      { prNumber: 42 },
    )
    expect(noCapability.taskTypeFields?.prNumber).toBe(42)
  })

  it('never probes for a non-review task', async () => {
    let probes = 0
    const service = build({
      resolveRunRepoContext: async () => {
        probes++
        return repoContext(async () => null)
      },
    })
    const task = await service.addTask(
      WS,
      'frame_svc',
      { title: 'Build it', taskType: 'feature' },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(task.taskType).toBe('feature')
    expect(probes).toBe(0)
  })
})
