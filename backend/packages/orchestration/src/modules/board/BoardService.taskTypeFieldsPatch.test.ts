import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type {
  Block,
  BlockPatch,
  OpenedPullRequest,
  RepoFiles,
  RunRepoContext,
} from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Patching a task's PER-TYPE fields, which is what makes an input the pre-dispatch gate refused
// repairable without deleting the task. The custom half was always patchable; the BUILT-IN half is
// new, and the whole of its difficulty is the `review` task, whose target is resolved against the
// provider at creation and folded into the description. Both halves of that have to repeat here,
// or the patch quietly writes a field creation would have refused and leaves a prompt naming the
// wrong pull request.

const WS = 'ws_1'

const frame = (): Block => ({
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

const task = (extra: Partial<Block> = {}): Block => ({
  id: 'blk_1',
  title: 'Task',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'planned',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'task',
  parentId: 'frame_svc',
  ...extra,
})

/** The patch the repository was asked to write, so a case can assert on the SHAPE that reached it. */
let written: BlockPatch | null

function build(seed: Block, extra?: Partial<BoardServiceDependencies>) {
  written = null
  const byId = new Map([
    [frame().id, frame()],
    [seed.id, seed],
  ])
  const deps = {
    workspaceRepository: { get: async (id: string) => ({ id }) },
    blockRepository: {
      get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
      listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
      update: async (_ws: string, id: string, patch: BlockPatch) => {
        written = patch
        byId.set(id, { ...byId.get(id)!, ...patch })
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
function repoContext(getPullRequest: RepoFiles['getPullRequest']): RunRepoContext {
  return {
    repo: { getPullRequest } as unknown as RepoFiles,
    baseBranch: 'main',
    repoId: 'repo_1',
    owner: 'o',
    name: 'r',
  }
}

const openPr = (number: number, url: string): OpenedPullRequest =>
  ({ number, url }) as OpenedPullRequest

const patchFields = (service: BoardService, patch: Record<string, unknown>) =>
  service.updateBlock(WS, 'blk_1', patch, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)

describe('BoardService per-type fields patch', () => {
  it('replaces the built-in half and leaves the custom bag standing', async () => {
    const seed = task({
      taskType: 'bug',
      taskTypeFields: { severity: 'low', custom: { collected: 'earlier' } },
    })
    await patchFields(build(seed), {
      builtinTaskTypeFields: { severity: 'high', stepsToReproduce: '1. open 2. click' },
    })
    expect(written?.taskTypeFields).toEqual({
      custom: { collected: 'earlier' },
      severity: 'high',
      stepsToReproduce: '1. open 2. click',
    })
  })

  it('replaces the custom half and leaves every built-in key standing', async () => {
    const seed = task({ taskType: 'bug', taskTypeFields: { severity: 'low', custom: { a: '1' } } })
    await patchFields(build(seed), { customTaskTypeFields: { b: '2' } })
    expect(written?.taskTypeFields).toEqual({ severity: 'low', custom: { b: '2' } })
  })

  it('drops the patch on a block that is not a task, rather than storing dead data', async () => {
    const service = build(frame())
    await service.updateBlock(
      WS,
      'frame_svc',
      { title: 'Renamed', builtinTaskTypeFields: { severity: 'high' } },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(written).toEqual({ title: 'Renamed' })
  })
})

describe('BoardService review-target patch', () => {
  it('validates the new target against the provider and canonicalises it, as creation does', async () => {
    const seed = task({ taskType: 'review', description: 'Look at the auth work.' })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(7, 'https://github.com/o/r/pull/7')),
    })
    await patchFields(service, { builtinTaskTypeFields: { prNumber: 7 } })
    // The provider's own url replaces what was typed, exactly as at creation.
    expect(written?.taskTypeFields).toEqual({ prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' })
    // ...and the reference is folded in front of the description the task already had, so the
    // read-only reviewer knows WHICH pull request from its prompt.
    expect(written?.description).toBe(
      'Review pull request https://github.com/o/r/pull/7.\n\nLook at the auth work.',
    )
  })

  it('refuses a pull request the provider positively reports as absent', async () => {
    const seed = task({ taskType: 'review' })
    const service = build(seed, {
      resolveRunRepoContext: async () => repoContext(async () => null),
    })
    await expect(
      patchFields(service, { builtinTaskTypeFields: { prNumber: 4242 } }),
    ).rejects.toThrow(/4242/)
    // Nothing was written: a refusal that had already patched the row would leave the task naming
    // a pull request the run cannot open.
    expect(written).toBeNull()
  })

  it('swaps the old preamble for the new one when the target moves, never stacking two', async () => {
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prUrl: 'https://github.com/o/r/pull/1' },
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nOriginal notes.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(9, 'https://github.com/o/r/pull/9')),
    })
    await patchFields(service, { builtinTaskTypeFields: { prNumber: 9 } })
    expect(written?.description).toBe(
      'Review pull request https://github.com/o/r/pull/9.\n\nOriginal notes.',
    )
  })

  it('refuses to move the target when the description no longer carries the fold', async () => {
    // Somebody rewrote the description, so the platform can no longer tell which part of it was
    // the fold. Prepending anyway would state a second, contradicting target; stripping a guess
    // would eat prose a human wrote.
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prNumber: 1 },
      description: 'Rewritten by hand, mentioning PR #1 somewhere in the middle.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(9, 'https://github.com/o/r/pull/9')),
    })
    const error = await patchFields(service, { builtinTaskTypeFields: { prNumber: 9 } }).catch(
      (e: unknown) => e,
    )
    expect((error as { details?: { reason?: string } }).details?.reason).toBe(
      'task_type_fields_invalid',
    )
    expect(written).toBeNull()
  })

  it('folds onto a description supplied in the SAME patch, which has no earlier fold in it', async () => {
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prNumber: 1 },
      description: 'Review pull request #1.\n\nOld notes.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(9, 'https://github.com/o/r/pull/9')),
    })
    await patchFields(service, {
      description: 'Freshly authored notes.',
      builtinTaskTypeFields: { prNumber: 9 },
    })
    expect(written?.description).toBe(
      'Review pull request https://github.com/o/r/pull/9.\n\nFreshly authored notes.',
    )
  })

  it('replaces the fold a READ-MODIFY-WRITE caller sends back, rather than stating it twice', async () => {
    // The read surface serves the FOLDED description, so a client that reads a task, changes the
    // target and sends the whole thing back returns the old preamble to us. Prepending onto it
    // left a description naming two different pull requests, and the reviewer reads whichever it
    // meets first: the exact failure the refold exists to prevent, arriving through the other door.
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' },
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nNotes.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(9, 'https://github.com/o/r/pull/9')),
    })
    await patchFields(service, {
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nNotes.',
      builtinTaskTypeFields: { prNumber: 9 },
    })
    expect(written?.description).toBe(
      'Review pull request https://github.com/o/r/pull/9.\n\nNotes.',
    )
  })

  it('does not double the fold when a returned description accompanies an unmoved target', async () => {
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' },
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nNotes.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(1, 'https://github.com/o/r/pull/1')),
    })
    await patchFields(service, {
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nNotes, expanded.',
      builtinTaskTypeFields: {
        prNumber: 1,
        prUrl: 'https://github.com/o/r/pull/1',
        severity: 'high',
      },
    })
    expect(written?.description).toBe(
      'Review pull request https://github.com/o/r/pull/1.\n\nNotes, expanded.',
    )
  })

  it('leaves the description alone when the patch changes a field the fold does not read', async () => {
    const seed = task({
      taskType: 'review',
      taskTypeFields: { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' },
      description: 'Review pull request https://github.com/o/r/pull/1.\n\nNotes.',
    })
    const service = build(seed, {
      resolveRunRepoContext: async () =>
        repoContext(async () => openPr(1, 'https://github.com/o/r/pull/1')),
    })
    await patchFields(service, {
      builtinTaskTypeFields: {
        prNumber: 1,
        prUrl: 'https://github.com/o/r/pull/1',
        severity: 'high',
      },
    })
    expect(written).not.toHaveProperty('description')
  })
})
