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

/**
 * A repo that carries no `spec/` but records every ref it was asked to read at.
 *
 * `branches` is which refs EXIST, because the loader treats a branch that resolves no head as one
 * that is gone and reads the default instead. A fake answering null for every ref would put every
 * test that names a pull-request branch on the deleted-branch path.
 */
function recordingRepo(branches: string[] = [PR_BRANCH, DEFAULT_BRANCH]): {
  repo: RepoFiles
  refs: (string | undefined)[]
} {
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
    headSha: async (ref: string) => (branches.includes(ref) ? `sha-${ref}` : null),
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

  it('reads the default branch once the run’s branch is gone, rather than a branch nobody can read', async () => {
    // `block.pullRequest` is never cleared and a merged pull request's head branch is routinely
    // deleted, so the run keeps naming a branch that resolves nothing: no head, every file a 404.
    // Read there forever, the audit case this whole read exists for is the one that cannot be
    // served. Post-merge the default branch carries the same requirements, which is why it is the
    // right tree rather than merely the readable one.
    const { repo, refs } = recordingRepo([DEFAULT_BRANCH])
    const target = block({ pullRequest: { branch: PR_BRANCH } as never })
    const read = await loaderFor(target, repo).runSpecRead('ws_1', instance())

    expect(read.status).toBe('read')
    if (read.status !== 'read') return
    // Named, not substituted: a caller joining verdicts can see which tree it got.
    expect(read.provenance.ref).toBe(DEFAULT_BRANCH)
    expect(read.provenance.commit).toBe(`sha-${DEFAULT_BRANCH}`)
    expect(refs).toContain(DEFAULT_BRANCH)
  })

  it('does not switch trees when the ref probe merely FAILS', async () => {
    // The other half of the same rule. A provider that will not answer for a ref has told us
    // nothing about whether the branch exists, and re-reading the default mid-incident would hand
    // a caller a tree missing exactly the requirements this run added. Only a definite 404 on the
    // ref is evidence, and the loader keeps the two apart where the wire shape (`commit: null`)
    // cannot.
    const { refs } = recordingRepo()
    const repo = {
      getFile: async (_path: string, gitRef?: string) => {
        refs.push(gitRef)
        return null
      },
      listDirectory: async () => [],
      headSha: async () => {
        throw new Error('GitHub 502')
      },
    } as unknown as RepoFiles
    const target = block({ pullRequest: { branch: PR_BRANCH } as never })
    const read = await loaderFor(target, repo).runSpecRead('ws_1', instance())

    expect(read.status).toBe('read')
    if (read.status !== 'read') return
    expect(read.provenance.ref).toBe(PR_BRANCH)
    expect(read.provenance.commit).toBeNull()
    expect(refs).not.toContain(DEFAULT_BRANCH)
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

  // The reporting read. Same gate, same branch, same memo, same reader as everything above: what
  // it adds is that nothing is folded on the way out, because `GET /api/v1/runs/:runId/spec` has
  // to REPORT the read rather than survive it. Folded, an outage tells an integrator that the run
  // was judged against a service that declares no requirements.
  describe('runSpecRead', () => {
    it('names the branch and commit a read describes, so a caller knows which tree it got', async () => {
      const repo = {
        getFile: async () => null,
        listDirectory: async () => [],
        headSha: async () => 'sha-1',
      } as unknown as RepoFiles
      const target = block({ pullRequest: { branch: PR_BRANCH } as never })
      const read = await loaderFor(target, repo).runSpecRead('ws_1', instance())

      expect(read.status).toBe('read')
      if (read.status !== 'read') return
      expect(read.provenance.ref).toBe(PR_BRANCH)
      expect(read.provenance.commit).toBe('sha-1')
      // A branch that demonstrably holds no `spec/` is an ANSWER, and it reaches the caller as
      // one. Only the reporting layer decides that an `absent` with no resolved commit is
      // unproven; the loader states both facts and keeps them apart.
      expect(read.view.diagnostics?.anchor).toBe('absent')
    })

    it('keeps the four ways there is no tree apart, instead of one empty view', async () => {
      const { repo } = recordingRepo()
      const unwired = new RunEvidenceLoader({
        blockRepository: { get: async () => block() } as never,
      })
      expect(await unwired.runSpecRead('ws_1', instance())).toEqual({ status: 'vcs_unwired' })

      const unconnected = new RunEvidenceLoader({
        blockRepository: { get: async () => block() } as never,
        resolveRunRepoContext: async () => null,
      })
      expect(await unconnected.runSpecRead('ws_1', instance())).toEqual({ status: 'no_connection' })

      // Gated, not empty: before a tester reports, the platform has consulted no tree at all, and
      // that is the same fact the run's own outcome summary states as `spec: 'not_read'`.
      const noTester = instance([{ agentKind: 'coder', state: 'done' } as unknown as PipelineStep])
      expect(await loaderFor(block(), repo).runSpecRead('ws_1', noTester)).toEqual({
        status: 'not_read',
      })

      // And the gate outranks BOTH wiring states, which is what stops one run answering two ways
      // for one unchanged deployment: `vcs_unwired` is free to check and `no_connection` costs a
      // resolve, so ranked by cost the first was reported from a run's first settlement while the
      // second waited for the tester. A read that was never DUE stopped at the gate; it never
      // reached the resolver to find out whether one was wired.
      expect(await unwired.runSpecRead('ws_1', noTester)).toEqual({ status: 'not_read' })
      expect(await unconnected.runSpecRead('ws_1', noTester)).toEqual({ status: 'not_read' })

      const throwing = {
        getFile: async () => {
          throw new Error('GitHub 502')
        },
        listDirectory: async () => [],
        headSha: async () => null,
      } as unknown as RepoFiles
      expect(await loaderFor(block(), throwing).runSpecRead('ws_1', instance())).toEqual({
        status: 'read_failed',
      })
    })

    it('serves a memo hit with the provenance the read was memoised WITH', async () => {
      // The memo deliberately holds the spec as it stood when the tester ruled, so the commit has
      // to be held with it: re-resolving one at serve time would name a commit the tree was never
      // read at, which is the one thing provenance exists to prevent.
      let heads = 0
      const repo = {
        getFile: async () => null,
        listDirectory: async () => [],
        headSha: async () => `sha-${++heads}`,
      } as unknown as RepoFiles
      const loader = loaderFor(block(), repo)

      const first = await loader.runSpecRead('ws_1', instance())
      const second = await loader.runSpecRead('ws_1', instance())
      expect(heads).toBe(1)
      expect(second).toEqual(first)
    })

    it('answers no_block for a run whose task is gone', async () => {
      const { repo } = recordingRepo()
      const loader = new RunEvidenceLoader({
        blockRepository: { get: async () => null } as never,
        resolveRunRepoContext: async () => ({ repo, baseBranch: DEFAULT_BRANCH }) as never,
      })
      expect(await loader.runSpecRead('ws_1', instance())).toEqual({ status: 'no_block' })
    })
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
