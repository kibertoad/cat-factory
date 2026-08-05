---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Enterprise SSO: sign in through the deployment's own identity provider

Sign-in was GitHub OAuth, Google OAuth, or email/password, and all three are CONSUMER identity
providers. For an organisation that is disqualifying before any feature comparison starts. There was
no way to say "only our people" (the allowlist was named users plus GitHub org membership, so
offboarding waited on somebody remembering to edit a list); no way to sit behind the MFA,
conditional access and session policy that live in the IdP; and no way to let a directory that
already models "engineers" and "product" mean anything here.

A deployment now configures ONE generic OpenID Connect provider by discovery URL plus client
credentials, and its people sign in with it: `AUTH_SSO_ISSUER_URL` / `AUTH_SSO_CLIENT_ID` /
`AUTH_SSO_CLIENT_SECRET`, with an optional label, scopes, redirect override, and two admission
narrowings. Okta, Microsoft Entra ID, Auth0, Keycloak, PingFederate, OneLogin, JumpCloud, Google
Workspace and a Shibboleth IdP running the OIDC OP plugin all work through it, and so does a
provider none of us has heard of, because nothing in the adapter branches on which one answered — a
per-vendor code path would mean a provider is supported only once it is named, and would pin
endpoints the provider is free to move.

Authorization Code + PKCE (S256), ID tokens verified against the provider's JWKS with an
ASYMMETRIC-only algorithm allow-list, which is what refuses both `alg: none` and an `HS256` token
forged with the deployment's own client secret. Verification is delegated to `jose` rather than
hand-rolled: it is Web-Crypto native, so it runs unchanged in a Workers isolate and on Node, and its
keys are supplied from OUR cache rather than through its remote-JWKS helper, so one evictable app
cache slice (`AppCaches.ssoDiscovery`) owns the document. A rotated signing key costs one
rate-limited refetch on an unknown `kid`, not a login outage until a TTL lapses.

Three readings shaped the rest. The identity subject is `<discovered issuer>#<sub>`, never the
email: a `sub` is unique per issuer only, and orgs reassign addresses, so keying on either alone
eventually hands one person another's account. The round-trip state rides an httpOnly cookie rather
than the URL, because PKCE's verifier and OIDC's nonce are secrets and a verifier travelling beside
the code it protects protects nothing — which incidentally leaves the callback leg with no untrusted
redirect input at all. And admission DEFAULTS TO ADMIT: with SSO configured the IdP's app assignment
IS the allowlist, which is the capability being bought, so the fail-closed treatment the GitHub
lists get would defeat it. `AUTH_SSO_REQUIRED_GROUPS` and `AUTH_SSO_ALLOWED_EMAIL_DOMAINS` are how
an org that needs less than its whole directory says so, re-checked every sign-in.

A refused round-trip redirects with `#sso_error=<reason>` over a closed vocabulary the SPA maps to
translated copy in all ten locales, rather than a JSON envelope a browser mid-redirect cannot get
back from. The reasons are separate because the remedies are: a missing directory group is the
user's to take to IT, a failed code exchange is the operator's own configuration, and an IdP that
stopped answering mid-round-trip (`provider_unreachable`) is neither. That last one covers the whole
callback leg, so a provider outage during the exchange redirects with a reason rather than rendering
the operator-facing envelope the LOGIN leg correctly still uses.

Four configuration combinations now REFUSE TO BOOT rather than resolving to a deployment that looks
configured and is not: a partial credential set, a non-https issuer on a non-loopback host, a
session secret too weak to sign what SSO mints, and `AUTH_DEV_OPEN`/`TESTING_NO_AUTH` alongside SSO
(dev-open serves every protected route anonymously, cancelling the access control SSO was configured
to enforce). Parsing and all four refusals live in one shared `resolveSsoConfig` both facades call,
so the runtimes cannot drift on admission policy.

No migration: `user_identities` is already `(provider, subject)` keyed with a metadata blob, so
`IdentityProvider` simply gains `'oidc'` and the column is plain text on both runtimes. Every
existing login path is byte-for-byte unchanged; a deployment that sets none of the new variables
sees no difference. `AuthConfig` gains an optional `sso`, `/auth/config` gains `providers.sso` plus
an `sso: { label, protocol }` presentation object, and the shared browser-login mechanics
(cookie-bound CSRF state, the allow-listed post-login redirect, the session mint) move from
`AuthController` into `modules/auth/loginFlow.ts` so there is one implementation rather than a
third copy — `pickPostLoginRedirect` and `mintSession` are re-exported from the same package entry
point, but their module path changed.

What is NOT here: SAML 2.0, so a classic Shibboleth IdP without the OIDC OP plugin is not yet
served; group-claim → workspace-role mapping, which is blocked on deciding WHICH workspace a
directory group grants a role on; and session revocation, which is what would close the gap between
"disabled in the IdP" and "the bearer they already hold stops working". Each is a costed slice in
`docs/initiatives/enterprise-sso-oidc.md`.
