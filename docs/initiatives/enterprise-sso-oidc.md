# Initiative: enterprise SSO (generic OIDC) sign-in

**Status:** planned (design settled; no slices landed) · **Owner:** core · **Started:** 2026-08-04

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

Pairs with [`audit-log-and-session-revocation.md`](./audit-log-and-session-revocation.md), which
owns the other half of the same org-adoption story (the audit trail and session revocation). Read
both before starting either: slice 5 there and slice 6 here meet.

## Goal & rationale

Sign-in today is GitHub OAuth, Google OAuth, or email/password
([`backend/docs/auth.md`](../../backend/docs/auth.md)). Every one of those is a CONSUMER identity
provider, and for an org-shaped evaluation that is disqualifying before any feature comparison
starts:

- **There is no way to say "only our people".** The sign-in allowlist is named users plus GitHub
  org membership. An org whose directory is Okta / Entra / Google Workspace cannot express its own
  membership, so onboarding and offboarding are manual and offboarding is the one that matters:
  a person who left keeps a working login until somebody remembers to edit a list.
- **There is no way to satisfy a security review.** MFA, conditional access, device posture and
  session policy all live in the IdP. A product that cannot sit behind it inherits none of them,
  and "we support Google login" is not an answer to any of those questions.
- **Group-driven roles are impossible.** Workspace roles ([ADR 0025](../../backend/docs/adr/0025-workspace-rbac.md))
  are assigned per person by hand. An org that already models "engineers" and "product" as
  directory groups has to restate that here and keep the two in step forever.

End state: a deployment configures ONE generic OIDC provider by discovery URL and client
credentials, and its people sign in with it. Optionally, group claims map onto workspace roles.

## Target pattern

1. **Generic OIDC, not per-vendor integrations.** Okta, Entra, Auth0, Keycloak, Google Workspace
   and PingFederate are all OIDC providers; a discovery document (`/.well-known/openid-configuration`)
   plus a client id/secret is the whole configuration. Shipping "Okta support" and "Entra support"
   as separate code paths is the mistake the VCS layer already learned not to make
   (see the git-provider-agnostic rules in CLAUDE.md): one adapter, configuration per deployment.
2. **It reuses `user_identities` as-is.** That table is already `(provider, subject)` keyed with a
   `metadata` blob, which is exactly an OIDC issuer + `sub`. So there is NO new identity table and
   no change to how a person keeps one canonical `usr_*` across login methods.
3. **Authorization Code + PKCE, discovery-driven, JWKS-verified.** No implicit flow, no hard-coded
   endpoints, no shared-secret ID-token validation. The `state` nonce reuses the existing signed-
   nonce helper the GitHub flow uses, so CSRF protection is one implementation.
4. **The session it mints is the SAME session.** OIDC replaces how identity is ESTABLISHED, not
   what a session is: the outcome is the existing `SessionPayload` bearer token, so every route,
   the WS ticket and the RBAC gate are untouched.
5. **Claim → role mapping is OPTIONAL and additive.** A deployment names a groups claim and maps
   group values onto workspace roles. Absent ⇒ roles stay hand-assigned, byte-for-byte today's
   behaviour.

## Prioritized checklist

| #   | Slice                                                                                                     | Status  | PR  |
| --- | --------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | OIDC config (discovery URL, client id/secret, scopes) + a cached discovery/JWKS fetch                     | ⬜ todo |     |
| 2   | `/auth/oidc/login` + `/auth/oidc/callback`: PKCE, signed `state`, ID-token verification against JWKS      | ⬜ todo |     |
| 3   | Identity linking through `user_identities` (`provider: 'oidc'`, subject = `iss#sub`) + first-login create | ⬜ todo |     |
| 4   | SPA sign-in button + the "which methods are configured" projection it reads                               | ⬜ todo |     |
| 5   | Group-claim → workspace-role mapping (opt-in), applied on each sign-in                                    | ⬜ todo |     |
| 6   | Offboarding: revoke live sessions when a sign-in is refused or a role is withdrawn                        | ⬜ todo |     |

## Conventions & gotchas

- **`iss` must be part of the subject key, not just `sub`.** `sub` is unique per issuer, not
  globally; keying on it alone would let two deployments' directories collide on one row the day a
  second provider is configured. Store `iss#sub`.
- **Never trust the ID token's `email` as an identity key.** Emails are reassigned inside orgs and
  some providers let a user change theirs. `sub` is the identity; the email is display data that
  may be refreshed on each login.
- **Discovery and JWKS are CACHED but must be refreshable.** Providers rotate signing keys without
  notice, so a JWKS miss on an unknown `kid` refetches once (rate-limited) rather than failing the
  login. Cache through the `AppCaches` seam, not a module `Map` (CLAUDE.md's caching rule): the
  Worker profile passes through, which is correct here because the document is version-probed.
- **`AUTH_DEV_OPEN` must not be reachable in a deployment configuring OIDC.** An org adopting SSO
  to satisfy a security review must not have a config combination that serves the API openly; boot
  validation should refuse the pair rather than trusting an operator to not set both.
- **The session-revocation dependency is REAL, and it is the reason slice 6 exists.** SSO's whole
  offboarding promise is "we disabled them in the IdP and they lost access", and a stateless HMAC
  session does not deliver that on its own: the bearer stays valid until it expires, whatever the
  directory now says. So SSO without
  [`audit-log-and-session-revocation.md`](./audit-log-and-session-revocation.md) slice 5 is a
  half-promise, and the two should land together.

### What the revocation half actually costs (measured, not estimated)

The paired tracker's slice 5 says "fold the generation check into the user/principal resolution the
request already performs". Reading the code, **there is no such resolution to fold into**:
`requireAuth` → `verifySession` verifies the HMAC and reads the claims, and never touches the user
row. That is what makes the current design fast and what makes revocation cost something.

So the check is not free, and the honest options are:

- **A cached generation read through `AppCaches`**, invalidated on bump. Cheap per request after
  the first, and the invalidation is the coherence story (CLAUDE.md's caching rule). On the Worker
  the isolate-safe profile passes through for our own mutable state, so this reads live there,
  which is a real per-request D1 read on the hot path, and the slice must state whether that is
  acceptable rather than discovering it in production.
- **Short session TTLs plus a bump**, accepting a bounded window instead of instant revocation.
  Weaker, but it adds no read at all and may be the right trade for the first slice.

Either way it is a per-runtime decision with a user-row column behind it (D1 migration ⇄ Drizzle +
`db:generate`), not a one-line middleware change. Size it accordingly.
