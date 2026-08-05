import { type SsoErrorReason } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Enterprise SSO presentation, in ONE place — the same convention as `utils/vcs.ts`.
//
// The backend does not localize prose (CLAUDE.md's i18n rule): a refused SSO round-trip lands
// back here with a machine-readable reason, and this module is where each reason becomes copy.
// ---------------------------------------------------------------------------

/**
 * A failed SSO sign-in as the SPA models it: one of the wire reasons, or `unknown`.
 *
 * `unknown` is not a wire value — it is what a reason from a NEWER backend than this build reads
 * as. Without it the alternatives are rendering the raw wire token to a user or showing nothing
 * at all after a failed sign-in, and the second is the worse one: the user clicked the button and
 * came back to the same button.
 */
export type SsoLoginFailure = SsoErrorReason | 'unknown'

/**
 * The copy key per failure. An exhaustive `Record`, so a member added to the wire vocabulary
 * fails this typecheck until it has wording — the drift guard the `UNAVAILABLE_REASONS` pattern
 * establishes.
 *
 * The wording split matters more than it looks: `group_required` and `domain_not_allowed` are
 * things the USER takes to their IT team, while `exchange_failed` and `token_invalid` are
 * OPERATOR faults in the deployment's own configuration. One "sign-in failed" for all four sends
 * every user to the wrong place.
 */
export const SSO_ERROR_MESSAGE_KEYS: Record<SsoLoginFailure, string> = {
  state_invalid: 'auth.sso.errors.stateInvalid',
  provider_denied: 'auth.sso.errors.providerDenied',
  exchange_failed: 'auth.sso.errors.exchangeFailed',
  token_invalid: 'auth.sso.errors.tokenInvalid',
  subject_missing: 'auth.sso.errors.subjectMissing',
  group_required: 'auth.sso.errors.groupRequired',
  domain_not_allowed: 'auth.sso.errors.domainNotAllowed',
  email_required: 'auth.sso.errors.emailRequired',
  unknown: 'auth.sso.errors.unknown',
}
