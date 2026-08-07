# Initiative: enterprise SSO sign-in

**Status:** generic OIDC LANDED (slices 1-4), OFFBOARDING REVOCATION LANDED (slice 6) · SAML and
group→role mapping open · **Owner:** core · **Started:** 2026-08-04

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

Pairs with [`audit-log-and-session-revocation.md`](./audit-log-and-session-revocation.md), which
owns the other half of the same org-adoption story (the audit trail and session revocation). Read
both before starting either: slice 5 there and slice 6 here meet.

Shipped behaviour and configuration:
[`backend/docs/auth.md`](../../backend/docs/auth.md#enterprise-sso-generic-oidc). This tracker keeps
only the rationale and what is still open.

## Goal & rationale

Sign-in was GitHub OAuth, Google OAuth, or email/password. Every one of those is a CONSUMER
identity provider, and for an org-shaped evaluation that is disqualifying before any feature
comparison starts:

- **There was no way to say "only our people".** The sign-in allowlist was named users plus GitHub
  org membership. An org whose directory is Okta / Entra / Google Workspace could not express its
  own membership, so onboarding and offboarding were manual and offboarding is the one that
  matters: a person who left kept a working login until somebody remembered to edit a list.
- **There was no way to satisfy a security review.** MFA, conditional access, device posture and
  session policy all live in the IdP. A product that cannot sit behind it inherits none of them,
  and "we support Google login" is not an answer to any of those questions.
- **Group-driven roles were impossible.** Workspace roles ([ADR 0025](../../backend/docs/adr/0025-workspace-rbac.md))
  are assigned per person by hand. An org that already models "engineers" and "product" as
  directory groups had to restate that here and keep the two in step forever.

End state: a deployment configures ONE generic OIDC provider by discovery URL and client
credentials, and its people sign in with it. Optionally, group claims map onto workspace roles.

## Target pattern

1. **Generic OIDC, not per-vendor integrations.** Okta, Entra, Auth0, Keycloak, Google Workspace,
   PingFederate and a Shibboleth IdP with the OIDC OP plugin are all OIDC providers; a discovery
   document (`/.well-known/openid-configuration`) plus a client id/secret is the whole
   configuration. Nothing in the adapter branches on which provider answered.
2. **It reuses `user_identities` as-is.** That table is already `(provider, subject)` keyed with a
   `metadata` blob, which is exactly an OIDC issuer + `sub`. So there is NO new identity table, no
   migration, and no change to how a person keeps one canonical `usr_*` across login methods.
3. **Authorization Code + PKCE, discovery-driven, JWKS-verified.** No implicit flow, no hard-coded
   endpoints, no shared-secret ID-token validation. The CSRF state reuses the same signed-nonce
   signer the GitHub flow uses, so CSRF protection is one implementation.
4. **The session it mints is the SAME session.** OIDC replaces how identity is ESTABLISHED, not
   what a session is: the outcome is the existing `SessionPayload` bearer token, so every route,
   the WS ticket and the RBAC gate are untouched.
5. **Claim → role mapping is OPTIONAL and additive.** Absent ⇒ roles stay hand-assigned,
   byte-for-byte today's behaviour. (Still open; see slice 5 and the finding under it.)

## Prioritized checklist

| #   | Slice                                                                                                     | Status     | PR   |
| --- | --------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 1   | OIDC config (discovery URL, client id/secret, scopes) + a cached discovery/JWKS fetch                     | ✅ done    | this |
| 2   | `/auth/sso/login` + `/auth/sso/callback`: PKCE, signed state, ID-token verification against JWKS          | ✅ done    | this |
| 3   | Identity linking through `user_identities` (`provider: 'oidc'`, subject = `iss#sub`) + first-login create | ✅ done    | this |
| 4   | SPA sign-in button + the "which methods are configured" projection it reads                               | ✅ done    | this |
| 4b  | Group / email-domain ADMISSION narrowings, checked on every sign-in                                       | ✅ done    | this |
| 5   | Group-claim → workspace-role mapping (opt-in), applied on each sign-in                                    | ⬜ blocked |      |
| 6   | Offboarding: revoke live sessions when a sign-in is refused                                               | ✅ done    | this |
| 7   | SAML 2.0 SP, for a provider with no OIDC surface (classic Shibboleth)                                     | ⬜ todo    |      |
| 8   | A deployment-OPERATOR configuration surface, if env-only proves too coarse                                | ⬜ todo    |      |

## Conventions & gotchas

These bind anything that touches the SSO path. The ones the landed slices PROVED are marked.

- **(proved) `iss` must be part of the subject key, not just `sub`.** `sub` is unique per issuer,
  not globally; keying on it alone would let two deployments' directories collide on one row the
  day a second provider is configured. `oidcIdentitySubject` (kernel) mints `iss#sub` and is the
  only place that shape is known. The issuer used is the DISCOVERED one, never the URL an operator
  typed: those differ in trailing slashes and casing, and a subject that drifted with an operator's
  spelling would orphan every existing identity on the next config edit.
- **(proved) Never trust the ID token's `email` as an identity key.** Emails are reassigned inside
  orgs and some providers let a user change theirs. `sub` is the identity; the email is display data
  refreshed on each login.
- **(proved, with a decision) `email_verified` absence is treated as VERIFIED.** A great many
  enterprise ID tokens omit the claim for an address that came straight out of the corporate
  directory. Requiring it forks a second user for anyone who also signed in with GitHub, and —
  because `users.email` is unique and an unverified email is dropped — leaves the SSO account with
  no email at all, breaking invitations and every roster display. Only an EXPLICIT
  `email_verified: false` is honoured as unverified. Revisit if a deployment ever needs the strict
  reading; it would want to be a per-deployment switch rather than a flipped default.
- **(proved) Discovery and JWKS are CACHED but must be refreshable.** Providers rotate signing keys
  without notice, so a JWKS miss on an unknown `kid` refetches once (rate-limited to one per
  minute) rather than failing the login. Cached through the `AppCaches` seam
  (`ssoDiscovery`), not a module `Map`. Unlike most slices it stays ENABLED on the Worker's
  isolate-safe profile, because the entry is external state that self-heals on rotation rather than
  our own mutable state needing an invalidation bus.
- **(proved) The round-trip state cannot live in the URL.** PKCE's `code_verifier` and OIDC's
  `nonce` are secrets. The whole round-trip is signed into ONE httpOnly cookie and only an opaque
  nonce goes in `state`. A consequence worth knowing: the post-login redirect target is fixed at
  login time, so the callback leg has no untrusted redirect input at all.
- **(proved) `AUTH_DEV_OPEN` must not be reachable in a deployment configuring SSO.** Refused at
  boot as a PAIR (`resolveSsoConfig`), rather than resolving to one of them winning. Same treatment
  for a partial credential set, a non-https issuer, and a session secret too weak to sign what SSO
  mints.
- **(proved) A groups claim arrives in at least four shapes**: an array of strings, one string, a
  space-separated string, and an array of `{value}`/`{name}` objects. A reader that handles one
  shape does not fail loudly; it reads zero groups, and a `requiredGroups` gate that reads zero
  groups refuses the whole org while looking exactly like an operator typo. `readGroupClaim` takes
  all four.
- **Admission DEFAULTS TO ADMIT, deliberately.** With SSO configured, the IdP's own app assignment
  IS the allowlist — that is the capability the feature exists to deliver. Do not "harden" this into
  a fail-closed list; the narrowings (`AUTH_SSO_REQUIRED_GROUPS`,
  `AUTH_SSO_ALLOWED_EMAIL_DOMAINS`) are how an org that needs less than its whole directory says so.
- **(proved) The session-revocation dependency was REAL, and slice 6 closed it.** SSO's whole
  offboarding promise is "we disabled them in the IdP and they lost access", and a stateless HMAC
  session did not deliver that on its own. Group membership was already re-read on every sign-in,
  so a removed user could not get a NEW session; what was missing was the one they already held.

### How the revocation half landed (and what it cost)

Both trackers' slices shipped together, as they said they should. Shape and rationale:
[`auth.md` → Session revocation](../../backend/docs/auth.md#session-revocation); the design
decisions are recorded under "What slices 4-7 settled" in the
[paired tracker](./audit-log-and-session-revocation.md).

The two options were a cached generation read or short session TTLs plus a bump. **The cached read
won**, because a bounded revocation WINDOW is the one property an offboarding story cannot
advertise: "we disabled them and they lost access, within the hour" is not the claim an org is
buying. The Worker's isolate-safe profile passes the entry through, so that facade pays a real
per-request D1 read — accepted deliberately, and recorded here rather than discovered in
production, exactly as this section asked.

What this slice does in the SSO leg specifically: when `judgeSsoAdmission` refuses a returning
user, their existing sessions are revoked as well as the new one withheld. Keyed on the same
`iss#sub` subject as sign-in and never the email, so a departed employee whose address was
reassigned cannot cost the new holder their sessions. Best-effort, because the refusal has already
succeeded and a store failure must not turn a correct denial into a 500 that reads as broken SSO
configuration; `sessionsRevoked` on the `sso.refused` log line separates "refused and cut their
sessions" from "refused and they still hold a live bearer".

**A role WITHDRAWAL deliberately does not revoke**, though the original checklist line said it
should. The RBAC gate re-reads roles on the next request and the token carries none, so a
downgrade needs no revocation; bumping the generation would sign a person out of every board
because their role on one was adjusted. That makes slice 5 here (group → workspace role) fully
independent of this one rather than blocked behind it.

### Slice 5 (group → workspace role) is BLOCKED on a target-workspace design, not on plumbing

Reading the groups is done (`readGroupClaim`, exercised by the admission gate). What is missing is
the other half of the sentence "map group values onto workspace roles": **which** workspace.

A brand-new SSO user has no workspaces, and workspaces belong to accounts. There is today no
"every member of this org sees these boards" concept for a role assignment to land on, so a
`group=role` map has no well-defined target. The three shapes worth weighing before writing any of
it:

- **Per-workspace map, configured on the workspace.** Fits the existing RBAC model exactly and
  needs no new tenancy concept, but it is per-board configuration for an org-wide fact, and it does
  nothing for a user's FIRST login (they see no boards to be given a role on).
- **Account-level default role from a group**, applied to the personal/org account on each
  sign-in, with workspace roles continuing to derive from account membership. Solves first-login,
  but only as coarsely as the account tier already is.
- **A group → account-membership map**, i.e. treat directory groups as the org roster. The most
  useful and the largest: it makes the directory authoritative over `account_members`, which needs
  a removal story (a user dropped from every mapped group) that the admission gate deliberately
  does not have.

Whichever is picked, the rule from the target pattern holds: absent configuration must be
byte-for-byte today's hand-assigned behaviour.

### Slice 7 (SAML 2.0) — why it is not in the OIDC slices, and what it costs

Every hosted directory speaks OIDC, and Shibboleth IdP 4.1+ can via the OIDC OP plugin. A **classic
SAML-2.0-only** deployment (a Shibboleth IdP without that plugin, or an org standardised on SAML)
is therefore the gap, and it is a genuinely separate body of work rather than another adapter
behind the same seam:

- **XML Digital Signature verification is the whole slice.** Exclusive canonicalisation
  (`exc-c14n`) over a namespace-aware DOM, the enveloped-signature transform, and RSA/ECDSA
  verification against certificates from IdP metadata. There is no Web-Crypto primitive for any of
  it, and the runtime-symmetry rule means it must run in a Workers isolate as well as on Node, so
  the usual Node-only libraries (`xml-crypto` on `node:crypto`) are not available as-is.
- **The hardening, not the parsing, is where implementations fail.** Signature-wrapping (XSW)
  attacks defeat any verifier that finds a `Signature` element and trusts whatever it points at.
  The mitigations have to be designed in: reject a `DOCTYPE`/entity declarations, require exactly
  one assertion, refuse duplicate element IDs, bind the `Reference` URI to the ID of the element
  the signature is a direct child of, and re-select the consumed assertion BY its verified ID
  rather than by position.
- **A DER walker is needed** to lift `SubjectPublicKeyInfo` out of an X.509 certificate, since
  `importKey('spki', …)` will not take a whole certificate.
- **Two protocol details shape the design and are easy to miss.** SameSite=Lax cookies are NOT sent
  on the cross-site POST that delivers a `SAMLResponse` to the ACS endpoint, so the round-trip
  cookie must be `SameSite=None; Secure` (which also means SAML needs HTTPS, including in
  development). And `RelayState` is capped at 80 bytes by the spec, so the signed round-trip cannot
  ride in it — put an opaque nonce there and keep the state in the cookie, as the OIDC leg already
  does.
- **It needs no new table.** Requiring SP-initiated flows (refusing an unsolicited
  `SAMLResponse` with no `InResponseTo`) makes the single-use round-trip cookie the replay
  protection, exactly as it is for OIDC. That is a deliberate reduction in scope worth keeping:
  IdP-initiated SAML would need a persisted assertion-ID replay cache, with a migration on both
  runtimes plus a mothership routing decision.

Sizing: the verification core plus its attack-fixture tests is the bulk, and it is security-critical
enough that it should land on its own, reviewed on its own, rather than riding alongside a login
flow. Until it does, the honest answer for a SAML-only org is that they are not served: say so
rather than pointing them at the OIDC button.

### Slice 8 (a configuration UI) — the shape it would have to take

SSO is env-only today, and the reasoning is in
[`auth.md`](../../backend/docs/auth.md#why-sso-is-configured-by-environment-not-in-the-ui): it is
the deployment's trust root, the bootstrap is circular, and the refusals are boot-time. The trade
an operator pays is that rotating a client secret is a config change plus a restart.

If that proves too coarse, the slice is NOT "add SSO to the account-settings screen". Whoever can
edit the identity provider can point it at one they control and sign in as anybody, so a
workspace-admin-editable provider makes workspace admin a path to every account on the deployment.
The shape that could work: a DEPLOYMENT-OPERATOR surface (a tier that does not exist yet, and whose
introduction is the actual cost), with every boot refusal re-expressed as a runtime guard on the
write, and env retained as the bootstrap path so a deployment can always be brought up without a
working login.
