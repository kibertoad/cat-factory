import { describe, expect, it } from 'vitest'
import type { WorkspaceAgentSettings, WorkspaceAgentSettingsRepository } from '@cat-factory/kernel'
import { WorkspaceAgentSettingsService } from './WorkspaceAgentSettingsService.js'

// The service's one real decision is how "inheriting" is REPRESENTED: absence, never a stored row
// whose fields are all null. Getting that wrong is invisible — both shapes behave identically at
// dispatch — but it would leave the settings screen unable to tell "configured to inherit" from
// "never configured", and would accumulate a row per kind anyone ever opened the editor on.

function fakeRepo(seed: WorkspaceAgentSettings[] = []) {
  const rows = new Map<string, WorkspaceAgentSettings>(seed.map((s) => [s.agentKind, s]))
  const calls: string[] = []
  const repo: WorkspaceAgentSettingsRepository = {
    get: async (_ws, agentKind) => rows.get(agentKind) ?? null,
    list: async () => [...rows.values()],
    upsert: async (_ws, settings) => {
      calls.push(`upsert:${settings.agentKind}`)
      rows.set(settings.agentKind, settings)
    },
    remove: async (_ws, agentKind) => {
      calls.push(`remove:${agentKind}`)
      rows.delete(agentKind)
    },
  }
  return { repo, rows, calls }
}

function makeService(repo: WorkspaceAgentSettingsRepository, now = 1_700_000_000_000) {
  return new WorkspaceAgentSettingsService({
    workspaceAgentSettingsRepository: repo,
    // The service only calls `requireWorkspace`, which needs the workspace to resolve.
    workspaceRepository: { get: async () => ({ id: 'ws1' }) } as never,
    clock: { now: () => now },
  })
}

describe('WorkspaceAgentSettingsService', () => {
  it('stores a ceiling and stamps it with the clock', async () => {
    const { repo, rows } = fakeRepo()
    const result = await makeService(repo).update('ws1', 'doc-researcher', {
      maxOutputTokens: 24_000,
    })

    expect(result).toEqual({
      agentKind: 'doc-researcher',
      maxOutputTokens: 24_000,
      updatedAt: 1_700_000_000_000,
    })
    expect(rows.get('doc-researcher')?.maxOutputTokens).toBe(24_000)
  })

  it('replaces an existing ceiling', async () => {
    const { repo } = fakeRepo([
      { agentKind: 'doc-researcher', maxOutputTokens: 10_000, updatedAt: 1 },
    ])
    const result = await makeService(repo).update('ws1', 'doc-researcher', {
      maxOutputTokens: 32_000,
    })

    expect(result?.maxOutputTokens).toBe(32_000)
  })

  it('DELETES the row when the ceiling is cleared, so inheriting is expressed by absence', async () => {
    const { repo, rows, calls } = fakeRepo([
      { agentKind: 'doc-researcher', maxOutputTokens: 24_000, updatedAt: 1 },
    ])
    const result = await makeService(repo).update('ws1', 'doc-researcher', {
      maxOutputTokens: null,
    })

    expect(result).toBeNull()
    expect(rows.has('doc-researcher')).toBe(false)
    // Never an upsert of an all-null row — that would be a second way to say "inheriting".
    expect(calls).toEqual(['remove:doc-researcher'])
  })

  it('does not touch the store when clearing a kind that was never configured', async () => {
    const { repo, calls } = fakeRepo()
    const result = await makeService(repo).update('ws1', 'coder', { maxOutputTokens: null })

    expect(result).toBeNull()
    expect(calls).toEqual([])
  })

  it('keeps the stored ceiling when the patch omits the field entirely', async () => {
    // A PATCH, not a replace: an omitted field must survive, so a future second knob can be
    // written without a read-modify-write race that silently drops this one.
    const { repo } = fakeRepo([
      { agentKind: 'doc-researcher', maxOutputTokens: 24_000, updatedAt: 1 },
    ])
    const result = await makeService(repo).update('ws1', 'doc-researcher', {})

    expect(result?.maxOutputTokens).toBe(24_000)
  })

  it('treats an omitted field on an unconfigured kind as nothing to store', async () => {
    const { repo, calls } = fakeRepo()
    const result = await makeService(repo).update('ws1', 'coder', {})

    expect(result).toBeNull()
    expect(calls).toEqual([])
  })

  it('lists the configured kinds', async () => {
    const { repo } = fakeRepo([
      { agentKind: 'coder', maxOutputTokens: 8_000, updatedAt: 1 },
      { agentKind: 'doc-researcher', maxOutputTokens: 24_000, updatedAt: 1 },
    ])

    expect((await makeService(repo).list('ws1')).map((s) => s.agentKind)).toEqual([
      'coder',
      'doc-researcher',
    ])
  })
})
