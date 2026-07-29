import type { AgentPromptRepository, AgentPromptRevision } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { AgentPromptService } from './AgentPromptService.js'

const WS = 'ws_1'

/**
 * In-memory stand-in for the append-only log. `append` REFUSES a duplicate revision exactly as
 * both real stores' primary key does — that refusal is the concurrency control the service
 * translates into a 409, so a fake that overwrote would make the conflict test vacuous.
 */
function fakeRepo(seed: AgentPromptRevision[] = []): AgentPromptRepository & {
  rows: AgentPromptRevision[]
} {
  const rows = [...seed]
  return {
    rows,
    async listRevisions(_ws, agentKind) {
      return rows.filter((r) => r.agentKind === agentKind).sort((a, b) => b.revision - a.revision)
    },
    async listHeads() {
      const byKind = new Map<string, AgentPromptRevision>()
      for (const row of rows) {
        const seen = byKind.get(row.agentKind)
        if (!seen || row.revision > seen.revision) byKind.set(row.agentKind, row)
      }
      return [...byKind.values()].sort((a, b) => a.agentKind.localeCompare(b.agentKind))
    },
    async listRevisionsByKinds(_ws, agentKinds) {
      const wanted = new Set(agentKinds)
      return rows
        .filter((r) => wanted.has(r.agentKind))
        .sort((a, b) => a.agentKind.localeCompare(b.agentKind) || b.revision - a.revision)
    },
    async head(_ws, agentKind) {
      return (await this.listRevisions(_ws, agentKind))[0] ?? null
    },
    async append(_ws, revision) {
      if (
        rows.some((r) => r.agentKind === revision.agentKind && r.revision === revision.revision)
      ) {
        throw new Error('UNIQUE constraint failed')
      }
      rows.push(revision)
    },
  }
}

function makeService(repo: AgentPromptRepository, now = 1_000) {
  return new AgentPromptService({
    agentPromptRepository: repo,
    workspaceRepository: { get: async () => ({ id: WS }) } as never,
    clock: { now: () => now },
  })
}

function rev(overrides: Partial<AgentPromptRevision> = {}): AgentPromptRevision {
  return { agentKind: 'coder', revision: 1, text: 'custom', createdAt: 1, ...overrides }
}

describe('AgentPromptService', () => {
  it('appends the first revision for an untouched kind', async () => {
    const repo = fakeRepo()
    const log = await makeService(repo).save(WS, 'coder', { text: 'be terse' }, 'usr_1')

    expect(log).toEqual([
      { agentKind: 'coder', revision: 1, text: 'be terse', createdAt: 1_000, createdBy: 'usr_1' },
    ])
  })

  it('appends a null-text revision as the deliberate way back to the built-in', async () => {
    const repo = fakeRepo([rev()])
    const log = await makeService(repo).save(WS, 'coder', { text: null, restoredFrom: 1 })

    // The revert is RECORDED rather than deleting the log: the workspace goes back to tracking
    // the shipped prompt (as it is bumped) and the history still shows the edit it came from.
    expect(log[0]).toMatchObject({ revision: 2, text: null, restoredFrom: 1 })
    expect(log).toHaveLength(2)
  })

  it('appends nothing when the save would not change what runs', async () => {
    const repo = fakeRepo([rev({ text: 'same' })])
    const log = await makeService(repo).save(WS, 'coder', { text: 'same' })

    expect(log).toHaveLength(1)
    expect(repo.rows).toHaveLength(1)
  })

  it('treats a re-revert of an already-reverted kind as no change', async () => {
    const repo = fakeRepo([rev({ text: null })])
    await makeService(repo).save(WS, 'coder', { text: null })

    expect(repo.rows).toHaveLength(1)
  })

  it('refuses a restoredFrom that names no revision in the log', async () => {
    const repo = fakeRepo([rev()])
    await expect(
      makeService(repo).save(WS, 'coder', { text: 'x', restoredFrom: 7 }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'unknown_revision' } })
    expect(repo.rows).toHaveLength(1)
  })

  it('reports a concurrent editor as a conflict, keeping the winner’s prompt', async () => {
    const repo = fakeRepo([rev({ revision: 1, text: 'base' })])
    const service = makeService(repo)
    // Both editors read revision 1 and try to write revision 2; the store refuses the second.
    const [first, second] = await Promise.allSettled([
      service.save(WS, 'coder', { text: 'editor A' }),
      service.save(WS, 'coder', { text: 'editor B' }),
    ])

    const outcomes = [first, second]
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((o) => o.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'conflict',
      details: { reason: 'prompt_revision_conflict', revision: 2 },
    })
    // Exactly one of the two prompts landed — never a silent last-write-wins merge of both.
    expect(repo.rows.filter((r) => r.revision === 2)).toHaveLength(1)
  })

  it('rethrows a real store failure rather than reporting it as a conflict', async () => {
    const repo = fakeRepo()
    repo.append = async () => {
      throw new Error('database is down')
    }
    // Nothing landed, so the head is still absent — the failure is the store's, not a race.
    await expect(makeService(repo).save(WS, 'coder', { text: 'x' })).rejects.toThrow(
      'database is down',
    )
  })

  it('summarises the workspace index, marking a reverted kind as not customized', async () => {
    const repo = fakeRepo([
      rev({ agentKind: 'coder', revision: 1, text: 'c1' }),
      rev({ agentKind: 'coder', revision: 2, text: 'c2', createdAt: 5 }),
      rev({ agentKind: 'reviewer', revision: 2, text: null, createdAt: 9 }),
    ])

    expect(await makeService(repo).listSummaries(WS)).toEqual([
      { agentKind: 'coder', revision: 2, customized: true, updatedAt: 5 },
      { agentKind: 'reviewer', revision: 2, customized: false, updatedAt: 9 },
    ])
  })

  it('refuses an empty or oversized agent kind', async () => {
    const service = makeService(fakeRepo())
    await expect(service.save(WS, '   ', { text: 'x' })).rejects.toMatchObject({
      details: { reason: 'invalid_agent_kind' },
    })
    await expect(service.save(WS, 'k'.repeat(121), { text: 'x' })).rejects.toMatchObject({
      details: { reason: 'invalid_agent_kind' },
    })
  })
})
