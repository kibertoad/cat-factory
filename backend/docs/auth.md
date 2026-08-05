# Authentication (SSO / GitHub / Google / password sign-in)

cat-factory gates the API behind a sign-in. For an organisation the primary
method is **enterprise SSO**: one generic OpenID Connect adapter pointed at the
deployment's own identity provider (Okta, Microsoft Entra ID, Auth0, Keycloak,
PingFederate, OneLogin, JumpCloud, Google Workspace, a Shibboleth IdP running the
OIDC OP plugin). Three consumer methods sit alongside it: **GitHub OAuth**
(historically the primary one, since the App integration operates on real repos),
**Google OAuth** and **email/password**. All four resolve to one canonical
`users` row, so a person keeps the same internal identity (`usr_*`) however they
signed in.

This is **user authentication** (who is signing in), which is distinct from the
**GitHub App integration** (how a workspace acts on repos). They use different
credentials: the App integration uses a GitHub App + installation tokens; GitHub
login uses the GitHub **OAuth web flow**. It is also distinct from
**machine-to-machine authentication**: an external system calls the
key-authenticated `/api/v1` surface with a workspace-scoped public-API key, not
a user session; see [`public-api.md`](./public-api.md).

---

## Flow

The GitHub OAuth round-trip is shown below. Google OAuth is analogous
(`/auth/google/login` → `/auth/google/callback`). Email/password skips the
browser redirect entirely: the SPA posts credentials to `/auth/signup` or
`/auth/password-login` and gets the session token back in the JSON response.

```
 SPA ──/auth/login──▶ Worker ──302──▶ github.com/login/oauth/authorize
                                              │ user approves
 SPA ◀──302 #token=…── Worker ◀──/auth/callback?code&state── github.com
   │
   └── stores token, sends `Authorization: Bearer <token>` on every API call
```

1. **`GET /auth/login`**: the Worker signs a short-lived `state` nonce (HMAC,
   CSRF protection) that also carries where to land the browser afterwards, then
   redirects to GitHub's authorize page.
