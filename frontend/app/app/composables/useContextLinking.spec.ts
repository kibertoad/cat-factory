import { describe, expect, it } from 'vitest'
import {
  buildLinkFailureReport,
  contextKey,
  type LinkFailure,
  type PendingContext,
} from '~/composables/useContextLinking'

// The context-linking path used to swallow every attachment failure into a bare count.
// `buildLinkFailureReport` is the pure diagnostic dump the "Copy details" toast action
// puts on the clipboard, so it must carry the item coordinates, the HTTP status + backend
// code, and the server's message — the exact context a bug report needs.

function item(overrides: Partial<PendingContext> = {}): PendingContext {
  return {
    kind: 'document',
    source: 'github',
    externalId: 'acme/repo:docs/x.md',
    title: 'x.md',
    needsImport: true,
    ...overrides,
  }
}

describe('buildLinkFailureReport', () => {
  it('captures every failure with its coordinates, status, code, and message', () => {
    const failures: LinkFailure[] = [
      {
        item: item(),
        message: 'GitHub denied access to "docs/x.md" in acme/repo (HTTP 403).',
        status: 403,
        code: 'conflict',
      },
    ]

    const report = buildLinkFailureReport(failures, {
      workspaceId: 'ws_1',
      blockId: 'blk_1',
      when: '2026-07-19T00:00:00.000Z',
    })

    expect(report).toContain('Context link failures: 1')
    expect(report).toContain('workspace: ws_1')
    expect(report).toContain('block: blk_1')
    expect(report).toContain('document/github: acme/repo:docs/x.md')
    expect(report).toContain('status: 403')
    expect(report).toContain('code: conflict')
    expect(report).toContain('error: GitHub denied access')
  })

  it('omits absent optional fields (no status/code/context)', () => {
    const report = buildLinkFailureReport([{ item: item(), message: 'network error' }])
    expect(report).toContain('Context link failures: 1')
    expect(report).not.toContain('status:')
    expect(report).not.toContain('code:')
    expect(report).not.toContain('workspace:')
    expect(report).toContain('error: network error')
  })
})

describe('contextKey', () => {
  it('is stable and distinguishes kind/source/externalId', () => {
    expect(contextKey(item())).toBe('document:github:acme/repo:docs/x.md')
    expect(contextKey(item({ kind: 'task', source: 'github' }))).toBe(
      'task:github:acme/repo:docs/x.md',
    )
  })
})
