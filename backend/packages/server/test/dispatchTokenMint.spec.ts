import { describe, expect, it } from 'vitest'
import { createRecordingLogger, noopOperationalMetrics } from '@cat-factory/kernel'
import { buildDispatchTokenMint } from '../src/agents/dispatchTokenMint.js'
import { jobTokenRepoIds } from '../src/agents/repoTargeting.js'
import type { RepoTarget } from '../src/agents/repoTargeting.js'

// The two decisions a dispatch's clone/push credential turns on (WHOSE token and HOW WIDE) live
// in one builder, so the Cloudflare and Node facades cannot drift on either, and so can the four
// dispatchers that hand a token to a container: the step executor, the repo bootstrapper, the
// env-config repairer and preview jobs.

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

/** A builder with the reporting seams recorded, for the widening assertions. */
function watchedMint(extra: Partial<Parameters<typeof buildDispatchTokenMint>[0]> = {}): {
  calls: { installationId: number; repositoryIds?: number[] }[]
  increments: string[]
  logger: ReturnType<typeof createRecordingLogger>
  mintToken: ReturnType<typeof buildDispatchTokenMint>
} {
  const { calls, mint } = recordingMint()
  const increments: string[] = []
  const logger = createRecordingLogger()
  return {
    calls,
    increments,
    logger,
    mintToken: buildDispatchTokenMint({
      mint,
      logger,
      operationalMetrics: { increment: (name) => increments.push(name) },
      ...extra,
    }),
  }
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
    const { calls, mintToken } = watchedMint()
    const token = await mintToken(7, { ...RUN, repoIds: ['1001', '2002'] })
    expect(token).toBe('APP-TOKEN')
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [1001, 2002] }])
  })

  it('leaves an ENGINE call (no run context at all) installation-wide and silent', async () => {
    const { calls, increments, mintToken } = watchedMint()
    await mintToken(7)
    // A `RepoFiles` read or a gate probe is the platform acting on its own behalf, not a token
    // handed to a container. It is installation-wide by design, so it is not a widening.
    expect(calls).toEqual([{ installationId: 7 }])
    expect(increments).toEqual([])
  })

  it('prefers the run initiator PAT and never tries to scope it', async () => {
    const { calls, mintToken } = watchedMint({ resolveRunInitiatorToken: async () => 'INIT-PAT' })
    const token = await mintToken(7, { ...RUN, initiatedBy: 'usr_1', repoIds: ['1001'] })
    // `repository_ids` is an App-token mechanism with no PAT equivalent, so the run is bounded by
    // the initiator's own token: the property `allowInitiatorPat` exists to govern.
    expect(token).toBe('INIT-PAT')
    expect(calls).toEqual([])
  })

  it('falls back to the scoped App mint when the initiator has no usable token', async () => {
    const { calls, mintToken } = watchedMint({ resolveRunInitiatorToken: async () => null })
    await mintToken(7, { ...RUN, repoIds: ['1001'] })
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [1001] }])
  })

  it('widens LOUDLY when a named scope does not map onto GitHub repo ids', async () => {
    const { calls, increments, logger, mintToken } = watchedMint()
    await mintToken(7, { ...RUN, repoIds: ['1001', 'not-a-github-id'] })

    // All-or-nothing: minting for the parseable remainder would hand out a token that cannot
    // reach a repo the job body still tells the harness to clone.
    expect(calls).toEqual([{ installationId: 7 }])
    // The widening is a security property degrading, so it is never silent.
    expect(logger.lines.some((l) => l.level === 'warn' && l.msg.includes('token scope'))).toBe(true)
    expect(increments).toEqual(['dispatch.token_scope_widened'])
  })

  it('widens LOUDLY when a dispatch resolved no repo at all', async () => {
    const { calls, increments, mintToken } = watchedMint()
    // An EMPTY scope is what a dispatcher passes when its own lookup came back with nothing (a
    // repair whose projection row has not caught up). It is a different fact from "an engine
    // call named no scope" and must not read like one: this token IS going to a container.
    await mintToken(7, { ...RUN, repoIds: [] })
    expect(calls).toEqual([{ installationId: 7 }])
    expect(increments).toEqual(['dispatch.token_scope_widened'])
  })

  it.each([
    ['0', 'a repo id is never zero'],
    ['-5', 'nor negative'],
    ['1e3', 'nor an exponent JavaScript would coerce'],
    ['0x10', 'nor hex'],
    [' 12 ', 'nor padded'],
    ['12.0', 'nor a fraction'],
    ['', 'nor empty'],
  ])('refuses %s as a GitHub repo id (%s)', async (raw) => {
    const { calls, increments, mintToken } = watchedMint()
    await mintToken(7, { ...RUN, repoIds: [raw] })
    // The question is whether the projection carries something GITHUB will recognise. A string
    // JavaScript happens to coerce to a number is not evidence of that, so the strict parse
    // widens (loudly) rather than minting for an id the provider would reject.
    expect(calls).toEqual([{ installationId: 7 }])
    expect(increments).toEqual(['dispatch.token_scope_widened'])
  })

  it('accepts a repo id past 2^31, which GitHub now issues', async () => {
    const { calls, mintToken } = watchedMint()
    await mintToken(7, { ...RUN, repoIds: ['9007199254740991'] })
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [9007199254740991] }])
  })

  it('widens on an id past what a JS number represents exactly', async () => {
    const { calls, increments, mintToken } = watchedMint()
    // Digits alone are not enough: past `Number.MAX_SAFE_INTEGER` the parse silently rounds, so
    // the mint would name a repo NOBODY asked for rather than the one the row meant.
    await mintToken(7, { ...RUN, repoIds: ['9007199254740993'] })
    expect(calls).toEqual([{ installationId: 7 }])
    expect(increments).toEqual(['dispatch.token_scope_widened'])
  })

  it('accepts kernel noop metrics for a caller with nothing to export', async () => {
    const { calls, mint } = recordingMint()
    // The dependency is REQUIRED so an un-wired counter cannot read as a zero saying "every
    // dispatch was scoped". A caller that genuinely exports nothing says so in code.
    await buildDispatchTokenMint({ mint, operationalMetrics: noopOperationalMetrics })(7, {
      ...RUN,
      repoIds: ['1001'],
    })
    expect(calls).toEqual([{ installationId: 7, repositoryIds: [1001] }])
  })
})
