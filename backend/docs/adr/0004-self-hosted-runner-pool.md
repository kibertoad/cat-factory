# ADR 0004: Bring-your-own-infra via a self-hosted runner-pool manifest

- **Status:** Accepted
- **Date:** 2026-06-16
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/core`, `@cat-factory/worker`)

## Context

The repo-operating coding steps (`coder`, `mocker`, `playwright`) run the Pi
coding agent in a real sandbox: by default a **per-run Cloudflare Container**
(`ImplementationContainer`, a Durable-Object-backed container). The Worker
addresses one instance per execution and speaks the `implementer-harness` HTTP
job protocol to it — `POST /run` to dispatch, `GET /jobs/{id}` to poll
(`ContainerAgentExecutor`).

Some organizations cannot or will not run this workload on Cloudflare Containers:
they have their **own** container/runner pools (Kubernetes, Nomad, an internal
scheduler) inside their network, with bespoke scheduling, scaling and auth, often
for compliance or network-egress reasons. They want cat-factory to **dispatch
coding jobs to their pool instead of spinning Cloudflare Containers**, and a
clear, documented path for standing those runners up.

This is exactly the **org-hosted runner** alternative that ADR 0003 deferred (see
its *Alternatives considered*). We pick it up here.

## Decision

Reuse the proven pattern ADR 0003 established for ephemeral environments. The
**harness job protocol is fixed and standard** (`/run`, `/jobs/{id}` → a known job
view); what is org-specific is the **scheduler in front of the pool** — how a job
is assigned to a runner, queued, scaled, and how status is read back. So an org
describes its pool scheduler as a single, generic, **declarative manifest**
(Valibot-validated, in `@cat-factory/contracts`), of HTTP request templates for
`dispatch` / `poll` / (optional) `release`, with:

- arbitrary method, path, query, headers and body per operation, with bounded
  `{{input.jobId}}` / `{{input.job}}` interpolation (the latter is the full
  harness job spec as JSON, so a transparent scheduler forwards it verbatim);
- an **auth scheme** for calling the scheduler API (none / api-key / bearer /
  basic / OAuth2 client-credentials / custom headers) — the *same* generic
  auth-scheme contract the environment manifest uses; and
- a **dot-path response mapping** that projects the scheduler's arbitrary status
  response onto the canonical harness job view (state, subtask progress, the PR
  url / branch / summary result, and any error).

One generic adapter — `HttpRunnerPoolProvider`
(`worker/src/infrastructure/runners/`) — interprets **any** manifest, reusing the
environment module's generic primitives (`{{var}}` interpolation, dot-path
extraction, the SSRF guard). There are no per-provider presets and no per-org
TypeScript: an org's integration is data, registered through the API, not code we
ship.

`ContainerAgentExecutor` no longer talks to a concrete backend. It dispatches and
polls through a small **`RunnerTransport`** port, of which there are two
implementations: `CloudflareContainerTransport` (the per-run Durable-Object
container, unchanged behaviour) and `RunnerPoolTransport` (the manifest-driven
self-hosted pool). Backend selection is **per workspace**, resolved per job: a
workspace with a registered pool (and `RUNNERS_ENABLED`) uses it; otherwise the
job falls back to a Cloudflare Container when those are enabled. The whole feature
is **opt-in**, assembled only when configured — exactly like the GitHub,
Confluence and environment modules (`Core.runners?`).

### Addressing & idempotency

The pool is required to be **addressable by the cat-factory job id** (the
execution id): `dispatch` is keyed on it and `poll`/`release` re-supply it as
`{{input.jobId}}`. This mirrors how the Cloudflare container is one Durable Object
per id, keeps dispatch idempotent (a Workflows replay re-attaches rather than
duplicating), and — crucially — means **no per-job state** has to be persisted on
our side: the execution engine already tracks each job durably, and the poll site
re-resolves the same backend from the job's workspace id (carried on the job
handle). There is therefore only a connection table, no job registry.

### Secrets

Mirrors ADR 0003: the manifest references the scheduler-API credentials by
**logical key** only; the org supplies the values at registration, and they are
stored **encrypted at rest in D1** (AES-256-GCM via the `SecretCipher` port /
`WebCryptoSecretCipher`, with a per-record salt and IV, an HKDF-derived key under
the `cat-factory:runners` info, and a versioned envelope). The single env secret
is the service-level master key (`RUNNERS_ENCRYPTION_KEY`), distinct from the
environment module's; the feature refuses to assemble without it (never a silent
plaintext fallback).

The **per-job** GitHub installation token and the model-locked LLM-proxy session
token travel inside the interpolated dispatch payload — the runner needs them to
clone/push and to reach models — but are never logged, and error bodies stay
length-capped and header-free.

## Rationale

- **Manifest over code.** A declarative manifest lets each org own its integration
  without us shipping or reviewing per-org adapters, and keeps the Worker a single,
  audited code path. Dot-path extraction + templating cover arbitrary self-rolled
  scheduler shapes without presets. This is the same trade-off ADR 0003 accepted.
- **A transport seam, not a fork of the executor.** Putting the backend choice
  behind `RunnerTransport` means the prompt composition, model locking, token
  minting and result mapping in `ContainerAgentExecutor` are shared by both
  backends — the only thing that varies is *where the job runs*.
- **Addressable-by-job-id, so no job registry.** Requiring the pool to route by our
  job id keeps dispatch idempotent under Workflows replay and avoids persisting
  per-job dispatch state, which the durable driver would otherwise force.
- **Encryption by construction.** Per-tenant scheduler secrets belong in D1,
  encrypted at rest (and the feature refuses to start without a key) — matching the
  environment module.

## Alternatives considered

- **A two-phase lease/claim contract** (acquire a runner → get a per-job URL →
  dispatch/poll there → release). More explicit pool control, but a richer contract
  every org must implement, and it forces persisting the per-job URL across durable
  replays. Rejected in favour of address-by-job-id, which most schedulers can
  satisfy with sticky routing.
- **A raw fetch-passthrough transport** (proxy the harness protocol verbatim to a
  single org endpoint). Simpler, but assumes the org exposes the exact harness
  shape; the manifest's response mapping is what lets an org wrap the harness in
  its own envelope. The passthrough case is still trivial to express as a manifest.
- **Publishing the harness image + reference k8s manifests.** Useful, but out of
  scope for this change: orgs build the existing
  `implementer-harness/Dockerfile` and stand up their own pool. Documented in
  `docs/runner-pool-integration.md`; a published image is a sensible follow-up.

## Consequences

- The manifest can call arbitrary URLs, so every URL it touches (manifest base,
  OAuth token URL) is SSRF-guarded (https-only, no embedded creds, no
  internal/RFC1918 hosts), reusing the environment guard.
- **Scope (v1):** only the async coding jobs (`/run` + poll) route to a pool. The
  synchronous repo **bootstrap** and **scan** flows still use Cloudflare Containers
  (`ContainerRepoBootstrapper` / `ContainerRepoScanner` are unchanged); a pure-BYO
  deployment with no `IMPL_CONTAINER` binding therefore cannot bootstrap/scan yet.
  Extending the manifest with optional bootstrap/scan templates is a follow-up.
- A self-hosted pool must be reachable from the Worker (public or via a tunnel),
  and the runner must reach back out to the Worker's LLM proxy and to GitHub. The
  network requirements are documented in `docs/runner-pool-integration.md`.
- With BYO infra the org's pool/network handle the short-lived per-job GitHub +
  proxy tokens — a trust boundary the integration doc calls out explicitly.
