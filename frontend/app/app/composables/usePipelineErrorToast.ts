/**
 * Turn a failed run-control API call (start / restart / retry / merge) into an actionable
 * toast. The backend tags every 409 conflict with a distinct, machine-readable
 * `error.details.reason` (kernel `ConflictReason`), so we can word each case precisely
 * instead of dumping the raw message — and, for `providers_unconfigured`, surface the
 * SAME guidance + "Configure AI" jump as the no-AI-provider startup banner.
 */

/** The parsed shape of a backend conflict (`{ error: { code: 'conflict', details } }`). */
interface ConflictDetails {
  reason?: string
  models?: string[]
  [key: string]: unknown
}

/** Pull a 409 conflict's `{ reason, message, details }` out of a thrown fetch error, else null. */
export function parseConflict(
  error: unknown,
): { reason?: string; message: string; details: ConflictDetails } | null {
  const body = (
    error as { data?: { error?: { code?: string; message?: string; details?: ConflictDetails } } }
  )?.data?.error
  if (body?.code !== 'conflict') return null
  const details = body.details ?? {}
  return {
    reason: typeof details.reason === 'string' ? details.reason : undefined,
    message: body.message ?? 'This action conflicts with the current state.',
    details,
  }
}

/** Per-reason toast titles for conflicts that don't get bespoke handling below. */
const CONFLICT_TITLES: Record<string, string> = {
  dependencies_unmet: 'Blocked by dependencies',
  task_limit_reached: 'Concurrency limit reached',
  tester_infra_unsupported: 'Test infrastructure not configured',
  run_not_retryable: 'Run can’t be retried',
  no_pr_to_merge: 'No PR to merge',
  github_not_connected: 'GitHub not connected',
  bootstrap_not_retryable: 'Bootstrap can’t be retried',
  bootstrap_reference_missing: 'Reference architecture is gone',
}

export function usePipelineErrorToast() {
  const toast = useToast()
  const ui = useUiStore()

  /**
   * Present `error` as a toast. `fallbackTitle` is used for non-conflict failures and any
   * conflict reason without a dedicated title.
   */
  function present(error: unknown, fallbackTitle = 'Action failed'): void {
    const conflict = parseConflict(error)

    // The headline case: a pipeline step's model has no usable provider. Name the
    // offending model(s), explain no provider is available, and offer the one-click jump
    // to the AI setup — the same remedy the startup "No AI model configured" banner gives.
    if (conflict?.reason === 'providers_unconfigured') {
      const models = Array.isArray(conflict.details.models) ? conflict.details.models : []
      const list = models.join(', ')
      toast.add({
        title: 'No AI provider for this model',
        description: list
          ? `No provider is configured for ${list}. Add a provider key, connect a subscription, ` +
            'or enable Cloudflare AI to run it.'
          : conflict.message,
        color: 'error',
        icon: 'i-lucide-cpu',
        actions: [
          {
            label: 'Configure AI',
            icon: 'i-lucide-settings',
            onClick: () => ui.openAiProviderSetup(),
          },
        ],
      })
      return
    }

    if (conflict) {
      toast.add({
        title: CONFLICT_TITLES[conflict.reason ?? ''] ?? fallbackTitle,
        description: conflict.message,
        color: 'warning',
        icon: 'i-lucide-triangle-alert',
      })
      return
    }

    // Not a conflict (a 4xx/5xx or a network fault) — surface its message plainly.
    toast.add({
      title: fallbackTitle,
      description: error instanceof Error ? error.message : String(error),
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  }

  return { present }
}
