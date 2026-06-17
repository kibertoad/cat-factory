# Bring your own infra: self-hosted runner pool

By default, cat-factory runs the repo-operating coding jobs (`coder`, `mocker`,
`playwright`) in per-run **Cloudflare Containers**. If your organization would
rather run that workload on **your own container/runner pool** — Kubernetes,
Nomad, an internal scheduler — you can register a runner pool for a workspace and
cat-factory will dispatch its coding jobs there instead.

You provide two things:

1. **Runners** that run the standard cat-factory implementer-harness image and
   speak its job protocol.
2. A small **pool scheduler API** in front of those runners, described to
   cat-factory as a declarative **manifest** (no cat-factory code change).

See ADR 0004 for the design rationale. This guide is the operator playbook.

> **Scope (v1).** Only the asynchronous coding jobs route to a self-hosted pool.
> Repo **bootstrap** and **scan** still use Cloudflare Containers, so keep the
> `IMPL_CONTAINER` binding enabled if you use those features.

---

## 1. Build the runner image

Build the existing harness image from this repo — there is no separate published
image:

```bash
docker build -t my-org/cat-factory-runner \
  -f backend/internal/implementer-harness/Dockerfile \
  backend/internal/implementer-harness
```

The image **carries no secrets**. It bundles git + the pinned Pi coding-agent CLI
and runs an HTTP server on port `8080`. All per-job secrets (a short-lived GitHub
token and a model-locked LLM-proxy session token) arrive in the `POST /run` body
at dispatch time and live only for the job.

(Behind a TLS-inspecting corporate proxy, pass the proxy CA as a build secret —
see the comment block at the top of the Dockerfile.)

### The job protocol a runner speaks

The harness exposes:

| Method & path    | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `GET /health`    | Liveness. `{ "status": "ok" }`.                                |
| `POST /run`      | Start (or re-attach to) a job. Returns `202 { jobId, state }`. |
| `GET /jobs/{id}` | Poll a job. Returns the **job view** below.                    |

`POST /run` body (the job spec cat-factory sends; forward it verbatim):

```jsonc
{
  "jobId": "<execution id>", // the job is keyed on this; re-POST re-attaches
  "systemPrompt": "...",
  "userPrompt": "...",
  "model": "qwen3-max",
  "proxyBaseUrl": "https://<worker>/v1", // the runner reaches models only via here
  "sessionToken": "<model-locked proxy token>",
  "ghToken": "<short-lived GitHub installation token>",
  "repo": { "owner": "...", "name": "...", "baseBranch": "main", "cloneUrl": "..." },
  "headBranch": "cat-factory/<block>-<short>",
  "pr": { "title": "...", "body": "..." },
}
```

`GET /jobs/{id}` job view (what your scheduler ultimately exposes to cat-factory —
your `poll` mapping projects onto this shape):

```jsonc
{
  "state": "running" | "done" | "failed",
  "progress": { "completed": 3, "inProgress": 1, "total": 8 },  // optional, while running
  "result": { "prUrl": "...", "branch": "...", "summary": "..." }, // when done
  "error": "..."                                                  // when failed
}
```

The job is **idempotent on `jobId`**: a replayed `POST /run` for the same id
re-attaches to the running job rather than starting a duplicate. Your scheduler
must therefore **route by `jobId`** (sticky), so dispatch and subsequent polls
reach the same runner/job.

### Runner lifecycle knobs (set on the runner, read by the harness)

| Env var               | Default         | Effect                                                      |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `PORT`                | `8080`          | HTTP port the harness listens on.                           |
| `JOB_MAX_DURATION_MS` | `3600000` (60m) | Hard ceiling on a job's wall-clock time; force-fails after. |
| `JOB_INACTIVITY_MS`   | `600000` (10m)  | Kills a hung agent that produces no output for this long.   |

---

## 2. Network requirements

- **Ingress (Worker → your pool scheduler):** the manifest `baseUrl` must be
  reachable from the cat-factory Worker. It must be **public HTTPS** (or exposed
  via a tunnel / reverse proxy). The SSRF guard rejects `http://`, embedded
  credentials, and internal/RFC1918/loopback/link-local hosts.
- **Egress (runner → out):** each runner must reach
  - the Worker LLM proxy at `${WORKER_PUBLIC_URL}/v1` (all model calls go through
    it; no provider keys live on the runner), and
  - GitHub (`github.com` or your GitHub Enterprise host) to clone, push and open
    the PR.

---

## 3. Describe your scheduler as a manifest

The manifest tells cat-factory how to **dispatch**, **poll** and (optionally)
**release** a job against your scheduler, how to authenticate, and how to read your
response shape. Template variables: `{{input.jobId}}` (the job id) and
`{{input.job}}` (the full job spec as JSON — embed it raw to forward verbatim).

