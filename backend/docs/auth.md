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
   user token, reads the user, optionally checks the allowlist, then mints a
   signed **session token** and redirects to the SPA with the token in the URL
   **fragment** (`#token=…`, kept out of server logs / `Referer`).
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

Auth is **opt-in**, mirroring the agents / GitHub-integration feature gates: it
activates only when the OAuth credentials _and_ a session secret are present.
When unset, the API is open (local dev, the test suite) and the SPA renders
without a login screen.

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

| Var                         | Purpose                                                         | Default                  |
| --------------------------- | --------------------------------------------------------------- | ------------------------ |
| `AUTH_SUCCESS_REDIRECT_URL` | Fixed SPA landing URL after login (recommended in production)   | request-provided         |
| `AUTH_CALLBACK_URL`         | Override `redirect_uri` when the public URL differs from origin | `<origin>/auth/callback` |
| `AUTH_SESSION_TTL_HOURS`    | Session lifetime in hours                                       | `168` (7 days)           |
| `AUTH_ALLOWED_LOGINS`       | Comma-separated GitHub logins permitted to sign in              | any user                 |
| `GITHUB_OAUTH_BASE`         | OAuth host (set for GitHub Enterprise)                          | `https://github.com`     |

> **Production note:** set `AUTH_SUCCESS_REDIRECT_URL` to your SPA's URL. Without
> it the post-login landing comes from the request's `redirect` query (dev
> convenience), which is an open-redirect surface. Combine with
> `AUTH_ALLOWED_LOGINS` to keep a deployment private.

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
