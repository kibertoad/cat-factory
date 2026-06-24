# Bring your own infra: self-hosted runner pool

By default cat-factory runs every repo-operating agent job in a **per-run
Cloudflare Container**. If your organization would rather run that workload on
**your own container/runner pool** — k3s, Nomad, Kubernetes, or an internal
scheduler — you register a runner pool for a workspace and cat-factory dispatches
its agent jobs there instead. The rollout is **per-workspace and reversible**: a
workspace with no registered pool falls back to Cloudflare Containers (when those
are enabled).

This integration is **declarative and code-free on our side**: you describe your
pool's scheduler API as a JSON **manifest** and cat-factory's single generic
interpreter (`HttpRunnerPoolProvider`) drives it. There are no per-org presets and
no adapter we ship and review. See [ADR 0004](./adr/0004-self-hosted-runner-pool.md)
for the design rationale; this is the operator + integrator playbook.

The work splits cleanly across two teams:

- **Platform / Infra team** — stands up runners and a small scheduler API in front
  of them (§1, §2, §6). This is the part that touches your cluster.
- **Application team** — writes the manifest and registers the pool against a
  workspace through the cat-factory API (§3, §4). This is pure configuration.

---

## What you provide

1. **Runners** that run the standard cat-factory **executor-harness** image and
   speak its fixed HTTP **job protocol** (§1). The harness is the same image
   Cloudflare Containers run — runtime parity is the whole point, so a runner
   serves *every* job kind with no per-kind work on your side.
2. A small **pool scheduler API** in front of those runners that cat-factory calls
   to **dispatch / poll / release** a job. You describe it as a **manifest** (§3)
   so we need no code for your specific scheduler.

```
 cat-factory backend                  your infra (the trust boundary)
┌─────────────────────┐   dispatch   ┌──────────────────┐   POST /jobs           ┌──────────┐
│ ContainerAgent      │ ───────────► │ your pool        │ ─────────────────────► │ a runner │
│ Executor            │   poll       │ scheduler API    │   GET /jobs/{id}       │ (harness │
│  (RunnerTransport)  │ ◄─────────── │ (manifest target)│ ◄───────────────────── │  image)  │
└─────────────────────┘   release    └──────────────────┘                        └──────────┘
        │                                                                              │
        │ short-lived per-job GitHub token + LLM-proxy session token (in dispatch body)│
        └──────────────────────────────────────────────────────────────────────────► │
                                       runner reaches back out to:  Worker LLM proxy + GitHub
```

---

## How it works (the sequence of actions)

A pipeline step that runs an agent (coder, architect, tester, merger, a repo
bootstrap, …) flows like this. Steps 2–7 repeat for **every** step of a run.

1. **Backend selection (per workspace, per job).** When the durable execution
   driver reaches an agent step, `ContainerAgentExecutor` asks the runtime to
   `resolveTransport(workspaceId)`. If the workspace has a registered pool and the
   feature is enabled, it gets a `RunnerPoolTransport` bound to that workspace's
   manifest + decrypted secrets; otherwise it gets the `CloudflareContainerTransport`
   (or, in self-hosted Node/local mode, the local Docker transport).
2. **Job body assembled.** The executor mints the per-job credentials (a short-lived
   GitHub installation token; for the Pi harness a model-locked LLM-proxy session
   token, or for Claude Code / Codex a leased subscription token), composes the
   agent's prompts, resolves the repo target, and builds the harness **job spec**
   (§1). It stamps the **dispatch `kind`** (which harness route to hit) and, when the
   service pins a size/provider, the **provisioning hints** (`instanceType`,
   `cloudProvider`) onto the spec.
3. **Dispatch.** `RunnerPoolTransport` calls `HttpRunnerPoolProvider.dispatch`, which
   interpolates your manifest's `dispatch` template and `POST`s (or whatever method
   you declared) to your scheduler, carrying your scheduler-API auth. The job is
   keyed on `jobId` — your scheduler **must route by it (sticky)** so later polls
   reach the same runner/job. Dispatch returns as soon as your API accepts it; the
   agent keeps working in the background.
