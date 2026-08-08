import type { Block, ExecutionInstance, PipelineStep, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunEvidenceLoader } from './RunEvidenceLoader.js'

// The loader exists so the three readers of a run's evidence (the PR verification report,
// `GET /api/v1/runs/:runId/outcome`, and the SPA outcome card's spec fetch) cannot read it
// differently. The branch is the part that had already drifted, and it is the one that decides
// whether the requirement join has anything to match at all: the spec increment a task wrote
// lives on the run's own branch until its pull request merges.

const PR_BRANCH = 'cat/add-login'
const DEFAULT_BRANCH = 'main'

function block(partial: Partial<Block> = {}): Block {
  return {
    id: 'blk_1',
    title: 'Add login',
    level: 'task',
    status: 'pr_ready',
    ...partial,
  } as unknown as Block
}

function testerStep(): PipelineStep {
  return {
    agentKind: 'tester-api',
    state: 'done',
    test: { lastReport: { greenlight: true, tested: [], outcomes: [], concerns: [] } },
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[] = [testerStep()]): ExecutionInstance {
  return { id: 'exec_1', blockId: 'blk_1', status: 'done', steps } as unknown as ExecutionInstance
}

/** A repo that answers nothing but records every ref it was asked to read at. */
function recordingRepo(): { repo: RepoFiles; refs: (string | undefined)[] } {
  const refs: (string | undefined)[] = []
  const repo = {
    getFile: async (_path: string, gitRef?: string) => {
      refs.push(gitRef)
      return null
    },
    listDirectory: async (_path: string, gitRef?: string) => {
      refs.push(gitRef)
      return []
    },
    headSha: async () => null,
  } as unknown as RepoFiles
  return { repo, refs }
}

function loaderFor(target: Block, repo: RepoFiles) {
  return new RunEvidenceLoader({
    blockRepository: { get: async () => target } as never,
    resolveRunRepoContext: async () => ({ repo, baseBranch: DEFAULT_BRANCH }) as never,
  })
}

describe('RunEvidenceLoader', () => {
  it('reads the spec from the branch the run pushed to, not the repo default', async () => {
    const { repo, refs } = recordingRepo()
    const target = block({ pullRequest: { branch: PR_BRANCH } as never })
    await loaderFor(target, repo).load('ws_1', instance())
    expect(refs.length).toBeGreaterThan(0)
    expect(new Set(refs)).toEqual(new Set([PR_BRANCH]))
  })

  it('falls back to the default branch when the run has opened no pull request', async () => {
    const { repo, refs } = recordingRepo()
    await loaderFor(block(), repo).load('ws_1', instance())
    expect(new Set(refs)).toEqual(new Set([DEFAULT_BRANCH]))
  })

  it('serves the SPA the same read, at the same branch', async () => {
    // The card used to fetch the SERVICE's spec, which is the default branch: for as long as the
    // pull request was open it was missing exactly the requirements the tester had just ruled on.
    const { repo, refs } = recordingRepo()
    const target = block({ pullRequest: { branch: PR_BRANCH } as never })
    const view = await loaderFor(target, repo).specViewForRun('ws_1', instance())
    expect(new Set(refs)).toEqual(new Set([PR_BRANCH]))
    // A repo carrying no `spec/` is stated, never rendered as a clean empty section, and the
    // reader says WHICH kind of nothing it found, so an outage can never be reported as a
    // service that declared no requirements.
    expect(view).toEqual({
      present: false,
      spec: null,
      features: [],
      diagnostics: { anchor: 'absent', issues: [] },
    })
  })

  it('reads nothing at all until a tester has actually reported', async () => {
    // The report hook fires on EVERY settled step, and before a tester reports the coverage
    // answer is already determined, so a read would buy nothing.
    const { repo, refs } = recordingRepo()
    const noTester = instance([{ agentKind: 'coder', state: 'done' } as unknown as PipelineStep])
    await loaderFor(block(), repo).load('ws_1', noTester)
    expect(refs).toEqual([])
  })

  it('re-reads after a FAILED read instead of memoising the outage as the run’s answer', async () => {
    // The memo exists because the report hook fires on every settled step. The reader is TOTAL,
    // though, so a provider outage arrives as a returned value rather than a throw: memoised, one
    // flaky read pins "the spec could not be read" onto every later settlement of the run, when
    // the very next one would have succeeded.
    let attempts = 0
    const repo = {
      getFile: async (_path: string, _ref?: string) => {
        attempts += 1
        if (attempts === 1) throw new Error('GitHub 502')
        return null
      },
      listDirectory: async () => [],
      headSha: async () => null,
    } as unknown as RepoFiles
    const loader = loaderFor(block(), repo)

    expect(await loader.specViewForRun('ws_1', instance())).toMatchObject({ present: false })
    const second = await loader.specViewForRun('ws_1', instance())
    expect(attempts).toBeGreaterThan(1)
    // The retry found the real answer: this branch carries no spec, which is a fact rather than
    // an outage, and THAT is what the memo is allowed to keep.
    expect(second.diagnostics?.anchor).toBe('absent')
  })

  it('memoises a CORRUPT anchor, which re-reading cannot improve', async () => {
    // The counterpart rule: `unparsed` is an answer about the repository, not about our luck
    // reaching it, so re-walking on every settlement would buy nothing.
    let reads = 0
    const repo = {
      getFile: async (path: string) => {
        reads += 1
        return path === 'spec/service.json' ? { content: '{ not json', sha: 's' } : null
      },
      listDirectory: async () => [],
      headSha: async () => null,
    } as unknown as RepoFiles
    const loader = loaderFor(block(), repo)

    expect((await loader.specViewForRun('ws_1', instance())).diagnostics?.anchor).toBe('unparsed')
    const after = reads
    await loader.specViewForRun('ws_1', instance())
    expect(reads).toBe(after)
  })

  it('answers an unknown run with an empty view rather than throwing', async () => {
    const { repo } = recordingRepo()
    const loader = new RunEvidenceLoader({
      blockRepository: { get: async () => null } as never,
      resolveRunRepoContext: async () => ({ repo, baseBranch: DEFAULT_BRANCH }) as never,
    })
    expect(await loader.load('ws_1', instance())).toBeNull()
    expect(await loader.specViewForRun('ws_1', instance())).toEqual({
      present: false,
      spec: null,
      features: [],
    })
  })
})
