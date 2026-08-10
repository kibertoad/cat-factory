import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  usePipelineErrorToast,
  parseConflict,
  describeGenericFailure,
} from '~/composables/usePipelineErrorToast'
import { ApiError } from '~/composables/api/errors'
import en from '../../i18n/locales/en.json'

/**
 * The clipboard seam is mocked so the COPIED TEXT is assertable (and so the spec needs no
 * `navigator.clipboard`). What the copy action carries is the whole point of it: a reader pastes
 * that string into a bug report, and if the `requestId` is missing from it there is nothing joining
 * the report to the one server log line that explains the failure.
 */
const copied: string[] = []
vi.mock('~/composables/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({
    copy: async (text: string) => void copied.push(text),
    copyAction: (text: string) => ({
      label: 'common.copyDetails',
      icon: 'i-lucide-clipboard',
      onClick: () => void copied.push(text),
    }),
    isSupported: { value: true },
  }),
}))

/**
 * The i18n pilot: the pipeline-error toast resolves user-facing copy from
 * `errors.conflict.*` message KEYS by the backend's machine-readable `reason` — both the
 * title AND the description (G1) — and only ever shows raw backend prose as a last-resort
 * description (an unmapped reason). These specs assert the KEYS and params a code path
 * resolves (never the English text), so they stay locale-agnostic.
 *
 * The same holds for the NON-conflict funnel (G2): the description is keyed off the envelope's
 * status class and the raw prose is only reachable behind the "Show details" disclosure.
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
let update: ReturnType<typeof vi.fn>
let t: ReturnType<typeof vi.fn>
let ui: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  // `add` returns the created toast (Nuxt UI hands back the generated id synchronously), which
  // the detail disclosure needs in order to `update` the SAME toast in place.
  add = vi.fn(() => ({ id: 'toast-1' }))
  update = vi.fn()
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
  vi.stubGlobal('useToast', () => ({ add, update }))
  vi.stubGlobal('useUiStore', () => ui)
  // Stubbed on the Nuxt app's GLOBAL i18n instance, which is what this composable resolves
  // (never `useI18n()`): it is called from store setup, where no component instance exists.
  // See `frontend/app/README.md` — "A store must be instantiable outside a component setup".
  vi.stubGlobal('useNuxtApp', () => ({ $i18n: { t, te: (key: string) => hasKey(key) } }))
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

  it('uses the fallback title key + a TRANSLATED description for a non-conflict error', () => {
    // G2: the raw JS/backend prose is no longer the description — a bare throw with no HTTP
    // answer at all is presented as the network case.
    usePipelineErrorToast().present(new Error('boom'), 'errors.action.startFailed')
    const arg = add.mock.calls[0]![0]
    expect(arg.title).toBe('errors.action.startFailed')
    expect(arg.description).toBe('errors.generic.description.network')
    expect(arg.description).not.toBe('boom')
  })

  it('keys the description off the envelope status class, not the backend prose', () => {
    usePipelineErrorToast().present(
      new ApiError(503, { error: { code: 'unavailable', message: 'Task sources not configured' } }),
    )
    expect(add.mock.calls[0]![0].description).toBe('errors.generic.description.unavailable')
  })

  it('reveals the raw detail in place when "Show details" is clicked', () => {
    usePipelineErrorToast().present(
      new ApiError(503, { error: { code: 'unavailable', message: 'Task sources not configured' } }),
    )
    const arg = add.mock.calls[0]![0]
    expect(arg.actions[0].label).toBe('errors.generic.showDetail')
    arg.actions[0].onClick()
    // The SAME toast, not a second one, so the two readings can't sit on screen disagreeing. The
    // disclosure button is dropped (it would now be a no-op) and the copy action is re-passed,
    // because `update` merges over the existing toast and copying is still the point.
    expect(add).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('toast-1', {
      description: 'Task sources not configured',
      actions: [expect.objectContaining({ label: 'common.copyDetails' })],
    })
  })

  it('does NOT auto-dismiss, and can be copied whole in one click', () => {
    // Both properties are the reason a failure goes through this funnel at all: the toast a user
    // needs to read, quote or act on used to vanish after ~5s, and its detail could only be
    // retyped off the screen. `duration: 0` keeps it until dismissed (it still has a close
    // button); the copy action carries the failed action, the failure class, the backend prose and
    // the requestId in one string.
    usePipelineErrorToast().present(
      new ApiError(503, {
        error: { code: 'unavailable', message: 'Task sources not configured', requestId: 'req-9' },
      }),
      'errors.action.startFailed',
    )
    const arg = add.mock.calls[0]![0]
    expect(arg.duration).toBe(0)
    const copy = arg.actions.find((a: { label: string }) => a.label === 'common.copyDetails')
    copy.onClick()
    expect(copied[copied.length - 1]).toBe(
      [
        'errors.action.startFailed',
        'errors.generic.description.unavailable',
        'Task sources not configured · errors.generic.requestId',
      ].join('\n'),
    )
  })

  it('folds validation issues and the requestId into the revealed detail', () => {
    usePipelineErrorToast().present(
      new ApiError(400, {
        error: {
          code: 'validation',
          message: 'Request failed validation',
          requestId: 'req-42',
          issues: [{ path: 'body.title', message: 'Required' }, { message: 'Unexpected field' }],
        },
      }),
    )
    const arg = add.mock.calls[0]![0]
    expect(arg.description).toBe('errors.generic.description.validation')
    arg.actions[0].onClick()
    expect(t).toHaveBeenCalledWith('errors.generic.requestId', { id: 'req-42' })
    // The issues carry the real information on a 422/400 (the message is the fixed
    // `Request failed validation`), so they must reach the disclosure.
    expect(update.mock.calls[0]![1].description).toBe(
      'Request failed validation · body.title: Required, Unexpected field · errors.generic.requestId',
    )
  })

  it('offers no disclosure when there is no detail to reveal, but still offers the copy', () => {
    usePipelineErrorToast().present(new ApiError(503, { error: { code: 'unavailable' } }))
    const arg = add.mock.calls[0]![0]
    // `ApiError` synthesises `Request failed (HTTP 503)` when the envelope carries no message,
    // so a truly detail-less case is a non-Error throw.
    expect(arg.description).toBe('errors.generic.description.unavailable')
    expect(arg.actions[0].label).toBe('errors.generic.showDetail')
    usePipelineErrorToast().present(null)
    // A disclosure that reveals nothing is worse than none, but the two translated lines are still
    // worth copying: they name the action that failed and the class of failure.
    expect(add.mock.calls[1]![0].actions).toEqual([
      expect.objectContaining({ label: 'common.copyDetails' }),
    ])
  })
})

describe('describeGenericFailure', () => {
  it('maps each known status class to its own description key', () => {
    for (const code of [
      'not_found',
      'validation',
      'credential_required',
      'forbidden',
      'unavailable',
      'unauthorized',
      'rate_limited',
      'internal',
    ]) {
      const failure = describeGenericFailure(new ApiError(500, { error: { code } }))
      expect(failure.descriptionKey).toBe(`errors.generic.description.${code}`)
      expect(hasKey(failure.descriptionKey)).toBe(true)
    }
  })

  it('separates "nothing answered" from "something answered unrecognisably"', () => {
    // No envelope AND no status: offline / DNS / dropped connection — the remedy is the user's.
    expect(describeGenericFailure(new Error('Failed to fetch')).descriptionKey).toBe(
      'errors.generic.description.network',
    )
    // A status but not our envelope (an edge 502 page) — the remedy is the server's.
    expect(
      describeGenericFailure(new ApiError(502, '<html>bad gateway</html>')).descriptionKey,
    ).toBe('errors.generic.description.unexpected')
    // Our envelope, but a code this build does not know.
    expect(
      describeGenericFailure(new ApiError(418, { error: { code: 'teapot' } })).descriptionKey,
    ).toBe('errors.generic.description.unexpected')
  })

  it('never presents a conflict (parseConflict owns those) but still classifies safely', () => {
    // `conflict` is deliberately absent from the map, so it reads as an unrecognised code rather
    // than throwing — the conflict path intercepts it long before this function is reached.
    expect(
      describeGenericFailure(new ApiError(409, { error: { code: 'conflict' } })).descriptionKey,
    ).toBe('errors.generic.description.unexpected')
  })
})
