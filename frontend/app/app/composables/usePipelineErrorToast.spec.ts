import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePipelineErrorToast, parseConflict } from '~/composables/usePipelineErrorToast'
import { ApiError } from '~/composables/api/errors'
import en from '../../i18n/locales/en.json'

/**
 * The i18n pilot: the pipeline-error toast resolves user-facing copy from
 * `errors.conflict.*` message KEYS by the backend's machine-readable `reason`, and only
 * ever shows raw backend prose as a last-resort description. These specs assert the KEYS
 * and params a code path resolves (never the English text), so they stay locale-agnostic.
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
let openAiProviderSetup: ReturnType<typeof vi.fn>

beforeEach(() => {
  add = vi.fn()
  // `t` echoes the key so the toast's title/description IS the resolved key — assert on it.
  t = vi.fn((key: string) => key)
  openAiProviderSetup = vi.fn()
  vi.stubGlobal('useToast', () => ({ add }))
  vi.stubGlobal('useUiStore', () => ({ openAiProviderSetup }))
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

  it('falls back to the caller fallback key when the reason has no dedicated title', () => {
    usePipelineErrorToast().present(conflict('totally_unknown_reason'), 'errors.action.retryFailed')
    expect(add.mock.calls[0]![0].title).toBe('errors.action.retryFailed')
  })

  it('shows the raw backend message as the conflict description', () => {
    usePipelineErrorToast().present(conflict('dependencies_unmet', {}, 'A depends on B'))
    expect(add.mock.calls[0]![0].description).toBe('A depends on B')
  })

  it('falls back to a translated description when the backend sends no message', () => {
    usePipelineErrorToast().present(conflict('dependencies_unmet'))
    expect(add.mock.calls[0]![0].description).toBe('errors.conflict.fallbackMessage')
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
    expect(openAiProviderSetup).toHaveBeenCalledOnce()
  })

  it('uses the fallback title key + raw message for a non-conflict error', () => {
    usePipelineErrorToast().present(new Error('boom'), 'errors.action.startFailed')
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.action.startFailed')
    expect(arg.description).toBe('boom')
  })
})
