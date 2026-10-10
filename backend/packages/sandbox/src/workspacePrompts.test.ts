import type { AgentPromptRevision } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  parseWorkspacePromptVersionId,
  sandboxPromptKinds,
  workspacePromptVersions,
} from './workspacePrompts.js'

// The projection that lets the sandbox measure a candidate against the prompt the workspace is
// ACTUALLY running, rather than only against what the product ships. Each rule below has a failure
// mode that is silent — a wrong control, an empty system prompt, or a "live" badge on a prompt that
// stopped running — so none of them is left to the reading of the code.

function rev(overrides: Partial<AgentPromptRevision> = {}): AgentPromptRevision {
  return { agentKind: 'coder', revision: 1, text: 'text', createdAt: 10, ...overrides }
}

describe('workspacePromptVersions', () => {
  it('projects one row per revision, newest first within a kind', () => {
    const rows = workspacePromptVersions([
      rev({ revision: 1, text: 'v1' }),
      rev({ revision: 2, text: 'v2' }),
    ])
    expect(rows.map((r) => [r.version, r.systemText])).toEqual([
      [2, 'v2'],
      [1, 'v1'],
    ])
    expect(rows.every((r) => r.origin === 'workspace')).toBe(true)
  })

  it('numbers rows with the WORKSPACE revision, so both surfaces agree', () => {
    // The pipeline builder's history calls this "version 4"; a sandbox-local counter would make
    // "promote v4" and "restore v4" name different prompts.
    const [row] = workspacePromptVersions([rev({ revision: 4 })])
    expect(row?.version).toBe(4)
    expect(row?.id).toBe('workspace:coder:4')
  })

  it('skips a revert revision, which has no text to run', () => {
    // `text: null` means "follow the shipped prompt" — already represented by the baseline row.
    // Projecting it would put an EMPTY system prompt into a matrix cell.
    const rows = workspacePromptVersions([
      rev({ revision: 1, text: 'v1' }),
      rev({ revision: 2, text: null }),
    ])
    expect(rows.map((r) => r.version)).toEqual([1])
  })

  it('marks the live row from the head of the log', () => {
    const rows = workspacePromptVersions([
      rev({ revision: 1, text: 'v1' }),
      rev({ revision: 2, text: 'v2' }),
    ])
    expect(rows.find((r) => r.live)?.version).toBe(2)
  })

  it('marks NOTHING live on a reverted kind', () => {
    // The head is the revert, which is not projected. Inferring "live" from the highest projected
    // row would badge v1 as running when the workspace went back to the built-in.
    const rows = workspacePromptVersions([
      rev({ revision: 1, text: 'v1' }),
      rev({ revision: 2, text: null }),
    ])
    expect(rows.some((r) => r.live)).toBe(false)
  })

  it('drops a kind the sandbox cannot run', () => {
    // Offering a prompt for a kind no experiment can exercise is a matrix cell that can never be
    // built. `merger` is overridable in the pipeline builder but is not in the sandbox catalog.
    expect(workspacePromptVersions([rev({ agentKind: 'merger' })])).toEqual([])
  })

  it('groups a kind’s revisions under one lineage', () => {
    const rows = workspacePromptVersions([
      rev({ revision: 1, text: 'v1' }),
      rev({ revision: 2, text: 'v2' }),
    ])
    expect(new Set(rows.map((r) => r.lineageId))).toEqual(new Set(['workspace:coder']))
  })
})

describe('parseWorkspacePromptVersionId', () => {
  it('round-trips a projected id', () => {
    expect(parseWorkspacePromptVersionId('workspace:coder:3')).toEqual({
      agentKind: 'coder',
      revision: 3,
    })
  })

  it('rejects anything that is not one', () => {
    for (const id of ['baseline:build', 'sbp_123', 'workspace:coder', 'workspace:coder:0']) {
      expect(parseWorkspacePromptVersionId(id)).toBeNull()
    }
  })
})

describe('sandboxPromptKinds', () => {
  it('returns the catalog, or the single requested kind when it is in it', () => {
    expect(sandboxPromptKinds().length).toBeGreaterThan(1)
    expect(sandboxPromptKinds('coder')).toEqual(['coder'])
    // A kind outside the catalog asks for nothing, so the caller skips the read entirely rather
    // than issuing a query whose results it would discard.
    expect(sandboxPromptKinds('merger')).toEqual([])
  })
})
