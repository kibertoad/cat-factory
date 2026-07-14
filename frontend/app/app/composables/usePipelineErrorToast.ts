/**
 * Turn a failed run-control API call (start / restart / retry / merge) into an actionable
 * toast. The backend tags every 409 conflict with a distinct, machine-readable
 * `error.details.reason` (kernel `ConflictReason`), so we can word each case precisely
 * instead of dumping the raw message — and, for `providers_unconfigured`, surface the
 * SAME guidance + "Configure AI" jump as the no-AI-provider startup banner.
 *
 * i18n boundary (see CLAUDE.md / the i18n plan): user-facing title AND description are both
 * resolved from `errors.conflict.*` message keys by the machine-readable `reason` (G1). The raw
 * backend `message` is shown only as the last-resort description fallback (an unmapped reason, or a
 * locale missing the key) and stays untranslated — the contract is "if a server message must be
 * localizable, the backend emits a code and the frontend maps it", not "translate arbitrary server
 * prose on the client".
 */

import type { ConflictReason } from '@cat-factory/contracts'
import { apiErrorEnvelope } from './api/errors'

/** The parsed shape of a backend conflict (`{ error: { code: 'conflict', details } }`). */
interface ConflictDetails {
  reason?: string
  models?: string[]
  [key: string]: unknown
}

/** An optional one-click "jump to the panel that fixes it" affordance on a conflict toast. */
interface ConflictAction {
  /** i18n message key for the button label (a static literal so tier-1 typed keys see it). */
  labelKey: string
  icon: string
  /** Where the button navigates — a `ui` store deep-link; run with the store passed in. */
  run: (ui: ReturnType<typeof useUiStore>) => void
}

/** Per-reason toast copy: a translated title + description, and optionally a jump action. */
interface ConflictInfo {
  titleKey: string
  descriptionKey: string
  action?: ConflictAction
}

/**
 * Per-reason toast copy, keyed off the kernel/contracts `ConflictReason`. Being an EXHAUSTIVE
 * `Record` over the union is the real drift guard: a new backend conflict reason fails THIS
 * typecheck until it is mapped here (title + description). (The typed-message-keys feature can't
 * see the `t()` lookup because the key is resolved at runtime via this map, not written as a
 * literal — so the exhaustiveness of the map, not `t()`, is what makes a missing reason a build
 * error.) The reasons with BESPOKE handling above (a runtime-interpolated body + a "configure X"
 * action + their own key namespace) are excluded, since none reaches this generic lookup:
 * `providers_unconfigured`, `binary_storage_unconfigured`, and the deployment-environment trio
 * `provision_type_unhandled` / `deployer_service_provisioning_incomplete` /
 * `deployer_connection_test_failed`.
 *
 * G1 (error-message coverage): before this, only a title was mapped and the description fell back
 * to the raw, untranslated backend `message`. Every reason now carries a translated `description`
 * (remedy prose), and the ones a UI panel can fix carry a `run` deep-link — the same shape as the
 * bespoke conflicts above, but data-driven instead of one `if` per reason.
 */
type BespokeConflictReason =
  | 'providers_unconfigured'
  | 'binary_storage_unconfigured'
  | 'provision_type_unhandled'
  | 'deployer_service_provisioning_incomplete'
  | 'deployer_connection_test_failed'

