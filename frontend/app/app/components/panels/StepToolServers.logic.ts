import { toolServerUnavailableReasonSchema } from '@cat-factory/contracts'
import type { ToolServerUnavailableReason } from '~/types/toolServers'

// The step surface's tool-server (MCP) reason mapping. Kept out of the SFC on the same seam as
// `StepTestReport.logic.ts`, so the vocabulary rule can be asserted without mounting a component.
//
// The rule: a dropped tool server is reported with the reason it was dropped for, and a reason
// this build does not recognise is rendered as unknown rather than dropped or folded onto a
// neighbour. The vocabulary is CLOSED and PERSISTED on a run, so a step recorded before a member
// was retired still carries that member, and a chip that silently vanished would report a
// withheld capability as one that was never declared, which is the confusion this surface exists
// to end.

/**
 * The i18n key per reason. An exhaustive `Record` rather than a lookup with a default, so a member
 * added to the wire vocabulary fails to compile here instead of rendering as a blank chip.
 */
export const REASON_KEY: Record<ToolServerUnavailableReason, string> = {
  harness_unsupported: 'panels.stepDetail.toolServers.reason.harnessUnsupported',
  transport_unsupported: 'panels.stepDetail.toolServers.reason.transportUnsupported',
  missing_secret: 'panels.stepDetail.toolServers.reason.missingSecret',
  reserved_secret: 'panels.stepDetail.toolServers.reason.reservedSecret',
  oauth_not_connected: 'panels.stepDetail.toolServers.reason.oauthNotConnected',
  oauth_token_failed: 'panels.stepDetail.toolServers.reason.oauthTokenFailed',
  over_budget: 'panels.stepDetail.toolServers.reason.overBudget',
}

/** The reason vocabulary as the SCHEMA states it: what a parity assertion grades {@link REASON_KEY} against. */
export const KNOWN_REASONS = toolServerUnavailableReasonSchema.options

/**
 * Whether a persisted reason is a member THIS build knows, derived from the picklist's own options
 * rather than from a list retyped here.
 *
 * A predicate rather than a truthiness check on the lookup, because `REASON_KEY` is an ordinary
 * object literal: a persisted value that happens to name an inherited `Object.prototype` member
 * (`constructor`, `toString`) reads back as a truthy non-key and would be handed to `t` as though
 * it were a translation key, taking the retired-member path away from exactly the case it exists
 * for. Narrowing at the boundary keeps the exhaustive `Record` compile-time guard intact.
 */
export function isKnownReason(reason: string): reason is ToolServerUnavailableReason {
  return (KNOWN_REASONS as readonly string[]).includes(reason)
}

/**
 * Render one reason, falling back to the retired-member line that names the raw code.
 *
 * `t` is passed in rather than composed here so this stays a pure function: the component owns the
 * i18n instance, and the fallback branch is the one worth testing without one.
 */
export function reasonText(
  reason: ToolServerUnavailableReason,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  return isKnownReason(reason)
    ? t(REASON_KEY[reason])
    : t('panels.stepDetail.toolServers.reason.unknown', { reason })
}