4. **Your scheduler places the job** on a runner (queueing if the pool is saturated)
   and `POST`s the job spec to the matching harness route on that runner. The runner
   clones the repo, runs the agent, and (for write kinds) pushes a branch / opens a
   PR — reaching models **only** through the Worker LLM proxy and GitHub directly.
5. **Poll.** On the durable driver's cadence (default 15s), the executor calls
   `poll`, which interpolates your `poll` template (re-supplying `{{input.jobId}}`),
   reads your scheduler's status response, and projects it onto the canonical **job
   view** via your `response` dot-path mapping. While running it surfaces subtask
   progress ("N/M done"); the harness exposes this on `GET /jobs/{id}`.
6. **Completion.** When your mapping yields `state: "done"`, the executor reads the
   structured **result** (a PR url/branch/summary for code kinds, or a blueprint
   tree / spec doc / merge assessment / test report / bootstrap branch for the
   others) and hands it to the engine, which advances the run.
7. **Release (optional).** When the executor is done with a job — or to reclaim a
   cancelled/aborted one — it calls `release`, which fires your manifest's optional
   `release` template (e.g. `DELETE /jobs/{id}`). Best-effort and idempotent.

Crash-safety: cat-factory persists **no per-job dispatch state**. Because the job is
addressed by `jobId` and the workspace re-resolves the same backend on every poll, a
durable-driver replay just re-dispatches (your harness re-attaches to the running
job) or re-polls — there is only a **connection table**, no job registry.

### What runs on a pool today

**Every asynchronous agent kind** routes to a registered pool — there is no opt-in
allow-list, because a pool runs the same harness image as Cloudflare:

Every kind is dispatched to the **same** harness endpoint, `POST /jobs`, with the
`kind` carried in the job body:

| `kind`              | What the job does                                   |
| ------------------- | --------------------------------------------------- |
| `run`               | Implement a task: branch + commits + open a PR.     |
| `bootstrap`         | Scaffold/adapt a new repo and force-push it.        |
| `blueprint`         | Decompose the repo into the service→modules tree.   |
| `spec`              | Write/extend the in-repo prescriptive spec.         |
| `explore`           | Read-only architect/analysis; returns prose.        |
| `ci-fix`            | Fix red CI on the PR branch; push back.             |
| `resolve-conflicts` | Resolve merge conflicts on the PR branch.           |
| `merge`             | Score the PR diff; return a JSON assessment.        |
| `on-call`           | Investigate a post-release regression (JSON).       |
| `test`              | Run the suite; return a structured report.          |
| `fix-tests`         | Apply fixes from a test report; push back.          |

> **The one exception:** the synchronous repo **scan** (the manual board-scan
> "import this repo") still uses a Cloudflare Container directly and does **not**
> route to a pool. A pure-BYO deployment with no `EXEC_CONTAINER` binding can do
> everything above (including bootstrap) but cannot run a manual scan yet.

The crucial consequence for you: **the manifest has a single `dispatch` template, and
all eleven kinds go to the one harness endpoint `POST /jobs`.** The harness reads the
`kind` from the job body to pick the agent, so a transparent proxy in front of the
harness just forwards to `pathTemplate: "/jobs"`. The `kind` is exposed both inside
`{{input.job}}` (where the harness reads it) and as the first-class template variable
`{{input.kind}}` (§3), so your scheduler can still branch on it for node selection /
sizing without decoding the job JSON.

---

## 1. The runner: image + job protocol  *(Platform team)*

### Get the image

The runner image is published publicly (multi-arch, `amd64` + `arm64`) to both
GHCR and Docker Hub, so you can pull it directly — no build needed:

```bash
docker pull ghcr.io/kibertoad/cat-factory-executor:latest
# or
docker pull docker.io/kibertoad/cat-factory-executor:latest
```

Pin a version tag (not `latest`) for reproducible pools; the tags track the
harness package version. Or build it yourself from this repo to customize it:

