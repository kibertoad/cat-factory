import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyRunDeepLink, captureRunDeepLink, type PendingRunLink } from './useRunDeepLink'

/** Point `window.location` + `history` at a URL the capture can read and rewrite. */
function setUrl(search: string): void {
  history.replaceState(null, '', `/${search}`)
}

describe('captureRunDeepLink', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setUrl('')
  })

  it('returns null when the URL carries no run link', () => {
    setUrl('?other=1')
    expect(captureRunDeepLink()).toBeNull()
    // An unrelated param is left alone.
    expect(window.location.search).toBe('?other=1')
  })

  it('parses the report link the engine emits', () => {
    setUrl('?ws=ws_1&block=blk_1&run=exec_1&view=observability')
    expect(captureRunDeepLink()).toEqual({
      workspaceId: 'ws_1',
      blockId: 'blk_1',
      runId: 'exec_1',
      view: 'observability',
    })
  })

  it('parses the captured-evidence link the lifecycle section emits', () => {
    setUrl('?ws=ws_1&block=blk_1&run=exec_1&view=test-evidence')
    expect(captureRunDeepLink()?.view).toBe('test-evidence')
  })

  it('strips its own params so a reload does not re-open the panel', () => {
    setUrl('?ws=ws_1&run=exec_1&view=observability&keep=yes')
    captureRunDeepLink()
    // Only the link's own params are consumed; anything else survives.
    expect(window.location.search).toBe('?keep=yes')
    // …and a second read finds nothing left to replay.
    expect(captureRunDeepLink()).toBeNull()
  })

  it('tolerates a partial link (run id alone still resolves)', () => {
    setUrl('?run=exec_1')
    expect(captureRunDeepLink()).toEqual({
      workspaceId: null,
      blockId: null,
      runId: 'exec_1',
      view: null,
    })
  })
})

describe('applyRunDeepLink', () => {
  function surfaces() {
    return {
      revealTask: vi.fn(),
      openRun: vi.fn(),
      openOutcome: vi.fn(),
      openObservability: vi.fn(),
      openTestEvidence: vi.fn(),
    }
  }

  function link(view: string | null, blockId: string | null = 'blk_1'): PendingRunLink {
    return { workspaceId: 'ws_1', blockId, runId: 'exec_1', view }
  }

  it('brings the task into view and opens its running pipeline when no view is named', () => {
    const opened = surfaces()
    applyRunDeepLink(link(null), opened)
    expect(opened.revealTask).toHaveBeenCalledWith('blk_1')
    expect(opened.openRun).toHaveBeenCalledWith('blk_1')
    expect(opened.openObservability).not.toHaveBeenCalled()
  })

  it('opens the running pipeline for view=run, the same as no view', () => {
    const opened = surfaces()
    applyRunDeepLink(link('run'), opened)
    expect(opened.openRun).toHaveBeenCalledWith('blk_1')
  })

  it.each([
    ['observability', 'openObservability', ['exec_1']],
    ['test-evidence', 'openTestEvidence', ['exec_1']],
    ['outcome', 'openOutcome', ['exec_1', 'blk_1']],
  ] as const)('opens %s for its run, beside the task brought into view', (view, surface, args) => {
    const opened = surfaces()
    applyRunDeepLink(link(view), opened)
    expect(opened.revealTask).toHaveBeenCalledWith('blk_1')
    expect(opened[surface]).toHaveBeenCalledWith(...args)
    expect(opened.openRun).not.toHaveBeenCalled()
  })

  it('lands on the task and opens nothing for a view it does not know', () => {
    const opened = surfaces()
    applyRunDeepLink(link('not-a-view'), opened)
    expect(opened.revealTask).toHaveBeenCalledWith('blk_1')
    for (const open of [opened.openRun, opened.openOutcome, opened.openObservability]) {
      expect(open).not.toHaveBeenCalled()
    }
  })

  it('opens no focus view and moves no camera for a link naming no task', () => {
    const opened = surfaces()
    applyRunDeepLink(link(null, null), opened)
    expect(opened.revealTask).not.toHaveBeenCalled()
    expect(opened.openRun).not.toHaveBeenCalled()
  })
})
