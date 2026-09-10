import { describe, expect, it } from 'vitest'
import type { Block } from './types.js'
import { agentRunScopeSubject, resolveInlineScope } from './inline-scope.js'

// The fold each inline caller's credential reach comes out of. Every case here is a shape a real
// caller passes, and the assertions are about what is OMITTED as much as what is present: a
// `ModelScope`'s readers spread it into a credential-pool query, where an explicitly-undefined
// tier and an absent one are not the same statement.

const BLOCK = { id: 'blk_1', executionId: 'exe_1' } as unknown as Block

describe('resolveInlineScope', () => {
  it('carries the run and the initiator for a block with a live run', async () => {
    const scope = await resolveInlineScope(
      { kind: 'block', workspaceId: 'ws_1', block: BLOCK },
      async () => ({
        executionId: 'exe_1',
        userId: 'usr_1',
      }),
    )
    expect(scope).toEqual({ workspaceId: 'ws_1', executionId: 'exe_1', userId: 'usr_1' })
  })

  it('degrades a block to workspace-only when no run context resolver is wired', async () => {
    // The tests-and-no-repository case, and the reason it is safe: the resolver is the only
    // optional half, so a caller cannot lose a tier it stated for itself.
    expect(await resolveInlineScope({ kind: 'block', workspaceId: 'ws_1', block: BLOCK })).toEqual({
      workspaceId: 'ws_1',
    })
  })

  it('keeps a run with no initiator, rather than dropping the run too', async () => {
    // The Kaizen grader's shape: a background pass over a settled run, with nobody on the request.
    const scope = await resolveInlineScope({
      kind: 'run',
      workspaceId: 'ws_1',
      executionId: 'exe_9',
    })
    expect(scope).toEqual({ workspaceId: 'ws_1', executionId: 'exe_9' })
    expect('userId' in scope).toBe(false)
  })

  it('carries the asker for a run-less surface', async () => {
    // The in-app assistant and the bug hunt: no run, but a signed-in person whose own keys and
    // personal subscription are in reach.
    const scope = await resolveInlineScope({ kind: 'user', workspaceId: 'ws_1', userId: 'usr_2' })
    expect(scope).toEqual({ workspaceId: 'ws_1', userId: 'usr_2' })
    expect('executionId' in scope).toBe(false)
  })

  it('omits every absent tier rather than setting it undefined', async () => {
    const scope = await resolveInlineScope({ kind: 'workspace', workspaceId: 'ws_1' })
    expect(Object.keys(scope)).toEqual(['workspaceId'])
  })

  it('carries an account on any subject that names one', async () => {
    // The public-API surfaces hold the account already; everyone else lets the facade resolve it.
    expect(
      await resolveInlineScope({
        kind: 'user',
        workspaceId: 'ws_1',
        accountId: 'acc_1',
        userId: 'usr_2',
      }),
    ).toEqual({ workspaceId: 'ws_1', accountId: 'acc_1', userId: 'usr_2' })
  })
})

describe('agentRunScopeSubject', () => {
  // The dispatch fold both agent executors share. It is here rather than at either of them
  // because a panel participant and the same step run alone must draw on ONE credential pool,
  // and a copy per executor is how the two would come to disagree without anything failing.

  it('names the run and its initiator when the dispatch carries both', () => {
    expect(
      agentRunScopeSubject({
        workspaceId: 'ws_1',
        executionId: 'exe_1',
        initiatedByUserId: 'usr_1',
      }),
    ).toEqual({ kind: 'run', workspaceId: 'ws_1', executionId: 'exe_1', userId: 'usr_1' })
  })

  it('keeps the run for a dispatch nobody is recorded as having started', () => {
    // A scheduled/webhook-started run: the initiator is genuinely absent, and the run is still
    // the key its activation was minted under.
    const subject = agentRunScopeSubject({ workspaceId: 'ws_1', executionId: 'exe_1' })
    expect(subject).toEqual({ kind: 'run', workspaceId: 'ws_1', executionId: 'exe_1' })
    expect('userId' in subject).toBe(false)
  })

  it('falls to the asker alone when there is no run', () => {
    expect(agentRunScopeSubject({ workspaceId: 'ws_1', initiatedByUserId: 'usr_1' })).toEqual({
      kind: 'user',
      workspaceId: 'ws_1',
      userId: 'usr_1',
    })
  })

  it('claims the workspace when the dispatch holds nothing else', () => {
    expect(agentRunScopeSubject({ workspaceId: 'ws_1' })).toEqual({
      kind: 'workspace',
      workspaceId: 'ws_1',
    })
  })
})
