import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Enterprise SSO: the wire vocabulary the backend and the SPA must agree about.
//
// Sign-in through a deployment's OWN identity provider (Okta, Entra ID, Auth0, Keycloak,
// PingFederate, OneLogin, JumpCloud, a Shibboleth IdP running the OIDC OP plugin) rather than
// through a consumer provider. One generic adapter serves all of them: a discovery document
// plus a client id/secret is the entire configuration, so there is nothing per-vendor to name
// here — only the PROTOCOL, which is what a second adapter would extend.
//
// A failed SSO round-trip lands the browser back on the SPA with a machine-readable reason in
// the URL fragment rather than a JSON envelope the user would have to read raw. The backend
// does not localize prose (CLAUDE.md's i18n rule), so the vocabulary is closed here and the SPA
// maps each member to translated copy through an exhaustive `Record`.
// ---------------------------------------------------------------------------

/**
 * The SSO protocols the adapter speaks.
 *
 * `oidc` covers every provider that exposes an OpenID Connect discovery document, which is all
 * of the hosted directories and a Shibboleth IdP with the OIDC OP plugin installed. A classic
 * SAML-2.0-only Shibboleth deployment is NOT served by it and is deliberately absent rather
 * than approximated: see `docs/initiatives/enterprise-sso-oidc.md`. Adding `saml` here is what
 * that slice extends, and every switch over this union fails to compile until it is handled.
 */
export const ssoProtocolSchema = v.picklist(['oidc'])
export type SsoProtocol = v.InferOutput<typeof ssoProtocolSchema>

/**
 * What `GET /auth/config` reports about the configured provider, so the login screen can render
 * the operator's own wording ("Sign in with Acme SSO") instead of a generic button. Present only
 * when SSO is configured; `providers.sso` is the boolean the SPA gates on.
 */
export const ssoConfigViewSchema = v.object({
  /** Operator-supplied button label (`AUTH_SSO_LABEL`), never localized — it names their IdP. */
  label: v.string(),
  protocol: ssoProtocolSchema,
})
export type SsoConfigView = v.InferOutput<typeof ssoConfigViewSchema>

/**
 * Why an SSO sign-in did not produce a session. Each member is a DIFFERENT operator or user
 * action, which is the whole reason the vocabulary is not one `sso_failed`:
 *
 * - `state_invalid` — the round-trip's signed state / browser-binding cookie didn't verify.
 *   A stale bookmark, a cookie-less browser, or a genuinely forged callback. Retrying works.
 * - `provider_denied` — the IdP itself refused (`?error=access_denied` …): the user cancelled,
 *   or the app is not assigned to them. Nothing on this side to fix.
 * - `exchange_failed` — the code-for-token call failed. A wrong client secret or a
 *   `redirect_uri` the IdP does not have registered: an OPERATOR fault, not the user's.
 * - `token_invalid` — the ID token failed verification (signature, issuer, audience, nonce or
 *   expiry). A misconfigured client id, a clock skew, or an attack.
 * - `subject_missing` — the token verified but carries no `sub`, so there is no stable identity
 *   to key a user on. A non-conforming provider.
 * - `group_required` — the user authenticated but is in none of `AUTH_SSO_REQUIRED_GROUPS`.
 *   The user needs a directory group, and the message must say so rather than read as a bug.
 * - `domain_not_allowed` — their verified email's domain is not on
 *   `AUTH_SSO_ALLOWED_EMAIL_DOMAINS`. Distinct from `group_required` because the remedy differs.
 * - `email_required` — an email-domain allowlist is configured but the provider released no
 *   verified email to check it against, so admission cannot be decided. An operator must
 *   release the `email` claim (or drop the allowlist); admitting instead would silently void it.
 */
export const ssoErrorReasonSchema = v.picklist([
  'state_invalid',
  'provider_denied',
  'exchange_failed',
  'token_invalid',
  'subject_missing',
  'group_required',
  'domain_not_allowed',
  'email_required',
])
export type SsoErrorReason = v.InferOutput<typeof ssoErrorReasonSchema>

/** Every reason, for the SPA's exhaustive copy `Record` and the coverage test over it. */
export const SSO_ERROR_REASONS = ssoErrorReasonSchema.options

/**
 * The URL-fragment key a failed SSO round-trip lands under, the sibling of the `token=` key a
 * successful one uses. A FRAGMENT (not a query) for the same reason the token is: it never
 * reaches a server log or a `Referer` header, and the reason names the deployment's admission
 * rules. Shared so the redirect builder and the SPA reader cannot drift.
 */
export const SSO_ERROR_FRAGMENT_KEY = 'sso_error'

/**
 * Read a reason off an untrusted string, or null when it names none.
 *
 * Total by construction (derived from the picklist's own options), so a member added above is
 * parseable with no edit here — and a value from a NEWER backend than the SPA reads as "unknown
 * failure" rather than being rendered as the literal wire token.
 */
export function parseSsoErrorReason(value: string | null | undefined): SsoErrorReason | null {
  if (!value) return null
  return (SSO_ERROR_REASONS as readonly string[]).includes(value) ? (value as SsoErrorReason) : null
}
