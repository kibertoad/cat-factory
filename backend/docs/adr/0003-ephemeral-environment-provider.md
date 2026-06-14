# ADR 0003: Pluggable ephemeral-environment providers via a declarative manifest

- **Status:** Accepted
- **Date:** 2026-06-14
- **Context layer:** backend (`@cat-factory/core`, `@cat-factory/worker`)

## Context

For a `tester` agent to give real signal it should run against a real deployed
build, which means a pipeline must first be able to **provision an ephemeral
environment** for the block under work. The hard part is that there is no common
target to integrate with: every organization rolls its **own** preview/ephemeral
environment tooling, with bespoke internal auth, and standardizing that across
companies is not feasible. We also run on Cloudflare Workers (ADR 0002), which
**cannot shell out** — so "run the company's CLI" is not an option from the
backend.

We need a way for an organization to plug in its own environment management that:

1. the org owns and configures itself, with **no cat-factory code change per org**;
2. makes **no assumptions** about the shape of that org's API (no SaaS presets);
3. handles the **common auth schemes** for calling that management API; and
4. lets a downstream **tester agent discover and use** the provisioned
   environment (its URL + how to authenticate) automatically.

## Decision

Model a provider as a single, generic, **declarative manifest** (Valibot-validated,
in `@cat-factory/contracts`) that describes the org's self-rolled management API as
**HTTP request templates** for `provision` / `status` / `teardown`, with:

- arbitrary method, path, query, headers and body per operation, with bounded
  `{{input.*}}` / `{{provision.*}}` interpolation;
- an **auth scheme** for calling the management API (none / api-key / bearer /
  basic / OAuth2 client-credentials / custom headers); and
- a **dot-path response mapping** that projects the org's arbitrary response onto a
  canonical environment handle (url, external id, status, expiry, and the env's own
  per-environment access credentials).

One generic adapter — `HttpEnvironmentProvider` (`worker/src/infrastructure/
environments/`) — interprets **any** manifest. There are no per-provider presets
and no per-org TypeScript: an org's integration is data, registered through the
API, not code we ship.

A new deterministic **`deployer` agent step** provisions the environment by calling
the provider directly through the execution engine (no LLM); the resulting handle
is persisted in a registry keyed by block, and injected into subsequent steps'
`AgentRunContext` so a `tester` step discovers the live URL and access scheme. The
whole feature is **opt-in**, assembled only when configured — exactly like the
GitHub and Confluence modules (`Core.environments?`).

### Secrets

Per-tenant secrets do not scale in env vars, and env is for service-level secrets.
So the manifest references credentials by **logical key** only; the org supplies the
actual values at registration, and they are stored **encrypted at rest in D1**
(AES-256-GCM via the `SecretCipher` port / `WebCryptoSecretCipher`, with a
per-record salt and IV, an HKDF-derived key, and a versioned envelope). The single
env secret is the service-level master key (`ENVIRONMENTS_ENCRYPTION_KEY`); the
feature refuses to assemble without it (never a silent plaintext fallback). The
provisioned environment's own access credentials are likewise encrypted, and
surfaced only via a dedicated, auth-gated access endpoint and the in-run agent
context — never in list responses, logs, or error bodies.

## Rationale

- **Deterministic deployer, not the LLM.** Only the Worker can `fetch` the org's
  API; an LLM would hallucinate a URL and would wrongly accrue token spend.
  Provisioning is structured IO, so the engine special-cases the `deployer` kind and
  calls the provider directly, keeping the engine's determinism guarantee intact.
- **Manifest over code.** A declarative manifest lets each org own its integration
  without us shipping or reviewing per-org adapters, and keeps the worker a single,
  audited code path. Dot-path extraction + templating cover arbitrary self-rolled
  shapes without presets.
- **Encryption by construction.** Storing per-tenant secrets in D1 is the scalable
  choice; encrypting them at rest (and refusing to start without a key) makes that
  safe and matches the user's requirement.

## Alternatives considered

- **An org-hosted runner** that executes the company's CLI in their network and
  reports back. Strictly more capable (covers CLI-only tooling), but requires every
  org to deploy and operate a companion process; deferred in favour of the API-only
  manifest, which most self-rolled tools already expose.
- **Per-org TypeScript adapters** registered in a code registry. Maximum
  flexibility, but every org must write and we must ship/review code — exactly what
  the manifest avoids.
- **SaaS provider presets** (Vercel/Heroku/…). Rejected: orgs run their own tooling;
  presets would be dead weight and wrong assumptions.
- **Secret refs to Worker env vars.** Rejected: per-tenant secrets in env do not
  scale; they belong in D1, encrypted.

## Consequences

- The manifest is powerful enough to call arbitrary URLs, so every URL it touches
  (manifest base, OAuth token URL, the extracted env URL) is SSRF-guarded
  (https-only, no embedded creds, no internal/RFC1918 hosts), reusing the
  Confluence guard's approach.
- A global TTL sweep on the existing 2-min cron tears down expired environments;
  teardown is best-effort so an unreachable provider can't wedge the registry.
- Existing GitHub/Confluence tokens remain plaintext-at-rest today; retrofitting
  them onto `SecretCipher` is a sensible follow-up, out of scope here.
- Discovery is delivered for the in-run `deployer → tester` case (same block);
  cross-block discovery via `dependsOn` is a small follow-up.