```bash
docker build -t my-org/cat-factory-runner \
  -f backend/internal/executor-harness/Dockerfile \
  backend/internal/executor-harness
```

(Maintainers / forks: publish your own with
`pnpm --filter @cat-factory/executor-harness run image:publish` — see that
package's README.)

The image **carries no secrets**. It bundles git + the pinned Pi coding-agent CLI
(and the Claude Code / Codex CLIs for subscription harnesses) and runs an HTTP
server on port `8080`. All per-job secrets arrive in the dispatch body and live
only for the job. (Behind a TLS-inspecting corporate proxy, pass the proxy CA as a
build secret — see the comment block at the top of the Dockerfile.)

### The job protocol a runner speaks

| Method & path     | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `GET /health`     | Liveness. `{ "status": "ok" }`.                                  |
| `POST /jobs`      | Start (or re-attach to) any job; the body's `kind` picks the agent. |
| `GET /jobs/{id}`  | Poll any job. Returns the **job view** below.                    |

`POST /jobs` returns `202 { jobId, state }`. **All kinds are dispatched and polled
identically** — one endpoint to start (the `kind` field in the body selects the
agent), one uniform job view on `GET /jobs/{id}` regardless of kind; the per-kind work
product lands in its `result` fields.

**Dispatch body** — the job spec cat-factory sends. Treat it as **opaque and
forward it verbatim**; do not depend on its exact shape (it grows as agent kinds are
added). The fields that matter to *you* are `jobId` (route key) and `kind` (which
harness route); the rest is for the harness:

```jsonc
{
  "jobId": "<execution-id>-<agentKind>", // route key; re-POST re-attaches (idempotent)
  "kind": "run",                         // which harness route — maps 1:1 to the path
  "model": "qwen3-max",
  "harness": "pi",                       // "pi" | "claude-code" | "codex"
  // Pi harness: reaches models ONLY via the proxy with a model-locked session token.
  "proxyBaseUrl": "https://<worker>/v1",
  "sessionToken": "<model-locked proxy session token>",
  // Subscription harness (claude-code/codex) instead carries:
  // "subscriptionToken": "<leased credential>", "subscriptionBaseUrl": "https://…",
  "ghToken": "<short-lived GitHub installation token>",
  "githubApiBase": "https://api.github.com",        // present for GitHub Enterprise
  "repo": {
    "owner": "...", "name": "...", "baseBranch": "main",
    "cloneUrl": "https://github.com/owner/name.git",
    "serviceDirectory": "packages/api"              // monorepo subdir, when pinned
  },
  // Per-kind fields (vary by route): systemPrompt, userPrompt | instructions,
  // headBranch | branch, pr {title, body}, task {…}, mode, prNumber, test {…},
  // webToolsGuidance, webSearch, …
  // Provisioning hints (present only when the service pins a size/provider):
  "instanceType": "c7g.xlarge",
  "cloudProvider": "aws"
}
```

**Job view** — what `GET /jobs/{id}` returns, and what your `poll` mapping must be
able to project onto:

```jsonc
{
  "state": "running" | "done" | "failed",
  "progress": { "completed": 3, "inProgress": 1, "total": 8 }, // optional, while running
  "result": {           // when done — populated per kind:
    "prUrl": "...", "branch": "...", "summary": "...",          //   run / ci-fix / …
    "service": { ... },  "spec": { ... },                       //   blueprint / spec
    "assessment": { ... }, "report": { ... },                   //   merge / test
    "onCallAssessment": { ... }, "defaultBranch": "main",       //   on-call / bootstrap
    "pushed": true, "resolved": true,                           //   ci-fix / conflicts
    "usage": { "inputTokens": 0, "outputTokens": 0 }            //   subscription harness
  },
  "error": "..."         // when failed
}
```

**Idempotency:** a replayed `POST` for the same `jobId` must re-attach to the
running job, not start a duplicate. The harness does this in-process; **your
scheduler must therefore route by `jobId` (sticky)** so dispatch and every poll
reach the same runner/job.

### Runner lifecycle knobs (env on the runner, read by the harness)

| Env var               | Default         | Effect                                                       |
| --------------------- | --------------- | ------------------------------------------------------------ |
| `PORT`                | `8080`          | HTTP port the harness listens on.                            |
| `JOB_MAX_DURATION_MS` | `3600000` (60m) | Hard ceiling on a job's wall-clock time; force-fails after.  |
| `JOB_INACTIVITY_MS`   | `600000` (10m)  | Kills a hung agent that produces no output for this long.    |

Rely on these watchdogs to reap stuck jobs — cat-factory will not kill a runner for
you (it only calls your `release`).

---

## 2. Network requirements  *(Platform team)*

- **Ingress (cat-factory → your scheduler):** the manifest `baseUrl` (and OAuth
  `tokenUrl`, if any) must be reachable from the cat-factory backend over **public
  HTTPS** (a tunnel / reverse proxy is fine). The SSRF guard rejects `http://`,
  embedded credentials, and internal / RFC1918 / loopback / link-local hosts — so an
  internal cluster API must be fronted by a public ingress. **Or:** a trusted
  operator can widen the guard per facade so the scheduler can live on an
  internal/VPN host directly — see §6.
- **Egress (runner → out):** each runner must reach
  - the Worker LLM proxy at `${WORKER_PUBLIC_URL}/v1` (all Pi model calls go through
    it — no provider keys live on the runner), and for subscription harnesses the
    vendor API (`subscriptionBaseUrl`); and
  - GitHub (`github.com` or your GitHub Enterprise host) to clone, push and open PRs.

---

## 3. Describe your scheduler as a manifest  *(Application team)*

The manifest tells cat-factory how to **dispatch / poll / release**, how to
authenticate to your scheduler, and how to read your response shape. It is
Valibot-validated on registration (`backend/packages/contracts/src/runners.ts`).

### Template variables

Requests support `{{var}}` interpolation over a **bounded** namespace (unknown
references resolve to empty — a manifest can never reach arbitrary host state):

| Variable                | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `{{input.jobId}}`       | The job id the pool is keyed on (sticky-routing target).                       |
| `{{input.job}}`         | The **full** harness job spec as a JSON string — embed raw to forward verbatim. |
| `{{input.kind}}`        | The agent kind the job runs (`run`, `merge`, …). The harness reads this from the job body; use it to route/size on your scheduler side. |
| `{{input.instanceType}}`| Concrete instance-type id, when the service pins a size (else empty).          |
| `{{input.cloudProvider}}`| The cloud the service selected, when pinned (else empty).                     |

`{{input.kind}}` / `{{input.instanceType}}` / `{{input.cloudProvider}}` are
convenience projections of fields that also live inside `{{input.job}}`; they exist
so a path/query/header template can route or size **without parsing** the embedded
JSON.

### Example A — transparent proxy (recommended; routes by kind)

Your scheduler exposes the harness routes 1:1 behind a sticky-routed gateway. The
manifest just forwards everything; `{{input.kind}}` selects the path:

```jsonc
{
  "providerId": "acme-pool",                         // [a-z0-9-], ≤64
  "label": "Acme Runner Pool",
  "baseUrl": "https://runners.acme.example/api",     // public https
  "auth": { "type": "bearer", "secretRef": { "key": "API_TOKEN" } },

  "dispatch": {
    "method": "POST",
    "pathTemplate": "/dispatch/{{input.kind}}",       // route by kind
    "bodyTemplate": "{\"id\":\"{{input.jobId}}\",\"job\":{{input.job}}}"
  },
  "poll":    { "method": "GET",    "pathTemplate": "/jobs/{{input.jobId}}" },
  "release": { "method": "DELETE", "pathTemplate": "/jobs/{{input.jobId}}" },

  "response": {
    "resultPath": "result",            // forward the WHOLE harness result envelope
    "statusPath": "state",
    "statusMap": [
      { "from": "in_progress", "to": "running" },
      { "from": "succeeded",   "to": "done" },
      { "from": "errored",     "to": "failed" }
    ],
    "progressCompletedPath": "progress.completed",
    "progressInProgressPath": "progress.inProgress",
    "progressTotalPath": "progress.total",
    "errorPath": "error"
  }
}
```

### Example B — opaque envelope (your scheduler wraps the job)

Your scheduler accepts one generic "create job" call, queues it, and exposes its own
status shape. Your sidecar reads `kind` from the embedded job and routes internally:

```jsonc
{
  "providerId": "acme-k8s",
  "label": "Acme k8s jobs",
  "baseUrl": "https://jobs.acme.example",
  "auth": { "type": "oauth2_client_credentials",
            "tokenUrl": "https://auth.acme.example/oauth/token",
            "clientIdSecretRef":     { "key": "CLIENT_ID" },
            "clientSecretSecretRef": { "key": "CLIENT_SECRET" },
            "scope": "jobs:write" },
  "dispatch": {
    "method": "POST", "pathTemplate": "/v1/jobs",
    "bodyTemplate": "{\"name\":\"{{input.jobId}}\",\"kind\":\"{{input.kind}}\",\"instanceType\":\"{{input.instanceType}}\",\"spec\":{{input.job}}}"
  },
  "poll":    { "method": "GET",    "pathTemplate": "/v1/jobs/{{input.jobId}}" },
  "release": { "method": "DELETE", "pathTemplate": "/v1/jobs/{{input.jobId}}" },
  "response": {
    "resultPath": "data.result",
    "statusPath": "data.phase",
    "statusMap": [
      { "from": "Pending",   "to": "running" },
      { "from": "Running",   "to": "running" },
      { "from": "Succeeded", "to": "done" },
      { "from": "Failed",    "to": "failed" }
    ],
    "errorPath": "data.message"
  }
}
```

### Auth schemes (for calling **your** scheduler)

Each references its secret(s) by **logical key**; you supply the values at
registration (§4) and they are stored encrypted at rest — values never appear in the
manifest.

| `auth.type`                 | fields                                                                          | effect                                 |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `none`                      | —                                                                               | no auth header                         |
| `api_key`                   | `headerName`, `secretRef`, `valuePrefix?`                                       | `headerName: <prefix><secret>`         |
| `bearer`                    | `secretRef`                                                                     | `Authorization: Bearer <secret>`       |
| `basic`                     | `usernameSecretRef`, `passwordSecretRef`                                        | `Authorization: Basic base64(u:p)`     |
| `oauth2_client_credentials` | `tokenUrl`, `clientIdSecretRef`, `clientSecretSecretRef`, `scope?`, `audience?` | POST token (cached) → `Bearer …`       |
| `custom_headers`            | `headers: [{ name, secretRef }]`                                                | each header set from its secret        |

### Response mapping notes

- **`resultPath` is the field most schedulers want.** Point it at the object that
  holds the harness `result` envelope and cat-factory forwards **every** structured
  product — blueprint tree, spec doc, merge assessment, test report, bootstrap branch
  — not just the PR scalars. Known fields are coerced by type; unknown ones ignored.
- The scalar paths (`prUrlPath`, `branchPath`, `summaryPath`) still apply and
  **override** `resultPath` when set — for schedulers that surface those outside any
  envelope.
- `statusMap` matching is case-insensitive. An unmapped/unknown status falls back to
  `running` (keeps the driver waiting rather than wrongly failing). Map your terminal
  states explicitly to `done` / `failed`.
- Every request carries your auth automatically; per-call timeouts are bounded
  (`timeoutMs`, ≤60s, default 30s). Responses over ~200KB are rejected.

---

## 4. Enable the feature and register a pool  *(Application team + a one-time Platform step)*

**One-time (Platform):** opt in and set the at-rest encryption key on the backend.

```toml
# wrangler.toml (Cloudflare)  —  or env vars for the Node facade
RUNNERS_ENABLED = "true"
```

```bash
# Scheduler secrets are sealed with the shared ENCRYPTION_KEY (already required service-wide):
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY
```

The agent-job path also needs what the Cloudflare/Node container path needs: a
configured GitHub App, `WORKER_PUBLIC_URL` (the LLM proxy), and `AUTH_SESSION_SECRET`.
The feature refuses to assemble without `ENCRYPTION_KEY` — there is no plaintext
fallback.

**Per workspace (Application):** register the pool. Secret values are **write-only** —
encrypted, stored, and never returned. Every `secretRef.key` in the manifest must have
a matching entry in `secrets`.

```bash
curl -X POST "$API/workspaces/$WS/runner-pool/connection" \
  -H 'content-type: application/json' \
  -d '{ "manifest": { ... }, "secrets": { "API_TOKEN": "real-token" } }'
```

| Method & path                         | Purpose                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `GET /runner-pool/connection`         | Current binding (safe metadata + which secret keys set; never values). |
| `POST /runner-pool/connection`        | Register / replace the manifest + secret bundle.       |
| `PUT /runner-pool/connection/secrets` | Rotate the secret bundle (manifest unchanged).         |
| `DELETE /runner-pool/connection`      | Unregister the pool (falls back to Cloudflare).        |

All under `/workspaces/:workspaceId`. Once registered, that workspace's agent steps
run on your pool; unregister to revert.

---

## 5. Mapping the manifest onto k3s / Nomad / Kubernetes  *(Platform team)*

cat-factory only speaks HTTP to **your scheduler API** — it never talks to your
orchestrator directly. So you always put a thin API in front, and you have full
freedom to wrap it however your platform works. Two robust shapes:

- **Per-job pods/allocations (recommended):** on `dispatch`, create one Job/pod
  (k8s/k3s) or dispatch one job (Nomad) named after `{{input.jobId}}`, running your
  harness image; `POST` the job spec to the harness route the `kind` selects. On
  `poll`, read the job/alloc status and the harness `GET /jobs/{id}` and merge them
  into the response shape your mapping expects. On `release`, delete the
  Job/allocation.
- **Long-lived runner deployment + a router:** keep a warm pool of harness replicas
  behind a gateway that hash-routes by `jobId` (sticky), so the same replica handles
  a job's dispatch and all its polls. Your "scheduler API" is then just that gateway
  plus a tiny status endpoint.

Concrete tips for each:

- **Kubernetes / k3s.** A small operator or web service that maps `dispatch → create
  Job`, `poll → read Job + harness status`, `release → delete Job`. Use
  `{{input.instanceType}}` to pick a node selector / resource request and
  `{{input.kind}}` to select a Job template. Front it with an Ingress (public HTTPS) —
  that Ingress URL is your manifest `baseUrl`. Sticky routing falls out naturally
  because each `jobId` is its own Job/pod.
- **Nomad.** A service that maps `dispatch → submit a parameterized/batch job` keyed
  on `jobId`, `poll → allocation status + harness status`, `release → deregister`.
  `{{input.instanceType}}` → a constraint/resources block. Front with your gateway
  (Consul/Traefik) on public HTTPS.
- **Custom wrapper on top.** Because the contract is *only* dispatch/poll/release over
  HTTP with a dot-path response mapping, any internal scheduler works the same way:
  expose three endpoints, route by `jobId`, run the harness image, and forward the
  job view. The manifest's templating + `statusMap` + `resultPath` absorb almost any
  request/response shape without code on our side.

**The minimum contract your wrapper must honour**, regardless of orchestrator:

1. Accept the dispatch call, run the **harness image**, and hand it the job spec —
   `POST`ed to the route named by `kind` (the values map 1:1 to harness paths).
2. **Route by `jobId`, stickily** — dispatch and every poll for a job hit the same
   runner; a re-dispatch of the same `jobId` re-attaches (don't start a duplicate).
3. Expose a status your `poll` mapping can read, including the harness `result`
   envelope (so `resultPath` can forward the structured products).
4. Be reachable over **public HTTPS**; let the harness watchdogs reap stuck jobs;
   honour `release` (or let TTLs clean up).

---

## 6. Trust boundary & security notes

- Your pool and network receive the **short-lived per-job** GitHub installation token
  and the LLM-proxy session token in the dispatch body. They are scoped and expiring,
  but they do leave cat-factory — treat your scheduler and runners as part of the
  trust boundary.
- **Subscription harnesses are different.** A Claude Code / Codex step hands your
  runner the **raw, longer-lived subscription credential** (a Claude OAuth token or a
  full ChatGPT `auth.json`), not a model-locked proxy token — it must reach the vendor
  API directly. Only point subscription-harness steps at a pool **you operate and
  trust**; the credential stays within the workspace's own BYO trust domain, but it
  does leave the backend. (Pi-harness steps only ever carry the model-locked proxy
  token.)
- The runner image holds **no** long-lived secrets of ours; Pi models are reachable
  only through the Worker proxy, which meters token spend — so spend safeguards still
  apply to jobs that run on your pool.
- Scheduler-API credentials are encrypted at rest (AES-256-GCM, per-record salt + IV,
  HKDF-derived key under the `cat-factory:runners` domain) under the shared
  `ENCRYPTION_KEY`; the feature refuses to start without that key.
- Every manifest URL is SSRF-guarded before it is fetched; secrets are placed only in
  outgoing request headers — never logged, never echoed in (length-capped,
  header-free) error bodies, never returned by the read API.
- **Internal-host escape hatch (trusted operator).** When your scheduler must live on
  an internal/VPN host rather than behind a public ingress, widen the guard per
  facade:

  | Setting (env var / Worker `[vars]`) | Effect                                                                 |
  | ----------------------------------- | ---------------------------------------------------------------------- |
  | `RUNNERS_ALLOW_URL_HOSTS`           | Comma-separated hostnames exempt from the private/internal-host block. Each matches the URL host exactly (`pool.corp`, `10.1.2.3`) or as a dot suffix when it starts with `.` (`.internal`). |
  | `RUNNERS_ALLOW_HTTP_URLS`           | `true` to also permit `http` (not just `https`).                       |

  Only the listed hosts are exempted; everything else stays strict, and embedded URL
  credentials remain forbidden. This policy is scoped to the runner pool **only** —
  it is resolved independently of the
  [environment integration](./environments-integration.md)'s `ENVIRONMENTS_ALLOW_URL_HOSTS`
  / `ENVIRONMENTS_ALLOW_HTTP_URLS`, so a host you allow here is **not** reachable by the
  environment provider (and vice versa). Set each integration's allow-list to exactly
  what it needs. Leave unset (the default) to keep the strict public-https guard.

---

## 7. Scaling & operations

- cat-factory dispatches one job per pipeline **step** and polls it on the durable
  driver's cadence (`JOB_POLL_INTERVAL`, default 15s). A run executes a *sequence* of
  steps, each its own pool job (distinct `jobId` = `<executionId>-<agentKind>`), so a
  busy workspace produces many short-lived jobs — size your pool for concurrency, not
  for one job per run.
- **Your scheduler owns capacity.** Queue jobs when the pool is saturated and report
  them as `running` until a runner picks them up; cat-factory will keep polling.
- Keep routing **sticky by `jobId`** so re-dispatches (Workflows replay, a sweeper
  re-drive) and polls reach the same job.
- Rely on the harness watchdogs (`JOB_MAX_DURATION_MS` / `JOB_INACTIVITY_MS`) to reap
  stuck jobs; cat-factory's `release` is best-effort cleanup, not a guaranteed kill.

---

## See also

- [ADR 0004](./adr/0004-self-hosted-runner-pool.md) — design rationale.
- [Ephemeral environment provider](./environments-integration.md) — the sibling
  manifest integration (same auth schemes, dot-path mapping, SSRF guard, encryption),
  used when a `tester` agent needs a live preview environment to run against.