2. **`GET /auth/callback`**: verifies `state`, exchanges `code` for a GitHub
   user token, reads the user, enforces the [sign-in allowlist](#access-control)
   (named users and/or org members), then mints a signed **session token** and
   redirects to the SPA with the token in the URL **fragment** (`#token=…`, kept
   out of server logs / `Referer`).
3. The SPA pulls the token out of the fragment, persists it, and replays it as a
   bearer header. **`GET /auth/me`** validates a stored token on boot.

Sessions are **stateless**: the token is `base64url(JSON).base64url(HMAC)` with
an absolute expiry, verified per request (see `infrastructure/auth/signing.ts`).
There is no server-side session store: logout is a client-side token drop, and
expiry bounds the blast radius. (User-session revocation remains a possible
follow-up, and it is NOT free, because nothing on this path reads the user row:
see [`audit-log-and-session-revocation.md`](../../docs/initiatives/audit-log-and-session-revocation.md).
MACHINE tokens are revocable, below.)

**Enterprise SSO is the org-shaped path**, and it is what lets a deployment sit
behind its own directory's MFA, conditional access and offboarding rather than
asking an operator to maintain a list of named users. See
[Enterprise SSO](#enterprise-sso-generic-oidc) below. What is NOT yet covered is
a SAML-2.0-only provider (a classic Shibboleth IdP without the OIDC OP plugin,
or an org that has standardised on SAML): tracked, with its cost, in
[`enterprise-sso-oidc.md`](../../docs/initiatives/enterprise-sso-oidc.md).

**Machine tokens are revocable.** Every `POST /auth/machine-token` mint is
recorded on the machine-node roster (`machine_nodes`), and the shared machine
gate (`verifyMachineRequest`) consults its revocation tombstone on every
`/internal/*` call, so a leaked node token dies everywhere at once instead of
running out its 30-day TTL. The owner lists their nodes at
`GET /auth/machine-nodes` and kills one with
`POST /auth/machine-nodes/:nodeId/revoke`; a revoked node id can never be
re-minted (reconnecting mints a fresh one).

**The password endpoints are throttled durably.** Signup / login / forgot /
reset attempts land in the cross-replica `auth_attempts` ledger: a per-`ip:email`
burst cap plus a per-IP aggregate that catches one-password-many-emails
stuffing. The old in-process window remains only as the backstop when the store
errors, and a trip is counted (`auth.throttle.limited`) as well as logged, since
only a rate distinguishes one forgetful user from a stuffing sweep.

Which header carries the client address is a per-FACADE decision, resolved by
`ServerContainer.resolveClientAddress` rather than by shared throttle code. Node
reads the socket peer, and `x-forwarded-for` only when `AUTH_TRUST_PROXY=true`
(with `AUTH_TRUST_PROXY_HOPS` naming the chain depth, rightmost-first); it never
reads `cf-connecting-ip`, because nginx / Caddy / ALB rewrite `x-forwarded-for`
and forward every other header untouched, so trusting a Cloudflare-specific
header behind a generic proxy would leave the identity client-chosen. The Worker
reads `cf-connecting-ip` alone, which is authentic there because the edge injects
and overwrites it. Addresses are normalised before keying: a port is stripped,
anything not IP-shaped is refused, and IPv6 is bucketed to its /64 so a routine
allocation is not 2^64 fresh buckets.

The session token is carried as a bearer header rather than a cookie so the
cross-origin SPA → Worker calls work without `SameSite=None` cookies or
credentialed CORS.

---

## Configuration

A login provider **activates** only when its own credentials _and_ a sufficiently
strong session secret are present (GitHub needs its OAuth client id/secret, Google
its own client id/secret, password its `AUTH_PASSWORD_ENABLED=true` flag). Auth as
a whole counts as enabled when **any** provider is configured. But the gate **fails
closed**: every route except a small
public allowlist (`/health`, `/auth/*`, the `/v1` container proxy, and `/github`
webhooks) requires a valid session, and when auth is unconfigured those routes
return `503 auth_not_configured` rather than serving data openly. **Production is
therefore always authenticated**: an unconfigured deployment is locked, not open.

### Running without configured auth: `AUTH_DEV_OPEN` vs `TESTING_NO_AUTH`

There are **two** opt-out hatches, and they operate at **different layers**. Both are
honoured **only outside a production-like `ENVIRONMENT`** (`production` / `prod` /
`staging`), so a flag that leaks into a real deployment can't re-open it; both belong in
`.dev.vars` (gitignored, for `wrangler dev`) / the vitest bindings / a non-prod `.env`,
**never** in a deployed `wrangler.toml`. The distinction is what each one opts out of:

| Hatch             | Opens the **API gate**? (anonymous requests pass instead of 503) | Tells the **SPA** to render anonymously? (skip the login screen) |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AUTH_DEV_OPEN`   | **Yes**                                                          | **No**                                                           |
| `TESTING_NO_AUTH` | **Yes** (it implies dev-open)                                    | **Yes**                                                          |

- **`AUTH_DEV_OPEN=true`** opens only the **server** side: protected routes stop returning
  `503 auth_not_configured` and serve anonymously. It is the escape hatch for **backend**
  development and the API/integration test suites, and it is what **local mode** runs on by
  default (so unauthenticated reads work while a developer signs in with a PAT/password to
  get a per-user identity). It deliberately does **NOT** change the SPA: a remote facade has
  **no anonymous tier**, so the SPA still routes to the **login screen** when the auth
  handshake resolves with no user: a dev-open-but-unconfigured remote is a misconfiguration
  to surface, not an invitation to use the board anonymously.

- **`TESTING_NO_AUTH=true`** is the stronger, narrowly-scoped hatch for running the **whole
  product with no authentication at all**. It implies `AUTH_DEV_OPEN` (so the API gate is
  open) **and** is advertised to the SPA via `GET /auth/config` (`testingNoAuth: true`), so
  the SPA renders the **board anonymously** instead of gating to login. This is what the
  **end-to-end (Playwright) suite** opts into: the assembled product needs to boot straight
  to the board with the external auth providers left off. Outside that test harness there is
  no reason to set it.

Rule of thumb: reach for `AUTH_DEV_OPEN` when you only need the **API** open; reach for
`TESTING_NO_AUTH` when you need the **SPA** to skip sign-in too (i.e. an end-to-end test of
the assembled product). Neither runs in production.

Register an OAuth app (a GitHub App's OAuth credentials work, or a classic OAuth
App) with the callback URL `<worker-origin>/auth/callback`, then:

```
# wrangler.toml [vars]
GITHUB_OAUTH_CLIENT_ID = "Iv1.abc123…"

# secrets
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler secret put AUTH_SESSION_SECRET     # any high-entropy random string
```

Optional vars:

| Var                         | Purpose                                                                                                            | Default                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `AUTH_SUCCESS_REDIRECT_URL` | Fixed SPA landing URL after login (recommended in production)                                                      | request-provided          |
| `AUTH_CALLBACK_URL`         | Override `redirect_uri` when the public URL differs from origin                                                    | `<origin>/auth/callback`  |
| `AUTH_SESSION_TTL_HOURS`    | Session lifetime in hours                                                                                          | `168` (7 days)            |
| `AUTH_ALLOWED_LOGINS`       | Comma-separated GitHub logins permitted to sign in                                                                 | none (see access control) |
| `AUTH_ALLOWED_ORGS`         | Comma-separated GitHub orgs whose members may sign in                                                              | none (see access control) |
| `GITHUB_OAUTH_BASE`         | OAuth host (set for GitHub Enterprise)                                                                             | `https://github.com`      |
| `AUTH_DEV_OPEN`             | Local/test ONLY: `true` runs the API open while unconfigured                                                       | unset (prod fails closed) |
| `TESTING_NO_AUTH`           | Test ONLY: stronger `AUTH_DEV_OPEN` (open API + the SPA renders anonymously, no login gate). Used by the e2e suite | unset (prod refuses it)   |

> **Production note:** set `AUTH_SUCCESS_REDIRECT_URL` to your SPA's URL. Without
> it the post-login landing comes from the request's `redirect` query (dev
> convenience), which is an open-redirect surface.

### Additional login providers

GitHub is not the only sign-in. Two more providers activate when configured, each
sharing the same `AUTH_SESSION_SECRET`:

| Var                          | Purpose                                                                | Default                         |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`     | Enables "Login with Google" (with the secret below)                    | unset (Google off)              |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret                                             | unset                           |
| `GOOGLE_OAUTH_REDIRECT_URL`  | Override `redirect_uri` for Google                                     | `<origin>/auth/google/callback` |
| `AUTH_PASSWORD_ENABLED`      | `true` enables email/password signup + login                           | unset (password off)            |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Comma-separated email domains allowed to self-signup (Google/password) | none (invite-only)              |

`/auth/config` reports which providers are live (`providers.github` /
`providers.password` / `providers.google` / `providers.sso`) so the SPA shows only
the controls it can serve. When SSO is configured it also carries
`sso: { label, protocol }`, the operator's own button wording.

---

## Enterprise SSO (generic OIDC)

Sign-in through the deployment's OWN identity provider. **One generic adapter, not
per-vendor integrations**: Okta, Entra ID, Auth0, Keycloak, PingFederate, OneLogin,
JumpCloud, Google Workspace and a Shibboleth IdP with the OIDC OP plugin are all
OpenID Connect providers, so a discovery document plus a client id/secret is the
entire configuration for any of them. A provider not named here works too, as long
as it publishes a discovery document: there is no per-vendor list to be on.

```
 SPA ──/auth/sso/login──▶ backend ──302──▶ <issuer>/authorize?…PKCE S256
                                                  │ the IdP authenticates the user
 SPA ◀──302 #token=…── backend ◀──/auth/sso/callback?code&state── the IdP
```

What each leg does:

1. **`GET /auth/sso/login`** resolves the provider's
   `/.well-known/openid-configuration` (cached through the app cache seam), mints a
   PKCE pair plus an OIDC `nonce`, signs the whole round-trip into ONE **httpOnly**
   cookie, and redirects with only an opaque nonce in the `state` parameter.
2. **`GET /auth/sso/callback`** verifies the cookie against `state`, exchanges the
   code (PKCE verifier + client secret), verifies the ID token against the
   provider's JWKS, applies admission, resolves the canonical user, and hands the
   SPA the SAME session token every other login mints.

### What differs from the OAuth legs, and why

- **The round-trip state lives in the cookie, not the URL.** PKCE's
  `code_verifier` and OIDC's `nonce` are secrets; a verifier travelling beside the
  code it protects protects nothing. A side effect worth having: the post-login
  redirect target cannot be tampered with in the URL at all.
- **A refusal REDIRECTS with `#sso_error=<reason>`**, not a JSON envelope: a
  browser mid-redirect that lands on raw JSON has no way back. The reason vocabulary
  is closed (`@cat-factory/contracts`' `SSO_ERROR_REASONS`) and the SPA maps each
  member to translated copy, because the remedies genuinely differ: a missing
  directory group is the user's to take to IT, a failed code exchange is the
  operator's own configuration.
- **The identity subject is `<discovered issuer>#<sub>`**, never the email. A `sub`
  is unique per issuer only, and emails are reassigned inside orgs, so keying on
  either alone eventually hands one person another's account.
- **ID tokens verify against ASYMMETRIC algorithms only.** That is what refuses both
  `alg: none` and an `HS256` token forged with the deployment's own client secret.
- **A rotated signing key costs ONE refetch.** An unknown `kid` invalidates the
  cached provider and refetches (rate-limited), rather than failing every login
  until a TTL lapses. Once that one refetch is spent, or its rate limit refuses it,
  the token is simply unverifiable and the leg refuses with `token_invalid`:
  `verifyIdToken` never lets the underlying library's own key-lookup error out, or
  the callback's refusal path would render a 500 envelope at a browser mid-redirect.
- **Userinfo is merged only when it describes the SAME subject** the verified ID
  token did (OIDC Core 5.3.2). Overlaying the token's claims last already keeps `sub`
  authoritative, but `email` and `groups` ride the same response and both decide
  admission, so another subject's response would satisfy a group gate with somebody
  else's membership. A mismatch is dropped with a `warn`, never silently.
- **The round-trip cookie has its OWN token audience** (`sso-state`), not the OAuth
  legs' `oauth-state`. Both are one login's CSRF state, but the OAuth value travels in
  the URL, so any user holds a validly-signed one; this one is the httpOnly carrier of
  the PKCE verifier and the OIDC nonce. Its shape is checked after the signature too,
  because a payload missing those two secrets would flow on as `undefined` and take
  the nonce comparison with it.

### Configuration

Register a **web / confidential** application with your provider, with the
redirect URI `<backend-origin>/auth/sso/callback`, then:

| Var                              | Purpose                                                                               | Default                      |
| -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `AUTH_SSO_ISSUER_URL`            | The provider's issuer URL. The `/.well-known/openid-configuration` suffix is optional | unset (SSO off)              |
| `AUTH_SSO_CLIENT_ID`             | The application's client id                                                           | unset                        |
| `AUTH_SSO_CLIENT_SECRET`         | The application's client secret                                                       | unset                        |
| `AUTH_SSO_LABEL`                 | Sign-in button label, e.g. `Acme SSO`                                                 | `Single sign-on`             |
| `AUTH_SSO_SCOPES`                | Space-separated scopes (`openid` is added when absent)                                | `openid profile email`       |
| `AUTH_SSO_REDIRECT_URL`          | Override `redirect_uri` when the public URL differs from the request origin           | `<origin>/auth/sso/callback` |
| `AUTH_SSO_ALLOWED_EMAIL_DOMAINS` | Optional narrowing: only these verified email domains may sign in                     | none (the IdP is the gate)   |
| `AUTH_SSO_GROUPS_CLAIM`          | The claim carrying group memberships                                                  | `groups`                     |
| `AUTH_SSO_REQUIRED_GROUPS`       | Optional narrowing: the user must be in at least one of these groups                  | none                         |

Issuer URLs by provider, for reference: Okta
`https://<org>.okta.com/oauth2/default`; Entra ID
`https://login.microsoftonline.com/<tenant-id>/v2.0`; Auth0
`https://<tenant>.eu.auth0.com`; Keycloak `https://<host>/realms/<realm>`; Google
Workspace `https://accounts.google.com`; a Shibboleth IdP with the OIDC OP plugin
`https://<idp-host>` (the plugin serves its
`/.well-known/openid-configuration`).

**Four combinations refuse to boot** rather than resolving to a deployment that
looks configured and is not. Each lands on the misconfiguration screen naming the
variable and its remedy:

1. **Partially configured** — any of the three required variables set without the
   others. Disabling quietly would leave an operator who believes SSO is live on the
   consumer logins they adopted SSO to replace.
2. **A non-https issuer** on a non-loopback host (the code and ID token would cross
   the network in clear). Plain `http` is accepted for `localhost` / `127.0.0.0/8` /
   `::1`, so a Keycloak or Dex container on a developer's own machine works.
3. **A weak `AUTH_SESSION_SECRET`.** SSO decides _who_ signs in; the session it
   mints is the same HMAC bearer, so a brute-forceable secret makes the IdP's
   guarantees irrelevant.
4. **`AUTH_DEV_OPEN` (or `TESTING_NO_AUTH`) alongside SSO.** Dev-open serves every
   protected route anonymously. A deployment that configured SSO to satisfy a
   security review must not have a variable combination that opens the API, and an
   operator cannot be relied on to notice they set both, so the pair is refused
   rather than one silently winning.

### Why SSO is configured by ENVIRONMENT, not in the UI

Every other integration this product talks to (trackers, document sources, model
providers, runner pools, email senders) is onboarded in the UI and stored sealed in
the database, per account. SSO deliberately is not, for three reasons:

- **It is the deployment's trust root, not tenant configuration.** Whoever can edit
  the SSO provider can point it at an IdP they control and then sign in as anybody.
  A UI-editable identity provider turns "workspace admin" into a path to every
  account on the deployment, a privilege-escalation seam no per-field permission
  really closes.
- **The bootstrap is circular.** SSO gates who reaches the UI at all, so configuring
  it from inside the UI needs a second, already-working login to exist first, which
  is precisely the consumer login an org adopting SSO wants gone.
- **The refusals above are BOOT-time.** "SSO and dev-open cannot both be on" and
  "the session secret must be strong enough to sign what SSO mints" belong where the
  process starts, not on a form submission that could leave a running deployment in
  the refused state.

The trade is real: rotating a client secret means a config change and a restart
rather than a form. If a UI surface is wanted later, the honest shape is a
**deployment-operator** surface (not a workspace-admin one) with the boot refusals
re-expressed as runtime guards; it is a separate slice, recorded in the initiative
tracker.

---

## Access control

Authentication answers _who is signing in_; **access control** answers _who is
allowed_. Once login is enabled the deployment is **private and fails closed**.

Gating is **per login method**, and the allowlists are not interchangeable. The
GitHub login/org allowlists govern GitHub sign-in only; the `AUTH_ALLOWED_*`
email-domain allowlist governs Google and password self-signup only; the SSO
narrowings govern SSO only. There is no single setting that applies to every
provider at once, and the criteria do not combine across methods (no "must be in
org X _and_ have a @company.com email" mode).

| Login method   | Gated on…                                                      | By                                | When                 |
| -------------- | -------------------------------------------------------------- | --------------------------------- | -------------------- |
| Enterprise SSO | the IdP's own app assignment, plus the optional SSO narrowings | directory group / verified domain | every sign-in        |
| GitHub OAuth   | `AUTH_ALLOWED_LOGINS` OR `AUTH_ALLOWED_ORGS`                   | GitHub login or org membership    | every sign-in        |
| Google OAuth   | `AUTH_ALLOWED_EMAIL_DOMAINS`                                   | the verified email's domain       | new-user signup only |
| Email/password | `AUTH_ALLOWED_EMAIL_DOMAINS`                                   | the email's domain                | new-user signup only |

A matching **invitation** (see below) admits a user under any method, bypassing
that method's allowlist. Anyone who matches neither an allowlist nor an invite
gets `403 forbidden`, so they reach neither the API (BE) nor, with no session
minted, the SPA (FE) past its login gate.

### SSO: the directory is the allowlist

SSO is the one method that **admits by default**, and that is the feature rather
than an oversight. With SSO configured, who may sign in is expressed by which
people the application is assigned to in the directory: that is what makes
onboarding and — the one that matters — **offboarding** a directory action instead
of an edit to a list here. Contrast the GitHub path, which fails closed with both
its lists empty, because there nothing else expresses who is allowed.

Two optional narrowings exist for orgs whose IdP serves more than the population
that should reach this deployment, checked in that order:

1. **`AUTH_SSO_REQUIRED_GROUPS`** — the user must be in at least one named
   directory group (read from `AUTH_SSO_GROUPS_CLAIM`; the reader tolerates every
   shape providers ship groups in, since an unread claim would refuse the whole org).
   The list is comma-separated, so **a group name may contain spaces**
   (`Domain Admins,Platform Engineering`): an array claim's entries are taken whole,
   and only a bare space-separated string value is split.
2. **`AUTH_SSO_ALLOWED_EMAIL_DOMAINS`** — their **verified** email's domain must be
   listed. A configured domain gate with no email released is **refused**
   (`email_required`), not admitted: admitting would silently void a rule the
   operator wrote, and releasing the claim is their fix.

Group memberships are read on **every** sign-in, so removing someone from a group
blocks their next login. As with every other method, a session already minted lapses
at its own expiry rather than being revoked (see the session-revocation note above),
which is the gap between "disabled in the IdP" and "locked out here".

### GitHub: login + org allowlists

`AUTH_ALLOWED_LOGINS` and `AUTH_ALLOWED_ORGS` combine with **OR**: being on either
admits the user. The check (`isGitHubSignInAllowed`) runs on **every** GitHub
sign-in, new or returning, in `/auth/callback`.

> ⚠️ **Both empty ⇒ nobody can sign in with GitHub.** This is deliberate (fail
> closed): an enabled-but-unconfigured allowlist locks the deployment rather than
> admitting the whole world. **You must set at least one of the two** (or rely on
> invitations) before anyone can log in with GitHub.

### Google + password: email-domain allowlist

`AUTH_ALLOWED_EMAIL_DOMAINS` gates **new-user creation only** (Google self-signup
and the `/auth/signup` endpoint). A user whose email domain is listed may create an
account; for Google the email must be **verified** by Google (an unverified Google
email is never trusted to self-signup). Once the account exists, returning logins
are governed by the credential itself (the Google identity, or the stored password),
not re-checked against the domain list. The GitHub login/org allowlists are **not**
consulted on these paths.

> ⚠️ **Empty `AUTH_ALLOWED_EMAIL_DOMAINS` ⇒ Google/password signup is invite-only**
> (fail closed). Existing accounts can still log in; only the creation of new
> accounts is blocked without a matching invite.

### Invitations

An invitation is addressed to a specific email and admits that user under any login
method, short-circuiting the allowlist for that method. Because the invite is bound
to its email, a leaked link cannot admit an arbitrary GitHub account or register an
arbitrary address. The GitHub path additionally requires the invited email to match
the GitHub account's email; Google requires the **verified** email to match.
Invitations are issued through the account/team UI (see the invitations flow), not
an env var.

### Scopes and session lifetime

**Org membership** is read live from GitHub during callback via `GET /user/orgs`.
That endpoint only returns a user's private org memberships when the token holds
the `read:org` scope, so the login flow requests `read:user read:org` whenever
`AUTH_ALLOWED_ORGS` is non-empty (and plain `read:user` otherwise, for least
privilege). For a GitHub App, ensure the app is permitted that scope; a classic
OAuth App needs no pre-registration of scopes.

Sessions are stateless and bounded by expiry (`AUTH_SESSION_TTL_HOURS`), so
removing a user or org from an allowlist blocks **new** logins immediately but
does not revoke a session already minted; it lapses at its own expiry.

Example (`wrangler.toml [vars]`):

```toml
# GitHub: admit two named users plus every member of two orgs.
AUTH_ALLOWED_LOGINS = "octocat,hubot"
AUTH_ALLOWED_ORGS   = "acme-inc,acme-labs"

# Google/password: let anyone with a company email self-signup.
AUTH_ALLOWED_EMAIL_DOMAINS = "acme.com,acme-labs.com"
```

---

## Frontend

- `stores/auth.ts` owns the token (persisted), the user, and whether auth is
  `required`. `bootstrap()` captures any `#token=…`, reads `/auth/config`, and
  validates the token via `/auth/me`.
- `components/auth/AuthGate.vue` wraps `<NuxtPage>`: it renders the board only
  when auth is off or a user is signed in, otherwise the `LoginScreen`. The
  board's own bootstrap therefore only runs once the user is allowed in.
- `composables/useApi.ts` attaches the bearer token to every request and clears
  the session on a `401`.
