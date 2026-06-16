# Authentication ("Login with GitHub")

cat-factory gates the API behind a GitHub sign-in. Because the product already
relies on GitHub (the App integration operates on real repos), GitHub accounts
are the natural identity provider — no separate user store, password reset, or
email verification to build.

This is **user authentication** (who is signing in), which is distinct from the
**GitHub App integration** (how a workspace acts on repos). They use different
credentials: the App integration uses a GitHub App + installation tokens; login
uses the GitHub **OAuth web flow**.

---

## Flow

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

The login flow **activates** only when the OAuth credentials _and_ a session
secret are present. But the gate **fails closed**: every route except a small
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

---

## Access control

Authentication answers _who is signing in_; **access control** answers _who is
allowed_. Once login is enabled the deployment is **private and fails closed**: a
user may obtain a session only if they are on at least one allowlist.

| Allowlist             | A user passes when…                                      |
| --------------------- | -------------------------------------------------------- |
| `AUTH_ALLOWED_LOGINS` | their GitHub login is listed (comma-separated, any case) |
| `AUTH_ALLOWED_ORGS`   | they are a member of any listed GitHub organization      |

The two lists combine with **OR** — being on either admits the user. The check
runs in `/auth/callback`; anyone who matches neither gets `403 forbidden`, so
they reach neither the API (BE) nor, with no session minted, the SPA (FE) past
its login gate.

> ⚠️ **Both empty ⇒ nobody can sign in.** This is deliberate (fail closed): an
> enabled-but-unconfigured allowlist locks the deployment rather than admitting
> the whole world. **You must set at least one of the two** before anyone —
> including you — can log in.

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
# Admit two named users plus every member of two orgs:
AUTH_ALLOWED_LOGINS = "octocat,hubot"
AUTH_ALLOWED_ORGS   = "acme-inc,acme-labs"
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