A transparent scheduler that simply proxies the harness:

```jsonc
{
  "providerId": "acme-pool",
  "label": "Acme Runner Pool",
  "baseUrl": "https://runners.acme.example/api",
  "auth": { "type": "bearer", "secretRef": { "key": "API_TOKEN" } },
  "dispatch": {
    "method": "POST",
    "pathTemplate": "/jobs",
    "bodyTemplate": "{\"id\":\"{{input.jobId}}\",\"job\":{{input.job}}}",
  },
  "poll": { "method": "GET", "pathTemplate": "/jobs/{{input.jobId}}" },
  "release": { "method": "DELETE", "pathTemplate": "/jobs/{{input.jobId}}" },
  "response": {
    "statusPath": "state",
    "statusMap": [
      { "from": "in_progress", "to": "running" },
      { "from": "succeeded", "to": "done" },
      { "from": "errored", "to": "failed" },
    ],
    "progressCompletedPath": "progress.completed",
    "progressInProgressPath": "progress.inProgress",
    "progressTotalPath": "progress.total",
    "prUrlPath": "result.pr_url",
    "branchPath": "result.branch",
    "summaryPath": "result.summary",
    "errorPath": "error",
  },
}
```

Notes:

- **Auth schemes:** `none`, `api_key` (header + optional value prefix), `bearer`,
  `basic`, `oauth2_client_credentials` (token URL + client id/secret, cached), and
  `custom_headers`. Each references its secret(s) by _logical key_; you supply the
  values separately (below) and they are stored encrypted at rest.
- **`response` mapping** uses dot-paths against your JSON (`a.b.0.c`). Anything you
  omit simply maps to "unset". If your scheduler already returns the harness job
  view verbatim, your mapping is just `statusPath` + a `statusMap` plus the
  `result.*` paths.
- `dispatch`/`poll`/`release` requests carry your auth automatically; per-call
  timeouts are bounded.

---

## 4. Enable the feature and register a pool

On the Worker, opt in and provide the at-rest encryption key (a service-level
secret, distinct from the environment key):

```toml
# wrangler.toml
RUNNERS_ENABLED = "true"
```

```bash
openssl rand -base64 32 | wrangler secret put RUNNERS_ENCRYPTION_KEY
```

The coding-job path also needs what the Cloudflare container path needs: a
configured GitHub App, `WORKER_PUBLIC_URL`, and `AUTH_SESSION_SECRET`.

Then register the pool for a workspace (the secret values are write-only — they
are encrypted and never returned):

```bash
curl -X POST "$API/workspaces/$WS/runner-pool/connection" \
  -H 'content-type: application/json' \
  -d '{ "manifest": { ... }, "secrets": { "API_TOKEN": "..." } }'
```

Endpoints (all under `/workspaces/:workspaceId`):

| Method & path                         | Purpose                                               |
| ------------------------------------- | ----------------------------------------------------- |
| `GET /runner-pool/connection`         | Current binding (safe metadata; never secret values). |
| `POST /runner-pool/connection`        | Register/replace the manifest + secret bundle.        |
| `PUT /runner-pool/connection/secrets` | Rotate the secret bundle (manifest unchanged).        |
| `DELETE /runner-pool/connection`      | Unregister the pool.                                  |

Once registered, that workspace's `coder` / `mocker` / `playwright` steps run on
your pool. Workspaces **without** a registered pool fall back to Cloudflare
Containers (when enabled), so the rollout is per-workspace and reversible.

---

## 5. Trust boundary & security notes

- Your pool and network receive the **short-lived per-job** GitHub installation
  token and LLM-proxy session token in the dispatch payload. They are scoped and
  expiring, but they do leave Cloudflare — treat your scheduler and runners as part
  of the trust boundary.
- The runner image holds **no** long-lived secrets; models are reachable only
  through the Worker proxy, which meters token spend (so spend safeguards still
  apply to jobs that run on your pool).
- Scheduler-API credentials are encrypted at rest (AES-256-GCM) under
  `RUNNERS_ENCRYPTION_KEY`; the feature refuses to start without that key.
- Every manifest URL is SSRF-guarded before it is fetched.

---

## 6. Scaling

cat-factory dispatches one job per execution and polls it on the durable driver's
cadence (`JOB_POLL_INTERVAL`, default 15s). Your scheduler owns capacity: queue
jobs when the pool is saturated and report them as `running` until a runner picks
them up. Keep routing sticky by `jobId` so re-dispatches and polls reach the same
job, and rely on the harness watchdogs (`JOB_MAX_DURATION_MS` /
`JOB_INACTIVITY_MS`) to reap stuck jobs.
