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
 *
 * G2 closes the same gap for everything that is NOT a 409: this composable is the funnel every
 * other failure drains into, and it used to show the backend's prose verbatim as the description —
 * so a non-English user read English, and an internal 500's fixed `Internal server error` was the
 * whole of what they were told. Those now resolve translated copy from the envelope's STATUS CLASS
 * (`error.code`, the `ApiErrorCode` union) and keep the untranslated detail — the prose, a
 * validation 400's `issues`, and the `requestId` an operator can grep — one click away behind
 * "Show details". Two rules follow from that split: the description says what a user can act on,
 * the disclosure carries what a user quotes to someone else; and a raw string is never the FIRST
 * thing shown, however good it is (many of them are — the elaborate remedies this initiative
 * added — which is exactly why the detail stays reachable rather than being dropped).
 */

import { createBespokeConflictToasts } from '~/composables/pipelineErrorToast/bespokeConflicts'
import type { ApiErrorCode, ConflictReason, UnavailableReason } from '@cat-factory/contracts'
import { apiErrorEnvelope, apiErrorReason, apiErrorStatus } from './api/errors'

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
  dry_run_not_mergeable: {
    titleKey: 'errors.conflict.title.dry_run_not_mergeable',
    descriptionKey: 'errors.conflict.description.dry_run_not_mergeable',
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
  env_test_connection_failed: {
    titleKey: 'errors.conflict.title.env_test_connection_failed',
    descriptionKey: 'errors.conflict.description.env_test_connection_failed',
    action: {
      labelKey: 'errors.conflict.action.configureInfrastructure',
      icon: 'i-lucide-settings',
      run: (ui) => ui.openProviderConnection('environment'),
    },
  },
  // Opt-in review-debt friction. In the normal task-create flow AddTaskModal intercepts these
  // 409s and opens the friction dialog (which can retry with an acknowledgement), so these entries
  // are the last-resort toast fallback for any OTHER caller — a generic, param-free title +
  // description reusing the dialog's own `errors.reviewFriction.*` namespace.
  review_debt_warn: {
    titleKey: 'errors.reviewFriction.warnTitle',
    descriptionKey: 'errors.reviewFriction.warnToast',
  },
  review_debt_blocked: {
    titleKey: 'errors.reviewFriction.blockedTitle',
    descriptionKey: 'errors.reviewFriction.blockedToast',
  },
  // Reachable from this generic lookup only if a prompt save is ever driven from a run-start
  // path; the prompt editor words it itself (it also has to re-seed its textarea from what
  // landed). Mapped regardless — the exhaustive Record is the drift guard, not a hint that
  // every reason arrives here.
  prompt_revision_conflict: {
    titleKey: 'errors.conflict.title.prompt_revision_conflict',
    descriptionKey: 'errors.conflict.description.prompt_revision_conflict',
  },
  // The three ways a recurring SCHEDULE blocks a pipeline edit (delete / make one-off / enable
  // bug-intake). No jump action: a schedule is reached through its own frame's inspector, not from
  // a workspace-level route, so there is no single target to deep-link to — the description names
  // the remedy instead. What each one must convey is that the fix is on the SCHEDULE and not on the
  // pipeline the user is looking at, which is the part the refusal alone doesn't make obvious.
  pipeline_schedule_attached: {
    titleKey: 'errors.conflict.title.pipeline_schedule_attached',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_attached',
  },
  pipeline_schedule_requires_recurring: {
    titleKey: 'errors.conflict.title.pipeline_schedule_requires_recurring',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_requires_recurring',
  },
  foundational_service_exists: {
    titleKey: 'errors.conflict.title.foundational_service_exists',
    descriptionKey: 'errors.conflict.description.foundational_service_exists',
  },
  binary_output_service_invalid: {
    titleKey: 'errors.conflict.title.binary_output_service_invalid',
    descriptionKey: 'errors.conflict.description.binary_output_service_invalid',
  },
  binary_output_generator_invalid: {
    titleKey: 'errors.conflict.title.binary_output_generator_invalid',
    descriptionKey: 'errors.conflict.description.binary_output_generator_invalid',
  },
  foundational_service_not_inherited: {
    titleKey: 'errors.conflict.title.foundational_service_not_inherited',
    descriptionKey: 'errors.conflict.description.foundational_service_not_inherited',
  },
  pipeline_schedule_intake_unconfigured: {
    titleKey: 'errors.conflict.title.pipeline_schedule_intake_unconfigured',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_intake_unconfigured',
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

/** The non-null parsed shape of a backend conflict, as returned by {@link parseConflict}. */
export type ParsedConflict = NonNullable<ReturnType<typeof parseConflict>>

/**
 * Generic translated description per STATUS CLASS, for a failure no `reason` code narrows.
 *
 * Exhaustive over the wire union (minus `conflict`, which structurally cannot arrive here —
 * {@link parseConflict} intercepts every envelope carrying that code, so a mapping for it would be
 * dead copy in ten locales), which makes the `Record` the drift guard: a new `ApiErrorCode` fails
 * this typecheck until it has wording. The copy is deliberately about the STATUS CLASS and nothing
 * else — it is what we can say truthfully without having read the specific failure, so it names
 * the shape of the remedy ("sign in again", "your deployment hasn't wired this", "wait and retry")
 * and leaves the specifics to the detail disclosure.
 */
const GENERIC_DESCRIPTION_KEYS: Record<Exclude<ApiErrorCode, 'conflict'>, string> = {
  not_found: 'errors.generic.description.not_found',
  validation: 'errors.generic.description.validation',
  credential_required: 'errors.generic.description.credential_required',
  forbidden: 'errors.generic.description.forbidden',
  unavailable: 'errors.generic.description.unavailable',
  unauthorized: 'errors.generic.description.unauthorized',
  rate_limited: 'errors.generic.description.rate_limited',
  internal: 'errors.generic.description.internal',
}

/**
 * Translated description per REASON, for the non-conflict failures whose status class alone would
 * describe them wrongly. Checked before {@link GENERIC_DESCRIPTION_KEYS} and falling through to
 * it for every reason not listed, so this stays a short list of exceptions rather than a second
 * vocabulary to keep in sync.
 *
 * It exists because the generic 503 copy has to commit to something, and what it commits to is
 * "this deployment has not configured the capability this action needs". That is right for the
 * common 503 (a module nobody wired) and exactly wrong for an outage: it tells an operator their
 * build is missing a registration when the truth is that a set could not be read right now. On a
 * mothership-mode node that is the misattribution this whole seam exists to remove, reappearing
 * one layer up — with the honest wording demoted to untranslated detail behind a disclosure. So
 * the reasons in {@link UNAVAILABLE_REASONS} carry their own copy, and the exhaustive `Record`
 * over that union is the drift guard: a new user-reachable 503 reason fails this typecheck until
 * it has wording.
 */
const UNAVAILABLE_DESCRIPTION_KEYS: Record<UnavailableReason, string> = {
  binary_generators_unreachable: 'errors.unavailable.description.binary_generators_unreachable',
  foundational_builtins_unreachable:
    'errors.unavailable.description.foundational_builtins_unreachable',
}

/**
 * The request never reached a server that answered in our envelope shape — offline, DNS, a dropped
 * connection, CORS. Distinct from {@link UNEXPECTED_DESCRIPTION_KEY} on purpose: this one's remedy
 * is on the USER's side (check the connection), which is the opposite of "the server is broken".
 */
const NETWORK_DESCRIPTION_KEY = 'errors.generic.description.network'

/**
 * Something answered with an HTTP status but not one of our envelopes (an edge/proxy 502 page, a
 * gateway timeout), or answered with a `code` this build doesn't know. Reported as an unexpected
 * SERVER-side failure rather than folded into the network case.
 */
const UNEXPECTED_DESCRIPTION_KEY = 'errors.generic.description.unexpected'

/**
 * A non-conflict failure, split into the part that gets TRANSLATED and the parts that stay raw.
 * Pure (no i18n, no store) so the classification is unit-testable on its own; the composable
 * turns it into a toast.
 */
export interface GenericFailure {
  /** i18n key for the translated description shown up front. */
  descriptionKey: string
  /** The backend's untranslated prose, when it sent any (absent for a bare network fault). */
  message: string | null
  /** `path: message` entries from a request-validation 400, in wire order. */
  issues: string[]
  /** The envelope's correlation id, so the user can quote it at whoever reads the logs. */
  requestId: string | null
}

/**
 * Classify a NON-conflict failure for presentation. Never throws and never returns an empty
 * `descriptionKey`: an error this function cannot recognise at all still gets the network or
 * unexpected-failure wording, because a toast with no description reads as a successful action.
 */
export function describeGenericFailure(error: unknown): GenericFailure {
  const envelope = apiErrorEnvelope(error)
  // Read through a widened alias rather than casting the wire string to the union: a `code` we
  // don't know must resolve to `undefined`, which is exactly what the alias's index signature
  // says and what a cast would have hidden. The narrow Record above stays the drift guard.
  const byCode: Readonly<Record<string, string | undefined>> = GENERIC_DESCRIPTION_KEYS
  // A REASON that has its own copy wins over the status class's, through the same widened-alias
  // read and for the same reason: a `reason` this build doesn't know must resolve to `undefined`
  // and fall through, never narrow the wire string to the union by casting.
  const byReason: Readonly<Record<string, string | undefined>> = UNAVAILABLE_DESCRIPTION_KEYS
  const reason = apiErrorReason(error)
  const mapped =
    (reason ? byReason[reason] : undefined) ?? (envelope?.code ? byCode[envelope.code] : undefined)
  // No envelope at all AND no status ⇒ nothing answered; with a status, something did.
  const unrecognised =
    !envelope && apiErrorStatus(error) === undefined
      ? NETWORK_DESCRIPTION_KEY
      : UNEXPECTED_DESCRIPTION_KEY
  return {
    descriptionKey: mapped ?? unrecognised,
    // `ApiError.message` is the envelope's prose, or a synthesised `Request failed (HTTP n)`; for
    // a non-API throw it is the JS error text. Either way it is detail, never the headline.
    message: error instanceof Error ? error.message : error == null ? null : String(error),
    issues: (envelope?.issues ?? []).map((issue) =>
      issue.path ? `${issue.path}: ${issue.message}` : issue.message,
    ),
    requestId: typeof envelope?.requestId === 'string' ? envelope.requestId : null,
  }
}

export function usePipelineErrorToast() {
  const toast = useToast()
  const ui = useUiStore()
  // Resolved through the Nuxt app's global i18n instance rather than `useI18n()`, which
  // requires an active component instance — the same pattern (and the same reason) as the
  // board / recurring-pipelines stores.
  //
  // This composable is called from STORE SETUP (`stores/execution.ts`, `stores/agentRuns.ts`),
  // and a Pinia setup store runs its body on the FIRST `useStore()` anywhere. That used to be
  // a component, so `useI18n()` happened to be legal; the moment anything instantiated one of
  // those stores earlier — `createNavGates()` does, from the `enforce: 'post'` modular plugin —
  // vue-i18n threw `MUST_BE_CALL_SETUP_TOP`, the plugin threw, and Nuxt's error boundary
  // replaced the entire app with its 500 page. Every single e2e spec failed on a blank board.
  // A store must be instantiable outside a component, so the i18n handle it reaches for has
  // to be too.
  //
  // Typed as `useI18n`'s own return (`$i18n` IS that global Composer in composition mode), so
  // `t`/`te` keep their real signatures. No typed-message-key coverage is lost by the switch:
  // tier 1 only sees literal keys written in a `<script setup>`, never in a `.ts` composable —
  // the drift guard here is the exhaustive `CONFLICT_INFO` / `ApiErrorCode` records above.
  const { t, te } = useNuxtApp().$i18n as ReturnType<typeof useI18n>

  // The five bespoke conflict reasons (a runtime-interpolated body + a "configure X" jump each)
  // live in a sibling factory over the same toast/ui/i18n handles, so this composable stays
  // within the per-function line budget.
  const presentBespokeConflict = createBespokeConflictToasts({ toast, ui, t, te })

  /**
   * Per-reason copy from the exhaustive map: a translated title + description, and a jump
   * action for the reasons a UI panel can fix. `te` (translation-exists) guards every lookup,
   * so a key missing from the active locale falls back rather than leaking a raw key: the
   * title falls to the caller's key, the description to the raw backend `message`. An unknown
   * reason (not in the map) gets the same generic title + raw-message fallback.
   */
  function presentMappedConflict(conflict: ParsedConflict, fallbackTitleKey: string): void {
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
  }

  /**
   * Everything that is NOT a 409: a translated status-class description, with the raw detail
   * behind a "Show details" button that swaps it into the same toast (G2).
   *
   * The reveal is an UPDATE rather than a second toast so the two readings can't sit on screen
   * disagreeing, and it makes the toast sticky at the same time — the detail is what someone
   * copies into a bug report, and a ~5s auto-dismiss takes it away mid-copy. `actions: []` has to
   * be passed explicitly: `update` merges over the existing toast, so an omitted `actions` would
   * leave a "Show details" button that is now a no-op.
   *
   * No detail worth showing (a network fault with an unhelpful `message` and no correlation id)
   * ⇒ no button at all, rather than a disclosure that reveals nothing.
   */
  function presentGenericFailure(error: unknown, fallbackTitleKey: string): void {
    const failure = describeGenericFailure(error)
    const detail = [
      failure.message,
      failure.issues.join(', '),
      failure.requestId ? t('errors.generic.requestId', { id: failure.requestId }) : '',
    ]
      .filter((part) => part && part.trim().length > 0)
      .join(' · ')
    // No `te` guard: the key comes from a Record exhaustive over the wire union and every entry
    // ships in the base `en` catalog, so a locale missing it renders English via `fallbackLocale`
    // (better than the raw prose this replaced) and a bare key can never leak.
    const added = toast.add({
      title: t(fallbackTitleKey),
      description: t(failure.descriptionKey),
      color: 'error',
      icon: 'i-lucide-triangle-alert',
      ...(detail
        ? {
            actions: [
              {
                label: t('errors.generic.showDetail'),
                icon: 'i-lucide-info',
                onClick: () =>
                  toast.update(added.id, { description: detail, duration: 0, actions: [] }),
              },
            ],
          }
        : {}),
    })
  }

  /**
   * Present `error` as a toast. `fallbackTitleKey` is an i18n message key used for
   * non-conflict failures and any conflict reason without a dedicated title.
   */
  function present(error: unknown, fallbackTitleKey = 'common.actionFailed'): void {
    const conflict = parseConflict(error)
    if (conflict) {
      if (presentBespokeConflict(conflict)) return
      presentMappedConflict(conflict, fallbackTitleKey)
      return
    }
    presentGenericFailure(error, fallbackTitleKey)
  }

  return { present }
}