const CONFLICT_INFO: Record<Exclude<ConflictReason, BespokeConflictReason>, ConflictInfo> = {
  dependencies_unmet: {
    titleKey: 'errors.conflict.title.dependencies_unmet',
    descriptionKey: 'errors.conflict.description.dependencies_unmet',
  },
  task_limit_reached: {
    titleKey: 'errors.conflict.title.task_limit_reached',
    descriptionKey: 'errors.conflict.description.task_limit_reached',
  },
  tester_infra_unsupported: {
    titleKey: 'errors.conflict.title.tester_infra_unsupported',
    descriptionKey: 'errors.conflict.description.tester_infra_unsupported',
  },
  agent_backend_unconfigured: {
    titleKey: 'errors.conflict.title.agent_backend_unconfigured',
    descriptionKey: 'errors.conflict.description.agent_backend_unconfigured',
    action: {
      labelKey: 'errors.conflict.action.configureRunnerPool',
      icon: 'i-lucide-server',
      run: (ui) => ui.openInfrastructure('runner-pool'),
    },
  },
  run_not_retryable: {
    titleKey: 'errors.conflict.title.run_not_retryable',
    descriptionKey: 'errors.conflict.description.run_not_retryable',
  },
  no_pr_to_merge: {
    titleKey: 'errors.conflict.title.no_pr_to_merge',
    descriptionKey: 'errors.conflict.description.no_pr_to_merge',
  },
  github_not_connected: {
    titleKey: 'errors.conflict.title.github_not_connected',
    descriptionKey: 'errors.conflict.description.github_not_connected',
    action: {
      labelKey: 'errors.conflict.action.connectGitHub',
      icon: 'i-lucide-github',
      run: (ui) => ui.openGitHub(),
    },
  },
  bootstrap_not_retryable: {
    titleKey: 'errors.conflict.title.bootstrap_not_retryable',
    descriptionKey: 'errors.conflict.description.bootstrap_not_retryable',
  },
  bootstrap_reference_missing: {
    titleKey: 'errors.conflict.title.bootstrap_reference_missing',
    descriptionKey: 'errors.conflict.description.bootstrap_reference_missing',
  },
  preset_unsatisfiable: {
    titleKey: 'errors.conflict.title.preset_unsatisfiable',
    descriptionKey: 'errors.conflict.description.preset_unsatisfiable',
    action: {
      labelKey: 'errors.conflict.action.chooseModel',
      icon: 'i-lucide-cpu',
      run: (ui) => ui.openModelConfig(),
    },
  },
  visual_pipeline_no_frontend: {
    titleKey: 'errors.conflict.title.visual_pipeline_no_frontend',
    descriptionKey: 'errors.conflict.description.visual_pipeline_no_frontend',
  },
  model_policy_blocked: {
    titleKey: 'errors.conflict.title.model_policy_blocked',
    descriptionKey: 'errors.conflict.description.model_policy_blocked',
    action: {
      labelKey: 'errors.conflict.action.chooseModel',
      icon: 'i-lucide-cpu',
      run: (ui) => ui.openModelConfig(),
    },
  },
  model_policy_unsupported: {
    titleKey: 'errors.conflict.title.model_policy_unsupported',
    descriptionKey: 'errors.conflict.description.model_policy_unsupported',
  },
  deployer_required_before_tester: {
    titleKey: 'errors.conflict.title.deployer_required_before_tester',
    descriptionKey: 'errors.conflict.description.deployer_required_before_tester',
  },
  env_test_not_a_frame: {
    titleKey: 'errors.conflict.title.env_test_not_a_frame',
    descriptionKey: 'errors.conflict.description.env_test_not_a_frame',
  },
  env_test_infraless: {
    titleKey: 'errors.conflict.title.env_test_infraless',
    descriptionKey: 'errors.conflict.description.env_test_infraless',
  },
  env_test_not_provisionable: {
    titleKey: 'errors.conflict.title.env_test_not_provisionable',
    descriptionKey: 'errors.conflict.description.env_test_not_provisionable',
    action: {
      labelKey: 'errors.conflict.action.configureInfrastructure',
      icon: 'i-lucide-settings',
      run: (ui) => ui.openProviderConnection('environment'),
    },
  },
  env_test_no_vcs: {
    titleKey: 'errors.conflict.title.env_test_no_vcs',
    descriptionKey: 'errors.conflict.description.env_test_no_vcs',
    action: {
      labelKey: 'errors.conflict.action.connectGitHub',
      icon: 'i-lucide-github',
      run: (ui) => ui.openGitHub(),
    },
  },
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
      return
    }

    // A pipeline step relies on binary-artifact storage (the UI Tester uploads screenshots)
    // but the account has none configured. Explain it and offer the jump to the content-storage
    // settings — the same shape as the providers-unconfigured case above. Prefer the localized
    // body (it carries no runtime interpolation) so non-English users see translated copy; the
    // raw backend prose is only the last-resort fallback when the locale lacks the key.
    if (conflict?.reason === 'binary_storage_unconfigured') {
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
      return
    }

    // A pipeline includes a Deployer, but the SERVICE's ephemeral-environment config (the in-repo
    // "what/where") is incomplete for its declared type. Steer the user straight to THAT service's
    // environment config — the compose wizard for docker-compose, the service inspector otherwise —
    // falling back to the workspace infrastructure window if the frame id wasn't carried.
    if (conflict?.reason === 'deployer_service_provisioning_incomplete') {
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
      return
    }

    // A pipeline includes a Deployer and the service config is sound, but no WORKSPACE handler
    // resolves for the service's provision type (missing or ambiguous). Steer to the Infrastructure
    // window's Test-environments tab. (Also raised by the Tester start gate — same fix applies.)
    if (conflict?.reason === 'provision_type_unhandled') {
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
      return
    }

    // A pipeline includes a Deployer, the config is structurally complete, but the live connection
    // probe of the resolved deployment integration failed (unreachable endpoint / apiserver, bad
    // token). Surface the provider's failure detail and steer to the handler to fix + re-test it.
    if (conflict?.reason === 'deployer_connection_test_failed') {
      const detail =
        typeof conflict.details.detail === 'string' ? conflict.details.detail : undefined
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
      return
    }

    if (conflict) {
      // Per-reason copy from the exhaustive map: a translated title + description, and a jump
      // action for the reasons a UI panel can fix. `te` (translation-exists) guards every lookup,
      // so a key missing from the active locale falls back rather than leaking a raw key: the
      // title falls to the caller's key, the description to the raw backend `message`. An unknown
      // reason (not in the map) gets the same generic title + raw-message fallback.
      const info = conflict.reason
        ? CONFLICT_INFO[conflict.reason as Exclude<ConflictReason, BespokeConflictReason>]
        : undefined
      if (info) {
        toast.add({
          title: te(info.titleKey) ? t(info.titleKey) : t(fallbackTitleKey),
          description: te(info.descriptionKey)
            ? t(info.descriptionKey)
            : (conflict.message ?? t('errors.conflict.fallbackMessage')),
          color: 'warning',
          icon: 'i-lucide-triangle-alert',
          // A reason with a jump action becomes an actionable, sticky toast (like the bespoke
          // conflicts above) so the one-click remedy doesn't auto-dismiss before it's reached.
          ...(info.action
            ? {
                duration: 0,
                actions: [
                  {
                    label: t(info.action.labelKey),
                    icon: info.action.icon,
                    onClick: () => info.action?.run(ui),
                  },
                ],
              }
            : {}),
        })
        return
      }
      toast.add({
        title: t(fallbackTitleKey),
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
