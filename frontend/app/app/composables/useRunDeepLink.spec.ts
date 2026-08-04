import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { captureRunDeepLink } from './useRunDeepLink'

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
