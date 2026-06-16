# GitHub Integration — Operations Runbook

How to create the GitHub App, configure the worker, and troubleshoot. For the
design see [github-integration.md](./github-integration.md) and
[adr/0001-github-app-integration.md](./adr/0001-github-app-integration.md).

---

## 0. Self-hosting: one App per instance

cat-factory is self-hosted, so **each deployment registers its own GitHub App.**
An App's webhook and setup URLs point at a single host, so there is no shared or
central App — every instance creates one pointing at its own worker host.

- **Personal accounts and orgs both work.** Create the App under either a personal
  account or an org (Settings → Developer settings → GitHub Apps); it installs on
  whichever account owns the repos. Nothing in cat-factory requires an org — the
  flow only binds an installation to a workspace.
- The App can stay **private**. Create it under your own account/org and install it
  on your own repos — the owner can always install a private App. You do **not** need
  to make it public or list it on the GitHub Marketplace; that's only required if you
  want accounts you don't own to install your instance's App.
- It's the **same App definition** every time (the permissions and events below);
  only the per-instance values differ: the App name (must be unique across GitHub),
  the webhook/setup URLs (your host), and the generated webhook secret and key.
- The multi-tenant design (one installation per workspace, per-installation tokens)
  still applies _within_ your instance — many workspaces, each bound to its own
  installation under your account/org.

**Fast path — App Manifest.** Instead of hand-filling step 1, open
[`github-app-manifest.html`](./github-app-manifest.html) in a browser, enter your
worker host (and an org, or leave it blank for a personal account), and submit. It
posts [`github-app-manifest.json`](./github-app-manifest.json)
to GitHub's App-creation flow with every permission, event and URL pre-filled, so
you only confirm. Then continue from **step 2** (key conversion) — you'll still
generate the private key and set the worker secrets yourself. Prefer the manual
walkthrough below if you'd rather click through each field.

---

## 1. Create the GitHub App

Create an App at **Settings → Developer settings → GitHub Apps → New GitHub App**
— under a personal account or an org; both work. (For an org installation, create
it from the org's developer settings.)

**Webhook**

- Active: ✅
- Webhook URL: `https://<your-worker-host>/github/webhooks`
- Webhook secret: generate a strong random string — this is `GITHUB_WEBHOOK_SECRET`.

**Callback / Setup**

- Setup URL: `https://<your-worker-host>/github/setup/callback`
- "Redirect on update": ✅ (so re-installs hit the callback too)

**Repository permissions** (minimum for current features)

- Contents: **Read & write** (branches, commits via Git Data API)
- Pull requests: **Read & write**
- Issues: **Read & write**
- Checks: **Read-only** (CI gating)
- Metadata: **Read-only** (mandatory)
- Commit statuses: **Read-only** (optional, alongside checks)

**Subscribe to events**

- `Push`, `Pull request`, `Issues`, `Check run`
- (Installation lifecycle events are delivered automatically.)

After creating: note the **App ID** and **App slug** (the URL name), and generate a
**private key** (downloads a `.pem`).

---

## 2. Convert the private key to PKCS#8

GitHub issues a **PKCS#1** key (`-----BEGIN RSA PRIVATE KEY-----`). Web Crypto needs
**PKCS#8** (`-----BEGIN PRIVATE KEY-----`). Convert once:

```bash
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pk8.pem
```

The worker rejects a PKCS#1 key at import time with a message pointing here.

---

## 3. Configure the worker

Non-secret config in `wrangler.toml` `[vars]`:

```toml
GITHUB_APP_ID = "123456"
GITHUB_APP_SLUG = "cat-factory-yourorg"
GITHUB_API_BASE = "https://api.github.com"          # or your GHES base
# GITHUB_SETUP_REDIRECT_URL = "https://app.example.com/settings/github"
```

Secrets via Wrangler (never commit these):

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY    # paste the full PKCS#8 PEM
wrangler secret put GITHUB_WEBHOOK_SECRET     # the webhook secret from step 1
```

The integration is **enabled** only when `GITHUB_APP_ID` is set **and** both secrets
are present (see `loadGitHubConfig` in `src/infrastructure/config.ts`). Otherwise all
`/workspaces/:id/github/*` endpoints return `503`.

---

## 4. Enable the async fast-ack path (production)

By default the worker applies webhook/resync work **inline** (fine for dev). For
production, enable the queue so the webhook endpoint acks fast and offloads work:

```bash
wrangler queues create cat-factory-github-sync
wrangler queues create cat-factory-github-dlq
```

Then uncomment the `[[queues.producers]]` / `[[queues.consumers]]` blocks for
`cat-factory-github-sync` in `wrangler.toml`. (They're commented out by default
because the test pool registers one consumer per test file, which collides on a
shared queue — the same reason `EXECUTION_QUEUE` is opt-in.)

The `GITHUB_BACKFILL_WORKFLOW` binding and the `*/2 * * * *` cron reconciliation are
always active when GitHub is configured.

---

## 5. Apply the migration & deploy

```bash
pnpm --filter @cat-factory/worker run db:migrate:remote   # applies 0004_github_projections.sql
pnpm --filter @cat-factory/worker run deploy
```

---

## 6. Connect a workspace

1. Frontend: `GET /workspaces/:id/github/install-url` → redirect the user to the
   returned URL.
2. User installs the App on the desired repos/org.
3. GitHub redirects to `/github/setup/callback`; the worker binds the installation
   and starts a backfill.
4. Verify: `GET /workspaces/:id/github/connection` returns the connection;
   `GET /workspaces/:id/github/repos` lists the projected repos.

---

## Troubleshooting

| Symptom                                               | Likely cause                                               | Fix                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `503` from every `/github/*` endpoint                 | Integration disabled                                       | Set `GITHUB_APP_ID` + both secrets; redeploy                                                     |
| Key import error mentioning PKCS#1                    | Key is `BEGIN RSA PRIVATE KEY`                             | Convert with `openssl pkcs8` (step 2)                                                            |
| Webhooks return `401`                                 | Wrong `GITHUB_WEBHOOK_SECRET`, or a proxy mutated the body | Ensure the secret matches the App's; verify the raw body isn't re-encoded                        |
| `setup/callback` returns `401`                        | Invalid/expired `state`                                    | Start from `install-url` (don't hand-craft the URL); ensure `GITHUB_WEBHOOK_SECRET` is stable    |
| `Failed to mint installation token (HTTP 401)`        | App JWT invalid (wrong App ID / key / clock skew)          | Confirm `GITHUB_APP_ID` and the PKCS#8 key; the JWT backdates `iat` 60s for skew                 |
| Projections look stale                                | Missed webhook                                             | The `*/2` cron reconciles stale repos; or `POST …/github/resync` (optionally `{ "full": true }`) |
| Writes 403 / "Resource not accessible by integration" | Missing App permission                                     | Grant the needed permission and **accept the permission update** on the installation             |
| Hitting rate limits                                   | Too much polling                                           | Prefer webhooks; check the `github_rate_limits` ledger; the client honours `Retry-After`         |

**Rotating the webhook secret:** update it in the App settings and
`wrangler secret put GITHUB_WEBHOOK_SECRET`, then redeploy. **Rotating the private
key:** generate a new key, convert to PKCS#8, `wrangler secret put`, redeploy, then
delete the old key in GitHub.
