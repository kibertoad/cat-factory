import {
  delegatedSpendUnreported,
  isRunDelegationStatus,
  runDelegationStatusSchema,
} from '@cat-factory/contracts'
import type { PipelineStep, RunDelegationStatus } from '~/types/execution'

// The DELEGATION status vocabulary's presentation. Kept out of the SFC on the same seam as
// `StepToolServers.logic.ts`, so the rule can be asserted without mounting a component.
//
// The rule: the status of external work is a CLOSED and PERSISTED vocabulary, so a row written by
// another build can hold a member this one retired. Every `Record<RunDelegationStatus, …>` over it
// is therefore total against the TYPE and partial against the DATA, and indexing one bare is
// `undefined.cls` thrown during render: a white screen over the one panel that says what happened
// to work the platform cannot see. A value this build does not know is RENDERED as unrecognised,
// carrying the raw string, never guessed onto a current member: nothing can know which one was
// meant, and the wrong guess reports the wrong outcome for a run somebody may need to go and stop.

/** How each status renders. Exhaustive, so a member added to the vocabulary fails to compile here. */
export const DELEGATION_STATUS_META: Record<
  RunDelegationStatus,
  { icon: string; spin: boolean; cls: string }
> = {
  starting: {
    icon: 'i-lucide-loader-circle',
    spin: true,
    cls: 'border-sky-900/50 bg-sky-950/30 text-sky-300',
  },
  running: {
    icon: 'i-lucide-radio',
    spin: false,
    cls: 'border-indigo-900/50 bg-indigo-950/30 text-indigo-300',
  },
  done: {
    icon: 'i-lucide-circle-check',
    spin: false,
    cls: 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300',
  },
  failed: {
    icon: 'i-lucide-circle-x',
    spin: false,
    cls: 'border-rose-900/50 bg-rose-950/30 text-rose-300',
  },
  cancelled: {
    icon: 'i-lucide-circle-slash',
    spin: false,
    cls: 'border-amber-900/50 bg-amber-950/30 text-amber-300',
  },
}

/**
 * Static literal keys (not a runtime-built `t(`…${status}`)`) so the typed-message-keys check
 * covers them; exhaustive on the same vocabulary and for the same reason as
 * {@link DELEGATION_STATUS_META}.
 */
export const DELEGATION_STATUS_KEY: Record<RunDelegationStatus, string> = {
  starting: 'panels.stepMeta.delegated.status.starting',
  running: 'panels.stepMeta.delegated.status.running',
  done: 'panels.stepMeta.delegated.status.done',
  failed: 'panels.stepMeta.delegated.status.failed',
  cancelled: 'panels.stepMeta.delegated.status.cancelled',
}

/**
 * How a status this build does not recognise renders: amber, like `cancelled`, because both mean
 * "something here wants a person to look". Its own row rather than a borrowed one, so nothing reads
 * it as one of the known outcomes.
 */
export const UNKNOWN_DELEGATION_STATUS_META = {
  icon: 'i-lucide-circle-help',
  spin: false,
  cls: 'border-amber-900/50 bg-amber-950/30 text-amber-300',
}

/** The vocabulary as the SCHEMA states it: what a parity assertion grades the two maps against. */
export const KNOWN_DELEGATION_STATUSES = runDelegationStatusSchema.options

/** What the card renders for one persisted status, known or not. */
export interface DelegationStatusView {
  /** The narrowed member, or null for a value this build does not know. */
  status: RunDelegationStatus | null
  meta: { icon: string; spin: boolean; cls: string }
  /** The i18n key plus the parameters it takes; the raw value rides the unrecognised one. */
  labelKey: string
  labelParams: Record<string, string>
}

/**
 * Resolve one persisted status into everything the card shows for it.
 *
 * One function rather than three guarded lookups in the template, because the guard is the whole
 * point: three places to narrow is three places to forget, and forgetting once throws.
 */
export function delegationStatusView(status: string | undefined): DelegationStatusView {
  if (status && isRunDelegationStatus(status)) {
    return {
      status,
      meta: DELEGATION_STATUS_META[status],
      labelKey: DELEGATION_STATUS_KEY[status],
      labelParams: {},
    }
  }
  return {
    status: null,
    meta: UNKNOWN_DELEGATION_STATUS_META,
    labelKey: 'panels.stepMeta.delegated.status.unrecognised',
    labelParams: { status: status ?? '' },
  }
}

/**
 * The run URL as an `href`, or null when it is not one this SPA may link to.
 *
 * Everything on the delegation record comes from an EXTERNAL system: `url` is whatever that
 * system's API answered with, and this card puts it in the primary affordance a person clicks.
 * Bound straight into `href`, a `javascript:` value executes in the SPA's own origin, which is the
 * same boundary `resolveExternalToolUrl` draws for a resolver-supplied URL and the same one
 * kernel's `hostMarkdown.link` draws server-side.
 *
 * A refused value is not dropped: the caller renders it as plain text, because "the executor
 * reported this link and we will not follow it" is a fact worth showing, and a silently missing
 * link reads as a run that reported none.
 */
export function externalRunHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null
  } catch {
    // A relative or malformed value: not something to link to, and not an error either. The card
    // shows the raw string, which is what the executor actually said.
    return null
  }
}

/**
 * Whether the card says the platform is not measuring this step's spend.
 *
 * Two questions, and the split is the whole point. Once the work has SETTLED the answer is
 * contracts' `delegatedSpendUnreported`, over what actually LANDED, which is the same rule the
 * backend's reporting-gap fold reads: keying this side on the executor's declared `telemetry`
 * instead made the two disagree in both directions at once, an executor declaring `self-reported`
 * that files nothing showing no warning here while the debug overview counted the step, and one
 * declaring `not-reported` that does fill `DelegationResult.usage` printing "not reported" beside
 * a real number.
 *
 * While the work is IN FLIGHT only the declaration can say anything, because a `self-reported`
 * executor files with its result and has correctly reported nothing yet. So the line is shown for
 * one that declares the number is never coming, and for one this build no longer registers, where
 * nothing here can say otherwise.
 */
export function delegatedUsageUnreported(
  step: Pick<PipelineStep, 'delegated' | 'metrics'>,
  executor: { telemetry?: 'not-reported' | 'self-reported' } | undefined,
): boolean {
  if (delegatedSpendUnreported(step)) return true
  const status = step.delegated?.status
  const inFlight = status === 'starting' || status === 'running'
  return inFlight && executor?.telemetry !== 'self-reported'
}
