# Security hardening pass

## Goal & rationale

A cross-cutting security review (auth/crypto, SSRF/network/container boundaries,
input-validation/injection/secret-exposure) found the codebase already well defended, with a
concentrated set of residual gaps. This initiative closes them. The work is grouped into
tiers by severity/effort and shipped as a few small PRs rather than one large change; this
tracker is the durable source of truth so a later iteration can pick up the remaining work
without re-deriving context.

Nearly all changes live in **shared packages** (`kernel`, `server`, `integrations`,
`orchestration`) or a single facade's config, so cross-runtime symmetry is preserved for
free — the one exception is the machine-token revocation store (item 8), which adds a table
and therefore carries the symmetric D1 ⇄ Drizzle + conformance work.

## Status checklist

| # | Item | Severity | Status | PR |
|---|------|----------|--------|----|
| 1 | Local-runner `fc`/`fd` hostname SSRF bypass | High | ✅ done | SSRF PR |
| 2 | Runner-pool + `probeConnection` redirect revalidation | High | ✅ done | SSRF PR |
| 3 | SearXNG web-search upstream SSRF guard | Medium | ✅ done | SSRF PR |
| 4 | Local-mode secret minimum length | Medium | ✅ done | Tier-2 PR |
| 5 | GitHub webhook empty-secret fail-closed | Low | ✅ done | Tier-2 PR |
| 6 | CORS default-deny in production | Low | ✅ done | Tier-2 PR |
| 7 | LLM telemetry secret redaction + per-workspace gate | High | ✅ done | Tier-3 PR |
| 9 | HKDF per-audience token key separation | Medium | ✅ done | Tier-3 PR |
| 8 | Machine-token revocation store | Medium | ⏳ todo | (its own PR) |

## What shipped (items 1–7, 9)

- **SSRF (1–3):** `localModelUrl` now reuses the kernel `ip-host` primitives and gates the
  IPv6-ULA test behind an is-literal check; a shared `modules/shared/safe-fetch.ts` gives the
  runner-pool + environment providers (and `probeConnection`) per-hop redirect revalidation +
  a streamed byte cap; the account-configured SearXNG URL is guarded at the write boundary
  (`AccountSettingsService.write`) and on every fetch hop (public host, http/https, no
  private/internal/metadata target).
- **Boundary hardening (4–6):** local mode rejects a `<32`-char `AUTH_SESSION_SECRET` and a
  `<32`-byte `ENCRYPTION_KEY` at config load; `WebCryptoWebhookVerifier` fails closed on an
  empty secret; CORS reflects an unset allowlist only in a non-production `ENVIRONMENT`
  (`corsReflectsWhenUnset`), threaded through both facades.
- **Telemetry redaction (7):** a shared `redactSecrets` (promoted to
  `kernel/src/shared/redact-secrets.logic.ts`, reused by the provisioning-log path) scrubs
  credential shapes from `promptText`/`responseText`/`reasoningText` before they are stored
  or fanned out to Langfuse; body capture is additionally gated on the per-workspace
  `storeAgentContext` toggle (numeric telemetry always records). Fixed a latent O(n²)
  backtrack in the URL-userinfo rule (bounded the scheme quantifier) surfaced by large prompts.
- **Key separation (9):** `HmacSigner` derives an independent HKDF-SHA256 subkey per token
  audience (`info = "cat-factory:token:<aud>"`), so each token class is cryptographically
  isolated; audience-less payloads fall back to the raw-secret key (tests/legacy).

## Conventions & gotchas carried forward

- **`redactSecrets` is O(n) — keep it that way.** Any new rule with a greedy `X*` before a
  required literal (e.g. a scheme before `://`) will backtrack quadratically on long
  repetitive input (real LLM prompts are large). Bound such quantifiers (`{0,39}`).
- The SSRF `safeFetch` takes an injected `assertSafe` + error factory (and an optional
  `doFetch` for tests). Reuse it for any new provider that fetches an org-supplied URL;
  don't reintroduce a bare `fetch` with `redirect: 'follow'`.
- CORS default-deny keys off `ENVIRONMENT ∈ {production, prod, staging}`. e2e/dev set their
  own `CORS_ALLOWED_ORIGINS`, so they're unaffected.

---

## Item 8 — Machine-token revocation (todo, its own PR)

**Problem.** `mintMachineToken` issues a 30-day, `machine`-audience HMAC token for a
mothership-mode local node (presented on `POST /internal/persistence`). `nodeId` is minted
"for future revocation" but nothing checks it — a leaked token grants account-scoped
persistence RPC for up to 30 days with no kill switch.

**Approach.** A revocation store keyed by `nodeId`, checked in `PersistenceController` after
the audience verification, plus a revoke endpoint. New table ⇒ the symmetric cross-runtime
persistence work. Consider also shortening `DEFAULT_MACHINE_TOKEN_TTL_MS`.

**Checklist (keep the runtimes symmetric):**

- [ ] `kernel`: add a `MachineTokenRevocationRepository` port — `isRevoked(nodeId)`,
  `revoke(nodeId, revokedAt)`, `listRevoked(before?)` (for pruning). Add to the ports index.
- [ ] `server`: in `PersistenceController`, after `verify(...aud: machine)` succeeds, reject
  (403) when `await revocationRepo.isRevoked(payload.nodeId)`. Resolve the repo from the
  container (add to `ServerContainer`/`repositories` or the DI object). Add a revoke endpoint
  (session-gated, owner-scoped) alongside the mint endpoint in `AuthController`
  (`POST /auth/machine-token/:nodeId/revoke` or `DELETE`).
- [ ] Cloudflare: `revoked_machine_nodes` D1 table (fresh numbered migration under
  `runtimes/cloudflare/migrations/`) + `D1MachineTokenRevocationRepository`, wired in
  `infrastructure/container.ts`.
- [ ] Node: `revokedMachineNodes` Drizzle table in `db/schema.ts` + a generated migration
  (`pnpm db:generate` — a fresh table won't trigger the interactive rename prompt) +
  `DrizzleMachineTokenRevocationRepository`, wired in `runtimes/node/src/container.ts`.
- [ ] Local: mirror in `runtimes/local/src/sqlite` (the local mothership uses sqlite).
- [ ] Retention: prune revoked rows past the max token TTL in the existing retention sweep
  (Cloudflare cron ⇄ Node timer).
- [ ] Conformance: assert in `@cat-factory/conformance` that a revoked `nodeId` is rejected
  and a live one passes, against both stores.
- [ ] Changeset for every touched versioned package; flag the new table.

**Verification.** `pnpm test:run` (Node suite needs the Postgres service; the Worker/D1
suite runs on Linux/macOS). Drive a mothership persistence call with a revoked node → 403.

---

## Deferred / considered, not taken

- **Machine-token TTL shortening** — fold into item 8.
- **Master-key rotation / versioned key envelope** for `WebCryptoSecretCipher` — a larger
  operational feature (multi-key decrypt, re-seal); out of scope for this pass.
- **Durable cross-runtime rate limiter** for password + personal-password endpoints — the
  in-isolate limiter is a documented speed bump; a durable one is a separate initiative.
