import type { ParsedConflict } from '~/composables/usePipelineErrorToast'

/**
 * The bespoke conflict toasts: the five 409 reasons whose copy interpolates runtime detail and
 * whose remedy is a one-click jump into the panel that fixes them. Split out of
 * {@link usePipelineErrorToast} purely for size — it closes over the SAME toast / ui / i18n
 * handles, so behaviour is identical to the former in-composable functions.
 */
export function createBespokeConflictToasts(deps: {
  toast: ReturnType<typeof useToast>
  ui: ReturnType<typeof useUiStore>
  t: ReturnType<typeof useI18n>['t']
  te: ReturnType<typeof useI18n>['te']
}): (conflict: ParsedConflict) => boolean {
  const { toast, ui, t, te } = deps
  // The headline case: a pipeline step's model has no usable provider. Name the
  // offending model(s), explain no provider is available, and offer the one-click jump
  // to the AI setup — the same remedy the startup "No AI model configured" banner gives.
  function presentProvidersUnconfigured(conflict: ParsedConflict): void {
    const models = Array.isArray(conflict.details.models) ? conflict.details.models : []
    const list = models.join(', ')
    toast.add({
      title: t('errors.conflict.providersUnconfigured.title'),
      description: list
        ? t('errors.conflict.providersUnconfigured.body', { models: list })
        : (conflict.message ?? t('errors.conflict.fallbackMessage')),
      color: 'error',
      icon: 'i-lucide-cpu',
      // Stay until dismissed: an actionable toast whose remedy button vanishes on the ~5s
      // auto-dismiss takes the one-click fix with it before the user can reach it.
      duration: 0,
      actions: [
        {
          label: t('errors.conflict.providersUnconfigured.action'),
          icon: 'i-lucide-settings',
          onClick: () => ui.openAiProviderSetup(),
        },
      ],
    })
  }

  // A pipeline step relies on binary-artifact storage (the UI Tester uploads screenshots)
  // but the account has none configured. Explain it and offer the jump to the content-storage
  // settings — the same shape as the providers-unconfigured case above. Prefer the localized
  // body (it carries no runtime interpolation) so non-English users see translated copy; the
  // raw backend prose is only the last-resort fallback when the locale lacks the key.
  function presentBinaryStorageUnconfigured(conflict: ParsedConflict): void {
    toast.add({
      title: t('errors.conflict.binaryStorageUnconfigured.title'),
      description: te('errors.conflict.binaryStorageUnconfigured.body')
        ? t('errors.conflict.binaryStorageUnconfigured.body')
        : (conflict.message ?? t('errors.conflict.fallbackMessage')),
      color: 'error',
      icon: 'i-lucide-image',
      // Sticky, like the providers-unconfigured toast above: keep the "Configure storage"
      // remedy reachable instead of letting it auto-dismiss.
      duration: 0,
      actions: [
        {
          label: t('errors.conflict.binaryStorageUnconfigured.action'),
          icon: 'i-lucide-settings',
          onClick: () => ui.openContentStorageSettings(),
        },
      ],
    })
  }

  // A pipeline includes a Deployer, but the SERVICE's ephemeral-environment config (the in-repo
  // "what/where") is incomplete for its declared type. Steer the user straight to THAT service's
  // environment config — the compose wizard for docker-compose, the service inspector otherwise —
  // falling back to the workspace infrastructure window if the frame id wasn't carried.
  function presentDeployerServiceConfig(conflict: ParsedConflict): void {
    const frameId =
      typeof conflict.details.frameId === 'string' ? conflict.details.frameId : undefined
    const provisionType =
      typeof conflict.details.provisionType === 'string'
        ? conflict.details.provisionType
        : undefined
    const missing = Array.isArray(conflict.details.missing)
      ? conflict.details.missing.join(', ')
      : ''
    toast.add({
      title: t('errors.conflict.deployerServiceConfig.title'),
      description: missing
        ? t('errors.conflict.deployerServiceConfig.body', { missing })
        : (conflict.message ?? t('errors.conflict.fallbackMessage')),
      color: 'error',
      icon: 'i-lucide-server',
      // Sticky, like the other actionable conflicts: keep the "Fix configuration" jump reachable.
      duration: 0,
      actions: [
        {
          label: t('errors.conflict.deployerServiceConfig.action'),
          icon: 'i-lucide-settings',
          onClick: () => {
            if (frameId && provisionType === 'docker-compose') ui.openEnvironmentSetup(frameId)
            else if (frameId) ui.select(frameId)
            else ui.openProviderConnection('environment')
          },
        },
      ],
    })
  }

  // A pipeline includes a Deployer and the service config is sound, but no WORKSPACE handler
  // resolves for the service's provision type (missing or ambiguous). Steer to the Infrastructure
  // window's Test-environments tab. (Also raised by the Tester start gate — same fix applies.)
  function presentProvisionTypeUnhandled(conflict: ParsedConflict): void {
    const type =
      typeof conflict.details.provisionType === 'string' ? conflict.details.provisionType : ''
    toast.add({
      title: t('errors.conflict.provisionTypeUnhandled.title'),
      description: type
        ? t('errors.conflict.provisionTypeUnhandled.body', { type })
        : (conflict.message ?? t('errors.conflict.fallbackMessage')),
      color: 'error',
      icon: 'i-lucide-server-cog',
      duration: 0,
      actions: [
        {
          label: t('errors.conflict.provisionTypeUnhandled.action'),
          icon: 'i-lucide-settings',
          onClick: () => ui.openProviderConnection('environment'),
        },
      ],
    })
  }

  // A pipeline includes a Deployer, the config is structurally complete, but the live connection
  // probe of the resolved deployment integration failed (unreachable endpoint / apiserver, bad
  // token). Surface the provider's failure detail and steer to the handler to fix + re-test it.
  function presentDeployerConnectionFailed(conflict: ParsedConflict): void {
    const detail = typeof conflict.details.detail === 'string' ? conflict.details.detail : undefined
    toast.add({
      title: t('errors.conflict.deployerConnectionFailed.title'),
      description: detail
        ? t('errors.conflict.deployerConnectionFailed.body', { detail })
        : (conflict.message ?? t('errors.conflict.fallbackMessage')),
      color: 'error',
      icon: 'i-lucide-plug',
      duration: 0,
      actions: [
        {
          label: t('errors.conflict.deployerConnectionFailed.action'),
          icon: 'i-lucide-settings',
          onClick: () => ui.openProviderConnection('environment'),
        },
      ],
    })
  }

  /**
   * Dispatch the bespoke conflict reasons (a runtime-interpolated body + a "configure X" action,
   * each with its own key namespace — the ones excluded from `CONFLICT_INFO`). Returns `true` when
   * the reason was one of them (and the toast was raised), `false` to fall through to the generic
   * map. The reason values are mutually exclusive, so dispatch order is irrelevant.
   */
  function presentBespokeConflict(conflict: ParsedConflict): boolean {
    switch (conflict.reason) {
      case 'providers_unconfigured':
        presentProvidersUnconfigured(conflict)
        return true
      case 'binary_storage_unconfigured':
        presentBinaryStorageUnconfigured(conflict)
        return true
      case 'deployer_service_provisioning_incomplete':
        presentDeployerServiceConfig(conflict)
        return true
      case 'provision_type_unhandled':
        presentProvisionTypeUnhandled(conflict)
        return true
      case 'deployer_connection_test_failed':
        presentDeployerConnectionFailed(conflict)
        return true
      default:
        return false
    }
  }

  return presentBespokeConflict
}
