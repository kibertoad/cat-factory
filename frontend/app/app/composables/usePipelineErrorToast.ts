/**
 * Turn a failed run-control API call (start / restart / retry / merge) into an actionable
 * toast. The backend tags every 409 conflict with a distinct, machine-readable
 * `error.details.reason` (kernel `ConflictReason`), so we can word each case precisely
 * instead of dumping the raw message — and, for `providers_unconfigured`, surface the
 * SAME guidance + "Configure AI" jump as the no-AI-provider startup banner.
 *
 * i18n boundary (see AGENTS.md / the i18n plan): user-facing title AND description are both
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
import {
  gateSetupFix,
  type SetupConflictDeps,
} from '~/composables/pipelineErrorToast/setupConflictGate'
// Imported by path rather than left to Nuxt's auto-import: this module is also loaded directly by
// unit tests (and from store setup), where the auto-import globals are not installed.
import { useCopyToClipboard } from '~/composables/useCopyToClipboard'
import type {
  ApiErrorCode,
  BootstrapReferenceReason,
  UnavailableReason,
} from '@cat-factory/contracts'
import { apiErrorEnvelope, apiErrorReason, apiErrorStatus } from './api/errors'
import { conflictInfo } from '~/utils/conflictCopy'
import { SETUP_REMEDY_KEYS } from '~/utils/setupAudience'
import type { SetupRemedies } from '~/utils/setupFixes'

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
): { reason?: string; message?: string; requestId?: string; details: ConflictDetails } | null {
  const body = apiErrorEnvelope(error)
  if (body?.code !== 'conflict') return null
  const details = (body.details as ConflictDetails | undefined) ?? {}
  return {
    reason: typeof details.reason === 'string' ? details.reason : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
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
 *
 * `BootstrapReferenceReason` joins it because the same argument reaches one 422: a bootstrap
 * refused for its reference architecture is not "the request was malformed", it names a specific
 * entry a specific person can go and fix. The launch dialog handles that one itself, since it can
 * open the entry. This is what every OTHER caller of the funnel is told instead of the status
 * class's generic wording, above all a retry driven from the run card.
 */
const REASON_DESCRIPTION_KEYS: Record<UnavailableReason | BootstrapReferenceReason, string> = {
  reference_repo_not_found: 'errors.reason.description.reference_repo_not_found',
  reference_repo_unreadable: 'errors.reason.description.reference_repo_unreadable',
  binary_generators_unreachable: 'errors.unavailable.description.binary_generators_unreachable',
  foundational_builtins_unreachable:
    'errors.unavailable.description.foundational_builtins_unreachable',
  connection_credentials_unreadable:
    'errors.unavailable.description.connection_credentials_unreadable',
  vcs_capability_unsupported: 'errors.unavailable.description.vcs_capability_unsupported',
  service_catalog_unreachable: 'errors.unavailable.description.service_catalog_unreachable',
  service_catalog_unauthorized: 'errors.unavailable.description.service_catalog_unauthorized',
  service_catalog_filter_missing: 'errors.unavailable.description.service_catalog_filter_missing',
  service_catalog_response_too_large:
    'errors.unavailable.description.service_catalog_response_too_large',
  assistant_generation_failed: 'errors.unavailable.description.assistant_generation_failed',
  assistant_reply_unreadable: 'errors.unavailable.description.assistant_reply_unreadable',
  delegated_executor_failed: 'errors.unavailable.description.delegated_executor_failed',
  delegated_work_branch_unprepared:
    'errors.unavailable.description.delegated_work_branch_unprepared',
  attached_pr_provider_unreachable:
    'errors.unavailable.description.attached_pr_provider_unreachable',
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
  /** The backend's machine-readable `details.reason`, for a surface that words a reason itself. */
  reason: string | null
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
  const byReason: Readonly<Record<string, string | undefined>> = REASON_DESCRIPTION_KEYS
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
    reason,
  }
}

/**
 * The raw detail of a failure as one line: the prose, the validation issues and the request id,
 * empty parts dropped. The toast's "Show details" and the inline `FailureMessage` both show this,
 * so an empty result means there is nothing to disclose and no button is shown.
 */
export function failureDetail(
  failure: GenericFailure,
  t: (key: string, params: Record<string, unknown>) => string,
): string {
  return [
    failure.message,
    failure.issues.join(', '),
    failure.requestId ? t('errors.generic.requestId', { id: failure.requestId }) : '',
  ]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(' · ')
}

/**
 * What "Copy details" puts on the clipboard for a failure: its lines (title, description, raw
 * detail), empty ones dropped. Shared by the failure toast and the inline `FailureMessage`, so a
 * failure copies the same text wherever it surfaced.
 */
