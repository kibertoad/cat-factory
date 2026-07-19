import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildLinkFailureReport,
  contextKey,
  type LinkFailure,
  type PendingContext,
  useContextLinking,
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

  it('dumps the backend details bag, distinguishing the upstream status from the HTTP status', () => {
    const report = buildLinkFailureReport([
      {
        item: item(),
        message: 'GitHub denied access to "docs/x.md" in acme/repo (HTTP 403).',
        status: 409,
        code: 'conflict',
        details: { owner: 'acme', repo: 'repo', path: 'docs/x.md', status: 403 },
      },
    ])
    // The mapped HTTP status and the upstream GitHub status are both present, unambiguously.
    expect(report).toContain('status: 409')
    expect(report).toContain('details.status: 403')
    expect(report).toContain('details.owner: acme')
    expect(report).toContain('details.path: docs/x.md')
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

describe('presentLinkFailures', () => {
  // Stub the Nuxt auto-imports `useContextLinking` pulls in, so the toast-orchestration
  // side of the composable can be exercised without a full Nuxt runtime.
  function stub() {
    const add = vi.fn()
    // `copyAction` echoes the text it would copy so we can assert the report content.
    const copyAction = vi.fn((text: string) => ({ label: 'copy', text, onClick: () => {} }))
    vi.stubGlobal('useDocumentsStore', () => ({}))
    vi.stubGlobal('useTasksStore', () => ({}))
    vi.stubGlobal('useWorkspaceStore', () => ({ workspaceId: 'ws_1' }))
    vi.stubGlobal('useToast', () => ({ add }))
    vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
    vi.stubGlobal('useCopyToClipboard', () => ({ copyAction }))
    return { add, copyAction }
  }

  afterEach(() => vi.unstubAllGlobals())

  it('is a no-op when nothing failed', () => {
    const { add } = stub()
    useContextLinking().presentLinkFailures([])
    expect(add).not.toHaveBeenCalled()
  })

  it('raises one sticky, actionable toast whose Copy action carries the full report', () => {
    const { add, copyAction } = stub()
    const failures: LinkFailure[] = [
      {
        item: item(),
        message: 'GitHub denied access to "docs/x.md" in acme/repo (HTTP 403).',
        status: 409,
        code: 'conflict',
        details: { owner: 'acme', repo: 'repo', path: 'docs/x.md', status: 403 },
      },
    ]
    useContextLinking().presentLinkFailures(failures, 'blk_1')

    expect(add).toHaveBeenCalledTimes(1)
    const toast = add.mock.calls[0]![0]
    // Sticky so the cause stays readable, titled by the count key, and per-item reason shown.
    expect(toast.title).toBe('board.addTask.linkFailed')
    expect(toast.duration).toBe(0)
    expect(toast.description).toContain('GitHub denied access')
    expect(toast.actions).toHaveLength(1)
    // The Copy action's payload is the full diagnostic report (block + upstream status).
    const report = copyAction.mock.calls[0]![0]
    expect(report).toContain('block: blk_1')
    expect(report).toContain('details.status: 403')
    expect(toast.actions[0]).toMatchObject({ text: report })
  })
})
