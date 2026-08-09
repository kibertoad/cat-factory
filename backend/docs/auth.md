# Authentication (SSO / GitHub / Google / password sign-in)

> **Configuring sign-in is on the website**:
> [Set Up Enterprise SSO](https://www.catfactory.ai/deploy/sso.html) owns the OIDC path end to end,
> and [Configuration → Authentication](https://www.catfactory.ai/deploy/configuration.html#authentication)
> owns the three consumer providers. This page is the DESIGN: the legs, what each one verifies, and
> how a session is ended.

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

Registering the OAuth application and every variable a deployment sets are the site's
[Configuration → Authentication](https://www.catfactory.ai/deploy/configuration.html#authentication);
the variables themselves are in [`environment-variables.md`](../../docs/environment-variables.md).
The callback URL is `<worker-origin>/auth/callback` and the Google leg's is
`<worker-origin>/auth/google/callback`, both derived from the request origin unless overridden.

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

Setting SSO up (the application to register, the nine `AUTH_SSO_*` variables, the issuer URL per
provider, and the four combinations that refuse to boot) is the site's
[Set Up Enterprise SSO](https://www.catfactory.ai/deploy/sso.html).

The repo-side halves of that:

- **The four refusals are BOOT-time config validation**, not runtime guards, which is what makes
  them safe to state absolutely: a partial variable set, a non-https issuer on a non-loopback host,
  a weak `AUTH_SESSION_SECRET`, and dev-open alongside SSO each abort the boot with the variable
  named. Adding a fifth belongs there, beside them, and gains a row on that page in the same change.
- **Plain `http` is accepted for loopback** (`localhost`, `127.0.0.0/8`, `::1`) so a Keycloak or Dex
  container on a developer's own machine works. That exemption is the reason the check is written
  against the resolved host rather than against the scheme alone.

### Why SSO is not UI-configurable

The reasoning (it is the deployment's trust root, the bootstrap is circular, and the refusals are
boot-time) is on the site's
[Set Up Enterprise SSO](https://www.catfactory.ai/deploy/sso.html#why-sso-is-configured-in-the-environment-not-in-the-ui).
It binds a change here: if a UI surface is ever wanted, the honest shape is a
**deployment-operator** surface rather than a workspace-admin one, with every boot refusal above
re-expressed as a runtime guard. A per-field permission on the existing workspace-admin surface is
not a smaller version of that; it is the privilege-escalation seam the reasoning rules out.

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

SSO is the one method that **admits by default**, and that is the feature rather than an oversight:
who may sign in is expressed by which people the application is assigned to in the directory, which
is what makes offboarding a directory action. Contrast the GitHub path, which fails closed with both
its lists empty, because there nothing else expresses who is allowed. The two optional narrowings
(`AUTH_SSO_REQUIRED_GROUPS`, then `AUTH_SSO_ALLOWED_EMAIL_DOMAINS`) are on the site's
[Set Up Enterprise SSO](https://www.catfactory.ai/deploy/sso.html#who-is-allowed-in).

Two implementation facts they rest on:

- **The groups reader tolerates every shape providers ship groups in**, because an unread claim
  would refuse the whole org. The configured list is comma-separated, so a group name may contain
  spaces: an array claim's entries are taken whole and only a bare space-separated string is split.
- **A configured domain gate with no email released is REFUSED** (`email_required`) rather than
  admitted. Admitting would silently void a rule the operator wrote.

Group memberships are read on **every** sign-in, and a refusal can end the sessions the person
already holds: which refusals do, and which deliberately do not, is
[Session revocation](#session-revocation) below.

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

Sessions are stateless and bounded by expiry (`AUTH_SESSION_TTL_HOURS`). Removing
a user or org from an allowlist blocks **new** logins immediately; the sessions
they already hold are ended through revocation (below), not by the allowlist edit.

Example (`wrangler.toml [vars]`):

```toml
# GitHub: admit two named users plus every member of two orgs.
AUTH_ALLOWED_LOGINS = "octocat,hubot"
AUTH_ALLOWED_ORGS   = "acme-inc,acme-labs"

# Google/password: let anyone with a company email self-signup.
AUTH_ALLOWED_EMAIL_DOMAINS = "acme.com,acme-labs.com"
```

### Session revocation

A session token is a signed claim, not a row, so there is nothing to delete to end
one. Each `users` row therefore carries a **session generation**: the token is
stamped with the value current at mint time, and verification compares the claim
against the row. Advancing the row invalidates every token minted before it —
one write, nothing to enumerate, and no blocklist table to grow and prune.

Three things advance it:

- **`POST /auth/sessions/revoke-all`** — self-serve "sign out everywhere". The
  caller's current token is invalidated along with the rest (somebody reaching for
  this has usually lost a device and cannot say which session to keep), so the
  response carries a replacement token minted from the new generation.
- **`POST /accounts/:accountId/members/:userId/revoke-sessions`** — admin-forced,
  for offboarding a member or responding to a lost laptop. It withdraws
  authentication only: membership and roles are untouched, because the RBAC gate
  re-reads those on the next request and a role change needs no revocation. It is
  recorded in the account audit log as `account.member_sessions_revoked`.
- **An SSO sign-in the directory now refuses**, and only when the directory is what
  refused it. This is what makes the offboarding promise real: re-reading group
  membership on sign-in only stops a NEW session, and the bearer they already hold
  would otherwise stay valid until it expired. Best-effort and logged, never
  allowed to turn a correct refusal into a 500 (`sessionsRevoked` on the
  `sso.refused` line reports which of the four outcomes occurred).

**A refusal only revokes when it is EVIDENCE of something.** `judgeSsoAdmission`
returns not just which rule refused but what the refusal is evidence of
(`SsoRefusalEvidence`), and the two are not the same question:

- `directory` — a claim the IdP DID release positively excludes them: groups were
  released and none match, or a verified email was released whose domain is not
  allowed. That is the directory saying they no longer belong here, and it revokes.
- `indeterminate` — the claim the rule needed never arrived. A user removed from
  every group, a dropped `groups` scope, a renamed `groupsClaim` and a provider
  that stopped marking `email` verified all produce exactly this, and nothing can
  tell them apart. The login is still refused (fail closed is unchanged); the
  revocation is withheld.

The distinction is not fastidiousness: acting on the second as if it were the first
turns a configuration regression into a deployment-wide forced sign-out. On the
release where a scope goes missing, every returning employee is refused, and
revoking on each of those refusals would cut every live session in the deployment,
the admin who has to fix the configuration included.

The check costs one read per authenticated request, served through the
`userSessionGeneration` app cache: a 60-second TTL on Node/local with invalidation
on every bump, and pass-through on the Worker, whose isolates share no
invalidation bus (a cached entry there would go on admitting a bearer a peer
isolate had already revoked). In mothership mode a node resolves it from the
mothership over the persistence RPC, so revoking a user centrally also stops their
laptop honouring the session it minted for them.

**A MINT reads past that cache** (`UserService.refreshSessionGeneration`, which
every login path reaches through `sessionGenerationFor`), and this is the one place
the bounded stale window is not acceptable. Verification gates a single request and
the next one re-asks; a mint stamps the value into a bearer that outlives the cache
entry, so a generation read one bump behind on a replica that missed the
invalidation issues a token every replica refuses for a full TTL — and the refusal
SPREADS rather than heals, as the caches that still agreed with it expire. The
refresh also repopulates the reading replica, so the token it just minted verifies
there rather than being refused by its own issuer.

Three refusals are deliberate, and each closes a hole the obvious implementation
leaves open. A token carrying **no generation claim** is refused rather than
treated as current, so sessions minted before this shipped stop working (everyone
signs in once more) instead of leaving a permanent bypass. A generation **above**
the stored value is refused too, not only a stale one, so a restored-from-backup
database cannot re-admit sessions it had already revoked. And a user the store has
**no row for** is refused, which is what ends a deleted user's unexpired bearer.

Two boundaries worth knowing: a WebSocket **ticket** already minted stays valid for
its own short TTL, and machine tokens are a separate audience revoked through their
own roster (`POST /auth/machine-nodes/:nodeId/revoke`).

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
