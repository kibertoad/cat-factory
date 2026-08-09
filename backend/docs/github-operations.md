# GitHub Integration: Operations Runbook

> **Creating the App and connecting a workspace are on the website**
> ([Register the GitHub App](https://www.catfactory.ai/deploy/github-app.html)), which owns the
> permission table, the key conversion, the privileged-App opt-in for programmatic repo creation
> and the operator-facing troubleshooting. The hardening that goes with them is on
> [Security Model & Hardening](https://www.catfactory.ai/reference/security-model.html). What
> stays here is the runbook for someone with the repository open: the production queue path, the
> deploy commands, the failure signatures that need the internals to read, and rotation.

For the integration design see [github-integration.md](./github-integration.md) and
[adr/0001-github-app-integration.md](./adr/0001-github-app-integration.md).

The App-creation helper the website's fast path names lives here:
[`github-app-manifest.html`](./github-app-manifest.html) posts
[`github-app-manifest.json`](./github-app-manifest.json) to GitHub's App-creation flow with every
permission, event and URL pre-filled. Editing either means editing both, and the permission set
they carry is the one the website's table documents.

---

## The async fast-ack path (production)

By default the worker applies webhook/resync work **inline** (fine for dev). For
production, enable the queue so the webhook endpoint acks fast and offloads work:

```bash
wrangler queues create cat-factory-github-sync
wrangler queues create cat-factory-github-dlq
```

Then uncomment the `[[queues.producers]]` / `[[queues.consumers]]` blocks for
`cat-factory-github-sync` in `wrangler.toml`. (They're commented out by default
because the test pool registers one consumer per test file, which collides on a
shared queue, the same reason `EXECUTION_QUEUE` is opt-in.)

The `GITHUB_BACKFILL_WORKFLOW` binding and the `*/2 * * * *` cron reconciliation are
always active when GitHub is configured.

---

## Apply the migration & deploy

```bash
pnpm --filter @cat-factory/worker run db:migrate:remote   # applies 0004_github_projections.sql
pnpm --filter @cat-factory/worker run deploy
```

---

## Troubleshooting

The website's page carries the operator-facing table (a `503` from every endpoint, a PKCS#1 key, a
`401` on webhooks or the setup callback, a missing permission, an empty sign-in allowlist). These
are the rows underneath it: the ones whose fix is a fact about the integration's internals rather
than a setting to change.

| Symptom                                        | Likely cause                                      | Fix                                                                                              |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Failed to mint installation token (HTTP 401)` | App JWT invalid (wrong App ID / key / clock skew) | Confirm `GITHUB_APP_ID` and the PKCS#8 key; the JWT backdates `iat` 60s for skew                 |
| Projections look stale                         | Missed webhook                                    | The `*/2` cron reconciles stale repos; or `POST …/github/resync` (optionally `{ "full": true }`) |
| Hitting rate limits                            | Too much polling                                  | Prefer webhooks; check the `github_rate_limits` ledger; the client honours `Retry-After`         |

Each of the three is diagnosed from something only this side can see: the JWT's claims, the
reconciliation cursor, and the rate-limit ledger. A symptom whose fix is "set the variable" or
"grant the permission" belongs on the website's table, where the operator already is.

**Rotating the webhook secret:** update it in the App settings and
`wrangler secret put GITHUB_WEBHOOK_SECRET`, then redeploy. **Rotating the private
key:** generate a new key, convert to PKCS#8, `wrangler secret put`, redeploy, then
delete the old key in GitHub.
