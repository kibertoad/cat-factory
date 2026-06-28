/**
 * Turn a failed run-control API call (start / restart / retry / merge) into an actionable
 * toast. The backend tags every 409 conflict with a distinct, machine-readable
 * `error.details.reason` (kernel `ConflictReason`), so we can word each case precisely
 * instead of dumping the raw message — and, for `providers_unconfigured`, surface the
 * SAME guidance + "Configure AI" jump as the no-AI-provider startup banner.
 *
 * i18n boundary (see CLAUDE.md / the i18n plan): user-facing titles are resolved from
 * `errors.conflict.*` message keys by the machine-readable `reason`. The raw backend
 * `message` is shown only as the description fallback and stays untranslated — the
 * contract is "if a server message must be localizable, the backend emits a code and the
 * frontend maps it", not "translate arbitrary server prose on the client".
 */

import { apiErrorEnvelope } from './api/errors'

/** The parsed shape of a backend conflict (`{ error: { code: 'conflict', details } }`). */
interface ConflictDetails {
  reason?: string
  models?: string[]
  [key: string]: unknown
}

/**
 * Pull a 409 conflict's `{ reason, message, details }` out of a thrown API error, else null.
 * `message` is the raw backend prose (may be absent); the translated fallback is applied at
 * the call site where the i18n `t` is available.
 */
export function parseConflict(
  error: unknown,
): { reason?: string; message?: string; details: ConflictDetails } | null {
  const body = apiErrorEnvelope(error)
  if (body?.code !== 'conflict') return null
  const details = (body.details as ConflictDetails | undefined) ?? {}
  return {
    reason: typeof details.reason === 'string' ? details.reason : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    details,
  }
}

export function usePipelineErrorToast() {
  const toast = useToast()
  const ui = useUiStore()
  const { t, te } = useI18n()

  /**
   * Present `error` as a toast. `fallbackTitleKey` is an i18n message key used for
   * non-conflict failures and any conflict reason without a dedicated title.
   */
  function present(error: unknown, fallbackTitleKey = 'common.actionFailed'): void {
    const conflict = parseConflict(error)

    // The headline case: a pipeline step's model has no usable provider. Name the
    // offending model(s), explain no provider is available, and offer the one-click jump
    // to the AI setup — the same remedy the startup "No AI model configured" banner gives.
    if (conflict?.reason === 'providers_unconfigured') {
      const models = Array.isArray(conflict.details.models) ? conflict.details.models : []
      const list = models.join(', ')
      toast.add({
        title: t('errors.conflict.providersUnconfigured.title'),
        description: list
          ? t('errors.conflict.providersUnconfigured.body', { models: list })
          : (conflict.message ?? t('errors.conflict.fallbackMessage')),
        color: 'error',
        icon: 'i-lucide-cpu',
        actions: [
          {
            label: t('errors.conflict.providersUnconfigured.action'),
            icon: 'i-lucide-settings',
            onClick: () => ui.openAiProviderSetup(),
          },
        ],
      })
      return
    }

    if (conflict) {
      // Per-reason title key; fall back to the caller's title key when this reason has no
      // dedicated copy (`te` = translation-exists, so a missing key never leaks as raw text).
      const reasonKey = `errors.conflict.title.${conflict.reason ?? ''}`
      toast.add({
        title: conflict.reason && te(reasonKey) ? t(reasonKey) : t(fallbackTitleKey),
        description: conflict.message ?? t('errors.conflict.fallbackMessage'),
        color: 'warning',
        icon: 'i-lucide-triangle-alert',
      })
      return
    }

    // Not a conflict (a 4xx/5xx or a network fault) — surface its message plainly.
    toast.add({
      title: t(fallbackTitleKey),
      description: error instanceof Error ? error.message : String(error),
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  }

  return { present }
}
