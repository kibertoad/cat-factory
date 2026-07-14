import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePipelineErrorToast, parseConflict } from '~/composables/usePipelineErrorToast'
import { ApiError } from '~/composables/api/errors'
import en from '../../i18n/locales/en.json'

/**
 * The i18n pilot: the pipeline-error toast resolves user-facing copy from
 * `errors.conflict.*` message KEYS by the backend's machine-readable `reason` — both the
 * title AND the description (G1) — and only ever shows raw backend prose as a last-resort
 * description (an unmapped reason). These specs assert the KEYS and params a code path
 * resolves (never the English text), so they stay locale-agnostic.
 */

/** Dot-path lookup into the real `en.json`, so `te` mirrors which keys actually ship. */
function hasKey(path: string): boolean {
  return (
    path.split('.').reduce<unknown>((node, seg) => {
      return node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined
    }, en) !== undefined
  )
}

let add: ReturnType<typeof vi.fn>
let t: ReturnType<typeof vi.fn>
let ui: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  add = vi.fn()
  // `t` echoes the key so the toast's title/description IS the resolved key — assert on it.
  t = vi.fn((key: string) => key)
  // The ui-store deep-links a jump action may navigate to (each echoed as a spy).
  ui = {
    openAiProviderSetup: vi.fn(),
    openGitHub: vi.fn(),
    openInfrastructure: vi.fn(),
    openModelConfig: vi.fn(),
    openProviderConnection: vi.fn(),
  }
  vi.stubGlobal('useToast', () => ({ add }))
  vi.stubGlobal('useUiStore', () => ui)
  vi.stubGlobal('useI18n', () => ({ t, te: (key: string) => hasKey(key) }))
})

function conflict(reason?: string, details: Record<string, unknown> = {}, message?: string) {
  return new ApiError(409, {
    error: { code: 'conflict', message, details: { reason, ...details } },
  })
}

describe('parseConflict', () => {
  it('extracts reason + raw message + details from a 409 conflict', () => {
    const parsed = parseConflict(conflict('dependencies_unmet', { foo: 1 }, 'raw msg'))
    expect(parsed).toEqual({
      reason: 'dependencies_unmet',
      message: 'raw msg',
      details: { reason: 'dependencies_unmet', foo: 1 },
    })
  })

  it('returns null for a non-conflict error', () => {
    expect(parseConflict(new ApiError(500, { error: { code: 'internal' } }))).toBeNull()
    expect(parseConflict(new Error('network'))).toBeNull()
  })
})

describe('usePipelineErrorToast', () => {
  it('titles a mapped conflict reason from its errors.conflict.title.<reason> key', () => {
    usePipelineErrorToast().present(conflict('dependencies_unmet'))
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0]![0].title).toBe('errors.conflict.title.dependencies_unmet')
    expect(t).toHaveBeenCalledWith('errors.conflict.title.dependencies_unmet')
  })

  it('resolves a mapped reason to its translated description key (G1), not the raw message', () => {
    // A mapped reason now owns translated copy: the backend prose is NOT shown even when present.
    usePipelineErrorToast().present(conflict('dependencies_unmet', {}, 'A depends on B'))
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.conflict.title.dependencies_unmet')
    expect(arg.description).toBe('errors.conflict.description.dependencies_unmet')
  })

  it('falls back to the caller fallback key + raw message for an UNKNOWN reason', () => {
    usePipelineErrorToast().present(
      conflict('totally_unknown_reason', {}, 'raw detail'),
      'errors.action.retryFailed',
    )
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.action.retryFailed')
    // Unmapped reason ⇒ raw backend prose is the last-resort description.
    expect(arg.description).toBe('raw detail')
    expect(arg.actions).toBeUndefined()
  })

  it('shows the fallback message for an unknown reason with no backend message', () => {
    usePipelineErrorToast().present(conflict('totally_unknown_reason'))
    expect(add.mock.calls[0]![0].description).toBe('errors.conflict.fallbackMessage')
  })

  it('offers a jump action for a reason with a UI remedy (github_not_connected → connect GitHub)', () => {
    usePipelineErrorToast().present(conflict('github_not_connected'))
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.conflict.title.github_not_connected')
    expect(arg.description).toBe('errors.conflict.description.github_not_connected')
    // Actionable toasts stay until dismissed so the one-click remedy is reachable.
    expect(arg.duration).toBe(0)
    expect(arg.actions[0].label).toBe('errors.conflict.action.connectGitHub')
    arg.actions[0].onClick()
    expect(ui.openGitHub).toHaveBeenCalledOnce()
  })

  it('leaves a reason without a UI remedy as a plain (auto-dismissing) toast', () => {
    usePipelineErrorToast().present(conflict('dependencies_unmet'))
    const arg = add.mock.calls[0]![0]
    expect(arg.duration).toBeUndefined()
    expect(arg.actions).toBeUndefined()
  })

  it('interpolates the model list for providers_unconfigured and offers the AI setup jump', () => {
    usePipelineErrorToast().present(
      conflict('providers_unconfigured', { models: ['gpt-x', 'claude-y'] }),
    )
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.conflict.providersUnconfigured.title')
    expect(t).toHaveBeenCalledWith('errors.conflict.providersUnconfigured.body', {
      models: 'gpt-x, claude-y',
    })
    arg.actions[0].onClick()
    expect(ui.openAiProviderSetup).toHaveBeenCalledOnce()
  })

  it('uses the fallback title key + raw message for a non-conflict error', () => {
    usePipelineErrorToast().present(new Error('boom'), 'errors.action.startFailed')
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.action.startFailed')
    expect(arg.description).toBe('boom')
  })
})
