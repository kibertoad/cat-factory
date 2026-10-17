import type { ParsedConflict } from '~/composables/usePipelineErrorToast'
import {
  ENVIRONMENTS_FIX,
  gateSetupFix,
  type SetupConflictDeps,
  type SetupFix,
} from '~/composables/pipelineErrorToast/setupConflictGate'
import {
  BOARD_MEMBER_SETUP_OWNER,
  MODEL_SETUP_OWNER,
  SETUP_REMEDY_KEYS,
  canActOnSetup,
} from '~/utils/setupAudience'

/** One bespoke conflict toast, before the audience decides whether it carries the fix. */
interface SetupConflictToast {
  titleKey: string
  description: string
  icon: string
  actionKey: string
  fix: SetupFix
}

/**
 * The bespoke conflict toasts: the five 409 reasons whose copy interpolates runtime detail and
 * whose remedy is a one-click jump into the panel that fixes them. Split out of
 * {@link usePipelineErrorToast} for size; it closes over the SAME toast, i18n and copy handles.
 *
 * Each one is a setup gap, so its fix goes through {@link gateSetupFix}: only a caller who can act
 * gets the button. Everyone else gets the same toast with one more sentence naming who can fix it.
 * Either way the toast is a failure through the funnel, so it is copyable with the `requestId`,
 * which is what a member hands to the admin it names.
 */
export function createBespokeConflictToasts(
  deps: SetupConflictDeps & {
    toast: ReturnType<typeof useToast>
    t: ReturnType<typeof useI18n>['t']
    te: ReturnType<typeof useI18n>['te']
    copyAction: ReturnType<typeof useCopyToClipboard>['copyAction']
    report: (conflict: ParsedConflict, title: string, description: string) => string
  },
): (conflict: ParsedConflict) => boolean {
  const { toast, t, te } = deps

  function raise(conflict: ParsedConflict, spec: SetupConflictToast): void {
    const fix = gateSetupFix(spec.fix, deps.audience(), deps)
    const title = t(spec.titleKey)
    const description = fix.remedy
      ? `${spec.description} ${t(SETUP_REMEDY_KEYS[fix.remedy])}`
      : spec.description
    toast.add({
      title,
      description,
      color: 'error',
      icon: spec.icon,
      // Stay until dismissed: an actionable toast whose remedy button vanishes on the ~5s
      // auto-dismiss takes the one-click fix with it, and the line naming who can fix it is the
      // one thing a caller without the button has to read.
      duration: 0,
      ui: { description: 'select-text' },
      actions: [
        ...(fix.remedy
          ? []
          : [{ label: t(spec.actionKey), icon: 'i-lucide-settings', onClick: fix.run }]),
        deps.copyAction(deps.report(conflict, title, description)),
      ],
    })
  }

  /** The backend prose, else the generic line: what a toast says when its own body cannot render. */
  function fallback(conflict: ParsedConflict): string {
    return conflict.message ?? t('errors.conflict.fallbackMessage')
  }

  // The headline case: a pipeline step's model has no usable provider. Name the offending
  // model(s) and offer the AI setup, the same remedy the "No AI model configured" banner gives.
  function presentProvidersUnconfigured(conflict: ParsedConflict): void {
    const models = Array.isArray(conflict.details.models) ? conflict.details.models : []
    const list = models.join(', ')
    raise(conflict, {
      titleKey: 'errors.conflict.providersUnconfigured.title',
      description: list
        ? t('errors.conflict.providersUnconfigured.body', { models: list })
        : fallback(conflict),
      icon: 'i-lucide-cpu',
      actionKey: 'errors.conflict.providersUnconfigured.action',
      fix: { owner: () => MODEL_SETUP_OWNER, open: (remedies) => remedies.openModelSetup() },
    })
  }

  // A pipeline step relies on binary-artifact storage (the UI Tester uploads screenshots) but the
  // account has none configured. Prefer the localized body (it carries no runtime interpolation);
  // the raw backend prose is only the fallback when the locale lacks the key.
  function presentBinaryStorageUnconfigured(conflict: ParsedConflict): void {
    raise(conflict, {
      titleKey: 'errors.conflict.binaryStorageUnconfigured.title',
      description: te('errors.conflict.binaryStorageUnconfigured.body')
        ? t('errors.conflict.binaryStorageUnconfigured.body')
        : fallback(conflict),
      icon: 'i-lucide-image',
      actionKey: 'errors.conflict.binaryStorageUnconfigured.action',
      fix: {
        owner: (owners) => owners?.binaryStorage,
        open: (remedies) => remedies.openInfraArea('binaryStorage'),
      },
    })
  }

  // A pipeline includes a Deployer, but the SERVICE's ephemeral-environment config (the in-repo
  // "what/where") is incomplete for its declared type. Steer to THAT service's environment config.
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
    raise(conflict, {
      titleKey: 'errors.conflict.deployerServiceConfig.title',
      description: missing
        ? t('errors.conflict.deployerServiceConfig.body', { missing })
        : fallback(conflict),
      icon: 'i-lucide-server',
      actionKey: 'errors.conflict.deployerServiceConfig.action',
      fix: {
        // The missing fields are the service's own provisioning, a block edit any caller with
        // `board.write` saves in the service inspector. With no frame there is no inspector to
        // open, only the workspace's test-environment settings, which a board admin saves.
        owner: () => (frameId ? BOARD_MEMBER_SETUP_OWNER : 'workspace_admin'),
        // The compose wizard is the better screen for docker-compose, but its save registers a
        // workspace handler (`integrations.manage`), so only a caller who holds that gets it.
        open: (remedies, actor) =>
          remedies.openServiceEnvironment(
            frameId,
            provisionType,
            canActOnSetup('workspace_admin', actor),
          ),
      },
    })
  }

  // A pipeline includes a Deployer and the service config is sound, but no WORKSPACE handler
  // resolves for the service's provision type (missing or ambiguous). Also raised by the Tester
  // start gate, where the same fix applies.
  function presentProvisionTypeUnhandled(conflict: ParsedConflict): void {
    const type =
      typeof conflict.details.provisionType === 'string' ? conflict.details.provisionType : ''
    raise(conflict, {
      titleKey: 'errors.conflict.provisionTypeUnhandled.title',
      description: type
        ? t('errors.conflict.provisionTypeUnhandled.body', { type })
        : fallback(conflict),
      icon: 'i-lucide-server-cog',
      actionKey: 'errors.conflict.provisionTypeUnhandled.action',
      fix: ENVIRONMENTS_FIX,
    })
  }

  // A pipeline includes a Deployer, the config is structurally complete, but the live connection
  // probe of the resolved deployment integration failed (unreachable endpoint, bad token).
  function presentDeployerConnectionFailed(conflict: ParsedConflict): void {
    const detail = typeof conflict.details.detail === 'string' ? conflict.details.detail : ''
    raise(conflict, {
      titleKey: 'errors.conflict.deployerConnectionFailed.title',
      description: detail
        ? t('errors.conflict.deployerConnectionFailed.body', { detail })
        : fallback(conflict),
      icon: 'i-lucide-plug',
      actionKey: 'errors.conflict.deployerConnectionFailed.action',
      fix: ENVIRONMENTS_FIX,
    })
  }

  /**
   * Dispatch the bespoke conflict reasons (the ones excluded from `CONFLICT_INFO`). Returns `true`
   * when the reason was one of them (and the toast was raised), `false` to fall through to the
   * generic map. The reason values are mutually exclusive, so dispatch order is irrelevant.
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
