# Authentication (GitHub / Google / password sign-in)

cat-factory gates the API behind a sign-in. GitHub is the primary identity
provider (the product already relies on GitHub, since the App integration
operates on real repos), and two more login methods are offered when configured:
**Google OAuth** and **email/password**. All three resolve to one canonical
`users` row, so a person keeps the same internal identity (`usr_*`) however they
signed in.

This is **user authentication** (who is signing in), which is distinct from the
**GitHub App integration** (how a workspace acts on repos). They use different
credentials: the App integration uses a GitHub App + installation tokens; GitHub
login uses the GitHub **OAuth web flow**.

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

1. **`GET /auth/login`** — the Worker signs a short-lived `state` nonce (HMAC,
   CSRF protection) that also carries where to land the browser afterwards, then
   redirects to GitHub's authorize page.
2. **`GET /auth/callback`** — verifies `state`, exchanges `code` for a GitHub
   user token, reads the user, enforces the [sign-in allowlist](#access-control)
   (named users and/or org members), then mints a signed **session token** and
   redirects to the SPA with the token in the URL **fragment** (`#token=…`, kept
   out of server logs / `Referer`).
3. The SPA pulls the token out of the fragment, persists it, and replays it as a
   bearer header. **`GET /auth/me`** validates a stored token on boot.

Sessions are **stateless**: the token is `base64url(JSON).base64url(HMAC)` with
an absolute expiry, verified per request (see `infrastructure/auth/signing.ts`).
There is no server-side session store — logout is a client-side token drop, and
expiry bounds the blast radius. (Revocation lists are a possible follow-up.)

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
therefore always authenticated** — an unconfigured deployment is locked, not open.

The only way to run open is the explicit local-dev/test escape hatch
`AUTH_DEV_OPEN=true`. It lives in `.dev.vars` (gitignored, for `wrangler dev`)
and the vitest bindings, and must **never** be set in the deployed
`wrangler.toml` — doing so would re-open production.

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

| Var                         | Purpose                                                         | Default                   |
| --------------------------- | --------------------------------------------------------------- | ------------------------- |
| `AUTH_SUCCESS_REDIRECT_URL` | Fixed SPA landing URL after login (recommended in production)   | request-provided          |
| `AUTH_CALLBACK_URL`         | Override `redirect_uri` when the public URL differs from origin | `<origin>/auth/callback`  |
| `AUTH_SESSION_TTL_HOURS`    | Session lifetime in hours                                       | `168` (7 days)            |
| `AUTH_ALLOWED_LOGINS`       | Comma-separated GitHub logins permitted to sign in              | none (see access control) |
| `AUTH_ALLOWED_ORGS`         | Comma-separated GitHub orgs whose members may sign in           | none (see access control) |
| `GITHUB_OAUTH_BASE`         | OAuth host (set for GitHub Enterprise)                          | `https://github.com`      |
| `AUTH_DEV_OPEN`             | Local/test ONLY: `true` runs the API open while unconfigured    | unset (prod fails closed) |

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
`providers.password` / `providers.google`) so the SPA shows only the controls it
can serve.

---

## Access control

Authentication answers _who is signing in_; **access control** answers _who is
allowed_. Once login is enabled the deployment is **private and fails closed**.

Gating is **per login method**, and the three allowlists are not interchangeable.
The GitHub login/org allowlists govern GitHub sign-in only; the email-domain
allowlist governs Google and password self-signup only. There is no single setting
that applies to all three providers at once, and the criteria do not combine across
methods (no "must be in org X _and_ have a @company.com email" mode).

| Login method   | Gated on…                                    | By                             | When                 |
| -------------- | -------------------------------------------- | ------------------------------ | -------------------- |
| GitHub OAuth   | `AUTH_ALLOWED_LOGINS` OR `AUTH_ALLOWED_ORGS` | GitHub login or org membership | every sign-in        |
| Google OAuth   | `AUTH_ALLOWED_EMAIL_DOMAINS`                 | the verified email's domain    | new-user signup only |
| Email/password | `AUTH_ALLOWED_EMAIL_DOMAINS`                 | the email's domain             | new-user signup only |

A matching **invitation** (see below) admits a user under any method, bypassing
that method's allowlist. Anyone who matches neither an allowlist nor an invite
gets `403 forbidden`, so they reach neither the API (BE) nor, with no session
minted, the SPA (FE) past its login gate.

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
`AUTH_ALLOWED_ORGS` is non-empty (and plain `read:user` otherwise — least
privilege). For a GitHub App, ensure the app is permitted that scope; a classic
OAuth App needs no pre-registration of scopes.

Sessions are stateless and bounded by expiry (`AUTH_SESSION_TTL_HOURS`), so
removing a user or org from an allowlist blocks **new** logins immediately but
does not revoke a session already minted — it lapses at its own expiry.

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
