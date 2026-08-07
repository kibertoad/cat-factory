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

/**
 * The i18n key per reason for the REMEDY line: what an operator has to change to get the server
 * wired next run. Exhaustive on the same vocabulary and for the same reason as {@link REASON_KEY}.
 *
 * Split from the reason rather than folded into one sentence because the two answer different
 * questions and only one of them is stable: the reason states what the dispatch decided and is a
 * fact about that run forever, while the remedy names a surface this deployment happens to offer
 * (the Infrastructure window, a declaration in deployment code). The split is also the vocabulary's
 * own justification, since every member exists precisely because it needs a DIFFERENT fix
 * (`docs`' table in `backend/docs/mcp-tool-servers.md` is the same mapping for a reader who never
 * opens the SPA); a reason with no remedy leaves the operator holding an accurate diagnosis and no
 * next step, which is the state this surface was built to end.
 *
 * EDITING ONE OF THESE MEANS READING EVERY CAUSE IT COVERS FIRST. A member is not a cause:
 * `harness_unsupported`, `missing_secret` and `oauth_not_connected` are each reached from more
 * than one place, and a line addressing only the obvious one is a dead end for whoever hit the
 * other, which is worse than the bare diagnosis this replaced because it also costs them the
 * attempt. The causes per member are enumerated on kernel's `UnavailableToolServer` (which the SPA
 * cannot import) and restated in that doc's table, whose "What happened" column is the list to
 * check a remedy against.
 */
export const REMEDY_KEY: Record<ToolServerUnavailableReason, string> = {
  harness_unsupported: 'panels.stepDetail.toolServers.remedy.harnessUnsupported',
  transport_unsupported: 'panels.stepDetail.toolServers.remedy.transportUnsupported',
  missing_secret: 'panels.stepDetail.toolServers.remedy.missingSecret',
  reserved_secret: 'panels.stepDetail.toolServers.remedy.reservedSecret',
  oauth_not_connected: 'panels.stepDetail.toolServers.remedy.oauthNotConnected',
  oauth_token_failed: 'panels.stepDetail.toolServers.remedy.oauthTokenFailed',
  over_budget: 'panels.stepDetail.toolServers.remedy.overBudget',
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

/**
 * Render the remedy for one reason, or `null` when there is none to give.
 *
 * `null` is the honest answer for a RETIRED member and the reason it is not folded into
 * {@link reasonText}: this build knows the code was recorded and does not know what it meant, so it
 * cannot name a surface to change without guessing which current member the operator should act
 * on. The reason line already names the raw code, which is the whole of what is known.
 */
export function remedyText(
  reason: ToolServerUnavailableReason,
  t: (key: string, params?: Record<string, unknown>) => string,
): string | null {
  return isKnownReason(reason) ? t(REMEDY_KEY[reason]) : null
}