export function failureReport(...lines: string[]): string {
  return lines.filter((line) => line.length > 0).join('\n')
}

export function usePipelineErrorToast() {
  const toast = useToast()
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
  // the drift guard here is the exhaustive `CONFLICT_INFO` (`utils/conflictCopy.ts`) and `ApiErrorCode` records.
  const { t, te } = useNuxtApp().$i18n as ReturnType<typeof useI18n>
  // The shared clipboard seam (feedback toast included), so "Copy details" behaves like every other
  // copy affordance in the product instead of silently failing where the API is unavailable.
  const { copyAction } = useCopyToClipboard()

  // Who is asking, and where a fix opens, are read when a toast is raised rather than here: this
  // runs in store setup, before the stores they read may exist. The remedies are built once, on
  // the first click that needs them.
  let setupRemedies: SetupRemedies | undefined
  const setup: SetupConflictDeps = {
    audience: () => ({
      actor: useSetupActor().actor.value,
      owners: useWorkspaceStore().infraSetupOwners,
    }),
    remedies: () => (setupRemedies ??= useSetupRemedies()),
  }

  /** What "Copy details" puts on the clipboard for a conflict: the toast, the prose, the id. */
  function conflictReport(conflict: ParsedConflict, title: string, description: string): string {
    return [
      title,
      description,
      conflict.message && !description.includes(conflict.message) ? conflict.message : '',
      conflict.requestId ? t('errors.generic.requestId', { id: conflict.requestId }) : '',
    ]
      .filter((part) => part.length > 0)
      .join('\n')
  }

  // The five bespoke conflict reasons (a runtime-interpolated body + a "configure X" jump each)
  // live in a sibling factory over the same toast/i18n handles, so this composable stays within
  // the per-function line budget.
  const presentBespokeConflict = createBespokeConflictToasts({
    ...setup,
    toast,
    t,
    te,
    copyAction,
    report: conflictReport,
  })

  /**
   * Per-reason copy from the exhaustive map: a translated title + description, and a jump
   * action for the reasons a UI panel can fix. `te` (translation-exists) guards every lookup,
   * so a key missing from the active locale falls back rather than leaking a raw key: the
   * title falls to the caller's key, the description to the generic conflict line.
   *
   * A conflict is a FAILURE, so it carries the two properties `presentGenericFailure` documents
   * below and for the same reasons: it does not auto-dismiss, and its detail is copyable. The
   * backend's own prose is DETAIL here rather than the headline, which matters most on the
   * unknown-reason path: that is where a reason this SPA build has never heard of lands, so
   * leaving it as the description meant the newest failures were the ones shown untranslated,
   * uncopyable, and gone in five seconds.
   */
  function presentMappedConflict(
    conflict: ParsedConflict,
    fallbackTitleKey: string,
    titleParams: Record<string, unknown> | undefined,
    id: string | undefined,
  ): void {
    const info = conflictInfo(conflict.reason)
    const title =
      info && te(info.titleKey) ? t(info.titleKey) : t(fallbackTitleKey, titleParams ?? {})
    const translated =
      info && te(info.descriptionKey)
        ? t(info.descriptionKey)
        : t('errors.conflict.fallbackMessage')
    const fix = info?.action ? gateSetupFix(info.action.fix, setup.audience(), setup) : undefined
    // A caller who cannot act gets no button and one more sentence naming who can.
    const description = fix?.remedy
      ? `${translated} ${t(SETUP_REMEDY_KEYS[fix.remedy])}`
      : translated
    // The backend's prose, kept only when it adds something the translated line doesn't already say.
    const detail = conflict.message && conflict.message !== translated ? conflict.message : ''
    const report = conflictReport(conflict, title, description)
    const added = toast.add({
      id,
      title,
      description,
      color: 'warning',
      icon: 'i-lucide-triangle-alert',
      duration: 0,
      ui: { description: 'select-text' },
      actions: [
        // A reason with a jump action leads with its one-click remedy; the detail reveal and the
        // copy follow it, so the primary affordance stays first in the row.
        ...(info?.action && fix && !fix.remedy
          ? [{ label: t(info.action.labelKey), icon: info.action.icon, onClick: fix.run }]
          : []),
        ...(detail
          ? [
              {
                label: t('errors.generic.showDetail'),
                icon: 'i-lucide-info',
                onClick: () =>
                  toast.update(added.id, { description: detail, actions: [copyAction(report)] }),
              },
            ]
          : []),
        copyAction(report),
      ],
    })
  }

  /**
   * Everything that is NOT a 409: a translated status-class description, with the raw detail
   * behind a "Show details" button that swaps it into the same toast (G2).
   *
   * The reveal is an UPDATE rather than a second toast so the two readings can't sit on screen
   * disagreeing. `actions: []` is passed explicitly on the reveal: `update` merges over the
   * existing toast, so an omitted `actions` would leave a "Show details" button that is now a
   * no-op. The COPY action is re-passed, because it is still the point after the reveal.
   *
   * Two properties of this toast are the whole reason a failure goes through this funnel rather
   * than a hand-built `toast.add`, and both were learned from someone trying to report a bug:
   *
   * - It does NOT auto-dismiss. A failure is the one toast a user needs to finish reading, quote,
   *   or act on, and a ~5s dismissal took the detail away mid-sentence. It carries a close button
   *   like every other toast, so staying is a decision the reader makes.
   * - The detail is COPYABLE with one click, through the shared clipboard seam (so the copy's own
   *   success/failure is reported rather than silently no-op'ing in an insecure context). Selecting
   *   text inside a toast is fiddly at the best of times and impossible once it has gone, and what
   *   the person needs to paste is the whole of it: the failed action, the class of failure, the
   *   backend's prose, and above all the `requestId` that joins it to the one server log line
   *   explaining it. Retyping that id off a screenshot is how a report arrives without it.
   *
   * No detail worth showing (a network fault with an unhelpful `message` and no correlation id)
   * ⇒ no disclosure and nothing to copy beyond the two translated lines, which the copy action
   * still carries.
   */
  function presentGenericFailure(
    error: unknown,
    fallbackTitleKey: string,
    titleParams: Record<string, unknown> | undefined,
    id: string | undefined,
  ): void {
    const failure = describeGenericFailure(error)
    const detail = failureDetail(failure, t)
    // No `te` guard: the key comes from a Record exhaustive over the wire union and every entry
    // ships in the base `en` catalog, so a locale missing it renders English via `fallbackLocale`
    // (better than the raw prose this replaced) and a bare key can never leak.
    const title = t(fallbackTitleKey, titleParams ?? {})
    showFailure(title, t(failure.descriptionKey), detail, id)
  }

  /** The failure toast both generic paths render: translated title and description, the raw
   * detail behind "Show details", and the whole report copyable. */
  function showFailure(title: string, description: string, detail: string, id?: string): void {
    const report = failureReport(title, description, detail)
    const added = toast.add({
      id,
      title,
      description,
      color: 'error',
      icon: 'i-lucide-triangle-alert',
      duration: 0,
      // Selectable in place too: the copy button is the reliable path, but a reader who only wants
      // the request id should be able to drag over it.
      ui: { description: 'select-text' },
      actions: [
        ...(detail
          ? [
              {
                label: t('errors.generic.showDetail'),
                icon: 'i-lucide-info',
                onClick: () =>
                  toast.update(added.id, {
                    description: detail,
                    actions: [copyAction(report)],
                  }),
              },
            ]
          : []),
        copyAction(report),
      ],
    })
  }

  /**
   * A failure the backend reported as DATA rather than as a failed call: a job row with
   * `status: 'failed'` and its `error` text, a probe verdict with a `message`. There is no
   * envelope, so `present` would misread it as a network fault. The reported text is backend prose
   * and so DETAIL, never the headline: it goes behind "Show details" and into the copied report,
   * under a translated description (`descriptionKey`, or the generic "it reported a failure").
   */
  function presentReported(
    detail: string | null | undefined,
    titleKey: string,
    opts: { params?: Record<string, unknown>; descriptionKey?: string } = {},
  ): void {
    showFailure(
      t(titleKey, opts.params ?? {}),
      t(opts.descriptionKey ?? 'errors.reported.description'),
      detail?.trim() ?? '',
    )
  }

  /**
   * Present `error` as a toast. `fallbackTitleKey` is an i18n message key used for
   * non-conflict failures and any conflict reason without a dedicated title; `titleParams` carries
   * that key's interpolation when it takes any (a title naming the thing that failed).
   *
   * `dedupe` is for a call site that can fail again and again with nothing new to say: a search
   * that refires on every debounced query, or a section every reader of a run reloads. The toast
   * gets an id derived from `fallbackTitleKey`, so Nuxt UI replaces the toast already on screen
   * instead of stacking an identical one. The bespoke conflict toasts keep their own handling.
   */
  function present(
    error: unknown,
    fallbackTitleKey = 'common.actionFailed',
    titleParams?: Record<string, unknown>,
    options: { dedupe?: boolean } = {},
  ): void {
    const id = options.dedupe ? `pipeline-error:${fallbackTitleKey}` : undefined
    const conflict = parseConflict(error)
    if (conflict) {
      if (presentBespokeConflict(conflict)) return
      presentMappedConflict(conflict, fallbackTitleKey, titleParams, id)
      return
    }
    presentGenericFailure(error, fallbackTitleKey, titleParams, id)
  }

  return { present, presentReported }
}
