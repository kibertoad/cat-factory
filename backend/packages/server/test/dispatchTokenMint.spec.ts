import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import { buildDispatchTokenMint } from '../src/agents/dispatchTokenMint.js'
import { jobTokenRepoIds } from '../src/agents/repoTargeting.js'
import type { RepoTarget } from '../src/agents/repoTargeting.js'

// The two decisions a dispatch's clone/push credential turns on — WHOSE token and HOW WIDE —
// live in one builder so the Cloudflare and Node facades cannot drift on either.

const OWN: RepoTarget = {
  installationId: 7,
  repoId: '1001',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}
const RUN = { executionId: 'ex_1', workspaceId: 'ws_1' }

function recordingMint() {
  const calls: { installationId: number; repositoryIds?: number[] }[] = []
  const mint = async (installationId: number, opts?: { repositoryIds?: number[] }) => {
    calls.push({
      installationId,
      ...(opts?.repositoryIds ? { repositoryIds: opts.repositoryIds } : {}),
    })
    return 'APP-TOKEN'
  }
  return { calls, mint }
}

describe('jobTokenRepoIds', () => {
  it('puts the primary first and dedupes a repo reached by several legs', () => {
    const peer: RepoTarget = { ...OWN, repoId: '2002', name: 'billing' }
    expect(jobTokenRepoIds(OWN, [peer, { ...peer }, OWN])).toEqual(['1001', '2002'])
  })

  it('drops a leg on another installation, which one token could never cover anyway', () => {
    const foreign: RepoTarget = { ...OWN, installationId: 99, repoId: '3003', owner: 'other' }
    expect(jobTokenRepoIds(OWN, [foreign])).toEqual(['1001'])
  })

  it('always yields the primary, even with no auxiliary legs', () => {
    expect(jobTokenRepoIds(OWN, [])).toEqual(['1001'])
  })
})

describe('buildDispatchTokenMint', () => {
  it('narrows the App mint to the repos the dispatch resolved', async () => {
    const { calls, mint } = recordingMint()
    const token = await buildDispatchTokenMint({ mint })(7, { ...RUN, repoIds: ['1001', '2002'] })
    expect(token).toBe('APP-TOKEN')
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [1001, 2002] }])
  })

  it('leaves a caller that named no scope installation-wide', async () => {
    const { calls, mint } = recordingMint()
    await buildDispatchTokenMint({ mint })(7, RUN)
    expect(calls).toEqual([{ installationId: 7 }])
  })

  it('prefers the run initiator PAT and never tries to scope it', async () => {
    const { calls, mint } = recordingMint()
    const token = await buildDispatchTokenMint({
      mint,
      resolveRunInitiatorToken: async () => 'INITIATOR-PAT',
    })(7, { ...RUN, initiatedBy: 'usr_1', repoIds: ['1001'] })
    // `repository_ids` is an App-token mechanism with no PAT equivalent, so the run is bounded by
    // the initiator's own token — the property `allowInitiatorPat` exists to govern.
    expect(token).toBe('INITIATOR-PAT')
    expect(calls).toEqual([])
  })

  it('falls back to the scoped App mint when the initiator has no usable token', async () => {
    const { calls, mint } = recordingMint()
    await buildDispatchTokenMint({ mint, resolveRunInitiatorToken: async () => null })(7, {
      ...RUN,
      repoIds: ['1001'],
    })
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [1001] }])
  })

  it('widens LOUDLY when a named scope does not map onto GitHub repo ids', async () => {
    const { calls, mint } = recordingMint()
    const logger = createRecordingLogger()
    const increments: string[] = []
    await buildDispatchTokenMint({
      mint,
      logger,
      operationalMetrics: { increment: (name) => increments.push(name) },
    })(7, { ...RUN, repoIds: ['1001', 'not-a-github-id'] })

    // All-or-nothing: minting for the parseable remainder would hand out a token that cannot
    // reach a repo the job body still tells the harness to clone.
    expect(calls).toEqual([{ installationId: 7 }])
    // The widening is a security property degrading, so it is never silent.
    expect(logger.lines.some((l) => l.level === 'warn' && l.msg.includes('token scope'))).toBe(true)
    expect(increments).toEqual(['dispatch.token_scope_widened'])
  })
})
