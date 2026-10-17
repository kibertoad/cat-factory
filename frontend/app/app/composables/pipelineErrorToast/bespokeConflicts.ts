import type { ParsedConflict } from '~/composables/usePipelineErrorToast'
import type { InfraSetupOwners } from '~/types/domain'
import {
  SETUP_REMEDY_KEYS,
  setupRemedyFor,
  type SetupActor,
  type SetupRemedy,
} from '~/utils/setupAudience'

type SetupRemedies = Pick<
  ReturnType<typeof useSetupRemedies>,
  'openInfraArea' | 'openModelSetup' | 'openServiceEnvironment'
>

/** Who is asking and who owns each gap, read when a toast is raised (never at store setup). */
export interface ConflictAudience {
  actor: SetupActor
  owners: InfraSetupOwners | null
}

/**
 * The owner of a fix any member can save, such as a block edit: no owner gate, so everyone on the
 * full surface gets the fix, and the designer surface gets the line that says to switch.
 */
const NO_OWNER_GATE = Symbol('no owner gate')

/** One bespoke conflict toast, before the audience decides whether it carries the fix. */
interface SetupConflictToast {
  titleKey: string
  description: string
  icon: string
  actionKey: string
  /**
   * Who closes the gap, as `canActOnSetup` reads it (`effectiveOwner` covers an unknown value), or
   * {@link NO_OWNER_GATE}.
   */
  owner: unknown
  fix: () => void
}

/**
 * The bespoke conflict toasts: the five 409 reasons whose copy interpolates runtime detail and
 * whose remedy is a one-click jump into the panel that fixes them. Split out of
 * {@link usePipelineErrorToast} for size; it closes over the SAME toast and i18n handles.
 *
 * Each one is a setup gap, so it follows the setup cards' audience rule (`utils/setupAudience.ts`):
 * only a caller who can act gets the fix button, opened through `useSetupRemedies`. Everyone else
 * gets the same toast with one more sentence naming who can fix it, because a button that opens a
 * screen their save is refused on is worse than no button.
 */
export function createBespokeConflictToasts(deps: {
  toast: ReturnType<typeof useToast>
  t: ReturnType<typeof useI18n>['t']
  te: ReturnType<typeof useI18n>['te']
  audience: () => ConflictAudience
  remedies: () => SetupRemedies
}): (conflict: ParsedConflict) => boolean {
  const { toast, t, te } = deps

  function raise(spec: SetupConflictToast): void {
    const { actor } = deps.audience()
    const remedy: SetupRemedy | null =
      spec.owner === NO_OWNER_GATE
        ? actor.fullSurface
          ? null
          : 'full_surface'
        : setupRemedyFor(spec.owner, actor)
    toast.add({
      title: t(spec.titleKey),
      description: remedy
        ? `${spec.description} ${t(SETUP_REMEDY_KEYS[remedy])}`
        : spec.description,
      color: 'error',
      icon: spec.icon,
      // Stay until dismissed: an actionable toast whose remedy button vanishes on the ~5s
      // auto-dismiss takes the one-click fix with it, and the line naming who can fix it is the
      // one thing a caller without the button has to read.
      duration: 0,
      actions: remedy
        ? []
        : [{ label: t(spec.actionKey), icon: 'i-lucide-settings', onClick: spec.fix }],
    })
  }

  /** The backend prose, else the generic line: what a toast says when its own body cannot render. */
  function fallback(conflict: ParsedConflict): string {
    return conflict.message ?? t('errors.conflict.fallbackMessage')
  }

  const owners = () => deps.audience().owners

  // The headline case: a pipeline step's model has no usable provider. Name the offending
  // model(s) and offer the AI setup, the same remedy the "No AI model configured" banner gives.
  function presentProvidersUnconfigured(conflict: ParsedConflict): void {
    const models = Array.isArray(conflict.details.models) ? conflict.details.models : []
    const list = models.join(', ')
    raise({
      titleKey: 'errors.conflict.providersUnconfigured.title',
      description: list
        ? t('errors.conflict.providersUnconfigured.body', { models: list })
        : fallback(conflict),
      icon: 'i-lucide-cpu',
      actionKey: 'errors.conflict.providersUnconfigured.action',
      // A model is a workspace setting, as the setup checklist's model row says.
      owner: 'workspace_admin',
      fix: () => deps.remedies().openModelSetup(),
    })
  }

  // A pipeline step relies on binary-artifact storage (the UI Tester uploads screenshots) but the
  // account has none configured. Prefer the localized body (it carries no runtime interpolation);
  // the raw backend prose is only the fallback when the locale lacks the key.
  function presentBinaryStorageUnconfigured(conflict: ParsedConflict): void {
    raise({
      titleKey: 'errors.conflict.binaryStorageUnconfigured.title',
      description: te('errors.conflict.binaryStorageUnconfigured.body')
        ? t('errors.conflict.binaryStorageUnconfigured.body')
        : fallback(conflict),
      icon: 'i-lucide-image',
      actionKey: 'errors.conflict.binaryStorageUnconfigured.action',
      owner: owners()?.binaryStorage,
      fix: () => deps.remedies().openInfraArea('binaryStorage'),
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
    raise({
      titleKey: 'errors.conflict.deployerServiceConfig.title',
      description: missing
        ? t('errors.conflict.deployerServiceConfig.body', { missing })
        : fallback(conflict),
      icon: 'i-lucide-server',
      actionKey: 'errors.conflict.deployerServiceConfig.action',
      // The owner follows where the fix opens. The compose wizard's save registers a workspace
      // handler (`integrations.manage`), so a board admin owns it. Any other type is fixed in the
      // service inspector, a block edit any member can save. With no frame, the fix is the
      // workspace's test-environment settings, owned like the rest of that area.
      owner: frameId
        ? provisionType === 'docker-compose'
          ? 'workspace_admin'
          : NO_OWNER_GATE
        : owners()?.ephemeralEnvironments,
      fix: () => deps.remedies().openServiceEnvironment(frameId, provisionType),
    })
  }

  // A pipeline includes a Deployer and the service config is sound, but no WORKSPACE handler
  // resolves for the service's provision type (missing or ambiguous). Also raised by the Tester
  // start gate, where the same fix applies.
  function presentProvisionTypeUnhandled(conflict: ParsedConflict): void {
    const type =
      typeof conflict.details.provisionType === 'string' ? conflict.details.provisionType : ''
    raise({
      titleKey: 'errors.conflict.provisionTypeUnhandled.title',
      description: type
        ? t('errors.conflict.provisionTypeUnhandled.body', { type })
        : fallback(conflict),
      icon: 'i-lucide-server-cog',
      actionKey: 'errors.conflict.provisionTypeUnhandled.action',
      owner: owners()?.ephemeralEnvironments,
      fix: () => deps.remedies().openInfraArea('ephemeralEnvironments'),
    })
  }

  // A pipeline includes a Deployer, the config is structurally complete, but the live connection
  // probe of the resolved deployment integration failed (unreachable endpoint, bad token).
  function presentDeployerConnectionFailed(conflict: ParsedConflict): void {
    const detail = typeof conflict.details.detail === 'string' ? conflict.details.detail : ''
    raise({
      titleKey: 'errors.conflict.deployerConnectionFailed.title',
      description: detail
        ? t('errors.conflict.deployerConnectionFailed.body', { detail })
        : fallback(conflict),
      icon: 'i-lucide-plug',
      actionKey: 'errors.conflict.deployerConnectionFailed.action',
      owner: owners()?.ephemeralEnvironments,
      fix: () => deps.remedies().openInfraArea('ephemeralEnvironments'),
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
