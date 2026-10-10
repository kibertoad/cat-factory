import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { Block, RunRepoContext } from '@cat-factory/kernel'
import { MergeTrackRecordService } from './MergeTrackRecordService.js'

// `classify` is a best-effort side channel of the merge path: it must never throw, and its
// degraded answer must stay ATTRIBUTABLE. The second half is what these tests exist for — the
// record's `(repoId, prNumber)` is the only key external-merge attribution has, so losing it on
// the COMMON failure (a 403/404/rate-limited `listChangedFiles`) permanently breaks that record.

const WS = 'ws_1'
const BLOCK = { id: 'blk_1', pullRequest: { number: 42, url: 'https://x/42' } } as unknown as Block

function makeService(
  listChangedFiles: RunRepoContext['repo']['listChangedFiles'],
  logger = createRecordingLogger(),
) {
  const service = new MergeTrackRecordService({
    mergeTrackRecordRepository: {} as never,
    workspaceRepository: {} as never,
    clock: { now: () => 1_000 },
    resolveRunRepoContext: async () =>
      ({
        repoId: 'repo_7',
        provider: 'github',
        repo: { listChangedFiles },
      }) as unknown as RunRepoContext,
    logger,
  })
  return { service, logger }
}

describe('MergeTrackRecordService.classify', () => {
  it('classifies from the changed-file list and carries the repo identity', async () => {
    const { service } = makeService(async () => [{ path: 'src/app.ts' }] as never)
    await expect(service.classify(WS, BLOCK)).resolves.toMatchObject({
      changeClass: 'source',
      repoId: 'repo_7',
      provider: 'github',
    })
  })

  it('keeps the repo identity when listChangedFiles THROWS, and logs the cause', async () => {
    // The regression this pins: `repo` used to be bound inside the try, so a throw here
    // returned a bare `absent` and the record could never be matched by (repoId, prNumber).
    const { service, logger } = makeService(async () => {
      throw new Error('GitHub says 403')
    })

    await expect(service.classify(WS, BLOCK)).resolves.toEqual({
      changeClass: 'unknown',
      fileCount: 0,
      repoId: 'repo_7',
      provider: 'github',
    })
    expect(logger.lines).toMatchObject([
      {
        level: 'warn',
        fields: { blockId: 'blk_1', prNumber: 42, attributable: true, err: 'GitHub says 403' },
      },
    ])
  })

  it('reports NOT attributable when the repo could not be resolved at all', async () => {
    // The genuinely un-attributable case must stay distinguishable in the logs from the one
    // above, or an operator can't tell a broken VCS token from an unlinked repo.
    const logger = createRecordingLogger()
    const service = new MergeTrackRecordService({
      mergeTrackRecordRepository: {} as never,
      workspaceRepository: {} as never,
      clock: { now: () => 1_000 },
      resolveRunRepoContext: async () => {
        throw new Error('no installation for this workspace')
      },
      logger,
    })

    await expect(service.classify(WS, BLOCK)).resolves.toEqual({
      changeClass: 'unknown',
      fileCount: 0,
    })
    expect(logger.lines[0]?.fields).toMatchObject({ attributable: false })
  })

  it('never throws and never logs when the block has no pull request', async () => {
    const { service, logger } = makeService(async () => [])
    await expect(service.classify(WS, { id: 'blk_2' } as Block)).resolves.toEqual({
      changeClass: 'unknown',
      fileCount: 0,
    })
    expect(logger.lines).toEqual([])
  })
})
