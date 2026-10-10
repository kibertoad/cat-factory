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
free: the one exception is the machine-token revocation store (item 8), which adds a table
and therefore carries the symmetric D1 ⇄ Drizzle + conformance work.

## Status checklist

| #   | Item                                                  | Severity | Status  | PR         |
| --- | ----------------------------------------------------- | -------- | ------- | ---------- |
| 1   | Local-runner `fc`/`fd` hostname SSRF bypass           | High     | ✅ done | SSRF PR    |
| 2   | Runner-pool + `probeConnection` redirect revalidation | High     | ✅ done | SSRF PR    |
| 3   | SearXNG web-search upstream SSRF guard                | Medium   | ✅ done | SSRF PR    |
| 4   | Local-mode secret minimum length                      | Medium   | ✅ done | Tier-2 PR  |
| 5   | GitHub webhook empty-secret fail-closed               | Low      | ✅ done | Tier-2 PR  |
| 6   | CORS default-deny in production                       | Low      | ✅ done | Tier-2 PR  |
| 7   | LLM telemetry secret redaction + per-workspace gate   | High     | ✅ done | Tier-3 PR  |
| 9   | HKDF per-audience token key separation                | Medium   | ✅ done | Tier-3 PR  |
| 8   | Machine-token revocation store                        | Medium   | ✅ done | round-2 P1 |

## What shipped (items 1–7, 9)

- **SSRF (1–3):** `localModelUrl` now reuses the kernel `ip-host` primitives and gates the
  IPv6-ULA test behind an is-literal check; a shared `modules/shared/safe-fetch.ts` gives the
  runner-pool + environment providers (and `probeConnection`) per-hop redirect revalidation +
  a streamed byte cap, AND drops the request body + strips credential headers on any
  cross-origin redirect hop (so a permitted host can't bounce the secrets to a _different_
  public host: re-establishing the cross-origin stripping the manual redirect follower had
  bypassed); the account-configured SearXNG URL is guarded at the write boundary
  (`AccountSettingsService.write`) and on every fetch hop (public host, http/https, no
  private/internal/metadata target).
- **Boundary hardening (4–6):** local mode rejects a `<32`-char `AUTH_SESSION_SECRET` and a
  `<32`-byte `ENCRYPTION_KEY` at config load; `WebCryptoWebhookVerifier` fails closed on an
  empty secret; CORS reflects an unset allowlist only in a non-production `ENVIRONMENT`
  (`corsReflectsWhenUnset`), threaded through both facades.
- **Telemetry redaction (7):** a shared `redactSecrets` (promoted to
  `kernel/src/shared/redact-secrets.logic.ts`, reused by the provisioning-log path) scrubs
  credential shapes from `promptText`/`responseText`/`reasoningText` AND `errorMessage`
  (the one exchange field kept as metadata when bodies are dropped, and fanned out ungated)
  before they are stored or fanned out to Langfuse; body capture is additionally gated on the
  per-workspace `storeAgentContext` toggle (numeric telemetry always records). Fixed a latent
  O(n²) backtrack in the URL-userinfo rule (bounded the scheme quantifier) surfaced by large
  prompts.
- **Key separation (9):** `HmacSigner` derives an independent HKDF-SHA256 subkey per token
  audience (`info = "cat-factory:token:<aud>"`), so each token class is cryptographically
  isolated; audience-less, or unrecognised-audience, payloads fall back to the raw-secret
  key (tests/legacy). Derivation is bounded to the fixed known-audience set because `verify`
  picks the key from the token's attacker-controlled claimed `aud` before the MAC check, so an
  unbounded set of junk audiences must NOT each mint+cache a subkey (CPU/memory DoS).

## Conventions & gotchas carried forward

- **`redactSecrets` is O(n): keep it that way, and put the required literal FIRST.** Any new
  rule with a greedy `X*` before a required literal (e.g. a scheme before `://`) backtracks
  quadratically on long repetitive input (real LLM prompts are large), so such quantifiers are
  bounded (`{0,39}`). Bounding is only half of it: a bounded run in the LEADING position is
  still re-walked at every offset, which is linear with a 40x constant and made the scheme rule
  cost ~15x more on base64 than on prose. Lead with the literal instead and match the prefix in
  a lookbehind, so a non-matching offset is rejected on one character comparison; the prefix
  then survives in the output untouched rather than being re-emitted by the replacement.
- **A DELIMITED BLOCK is scanned marker-to-marker, never matched as one regex.** A rule
  spanning `START … [\s\S]*? … END` looks safe because the lazy body is bounded by a literal,
  but only when the END is THERE: a START with none after it scans to end-of-string, then the
  next START rescans the same tail, which is quadratic in unterminated STARTs rather than a bad
  constant (2MB of bare PEM headers took ~19s). Truncation upstream of the scrub produces that
  input for free, since a capped context file can lose its closing marker. Walk the two markers
  in lockstep instead (`redactPrivateKeyBlocks`): each scan only moves FORWARD, and the first
  START with no END ends the whole pass, because no later START can have one either.
- **Shape-independence is measured, not enforced.** A test scrubs each known-pathological shape
  (base64, unterminated PEM headers, single-character filler) and asserts it stays within 4x
  prose of the same size, rather than asserting an absolute budget that a slow CI box would
  flake on. Both defects above were ~10x and ~1000x, so the margin is wide. It only covers the
  shapes listed in it, so a new rule owes the test the shape that would expose ITS worst case.
  Do not read a high ratio as automatically a bug: a body full of real credentials is ~10x
  prose because it is doing redaction work, which is why every shape in the test is
  credential-free.
- The SSRF `safeFetch` takes an injected `assertSafe` + error factory (and an optional
  `doFetch` for tests). Reuse it for any new provider that fetches an org-supplied URL;
  don't reintroduce a bare `fetch` with `redirect: 'follow'`. It also strips the body +
  credential headers on a cross-origin redirect: a manual `redirect: 'manual'` follower must
  do this by hand, since it loses the platform fetch's built-in cross-origin credential
  stripping.
- CORS reflect-when-unset is **opt-in** on an explicitly recognised development `ENVIRONMENT`
  (`development`/`dev`/`test`/`testing`/`local`/`e2e`); unset/unknown/production all
  default-deny (fail safe). e2e/dev set their own `CORS_ALLOWED_ORIGINS`, so they're
  unaffected regardless.
- Any signer/verifier that selects a key from a claimed, attacker-controlled field BEFORE the
  MAC check must bound the derive/cache to a known finite set: else the field is an
  unbounded cache-growth + per-request-derivation DoS (`HmacSigner.keyFor`).

---

## Item 8: Machine-token revocation (DONE, landed via round 2's SEC-5)

**Problem.** `mintMachineToken` issues a 30-day, `machine`-audience HMAC token for a
mothership-mode local node (presented on `POST /internal/persistence`). `nodeId` was minted
"for future revocation" but nothing checked it: a leaked token granted account-scoped
persistence RPC for up to 30 days with no kill switch.

**What landed (see `security-hardening-round-2.md`, "Landed (the P1 PR)").** The design
grew one deliberate step beyond the sketch below: a bare tombstone table cannot answer WHO
may revoke a nodeId, so the store is a machine-node ROSTER (`machine_nodes`, kernel
`MachineNodeRepository`) recorded on every mint, which is what makes the revoke endpoint
owner-scopable. The check lives in the shared `verifyMachineRequest` gate, applied to ALL
eight `/internal/*` machine surfaces (not only `PersistenceController`: the GitHub token
delegation mint was the one that mattered most) plus the WS subscribe handshake. Endpoints:
`GET /auth/machine-nodes` + `POST /auth/machine-nodes/:nodeId/revoke` (404 for unknown or
foreign, idempotent 204). D1 `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`; pruned by
both retention sweeps once past the latest signed `exp`; parity via `defineMachineNodeSuite`;
classified mothership-internal in the RPC drift guard. No local-sqlite mirror was needed: the
satellite is the machine-API CLIENT (its only nodeId store is its own cached token), and a
local process acting as a mothership runs the Node/Postgres path.
`DEFAULT_MACHINE_TOKEN_TTL_MS` stays 30 days: with the kill switch landed, shortening it
would only add reconnect friction.

---

## Deferred / considered, not taken

- **Machine-token TTL shortening**: fold into item 8.
- **Master-key rotation / versioned key envelope** for `WebCryptoSecretCipher`: a larger
  operational feature (multi-key decrypt, re-seal); out of scope for this pass.
- **Durable cross-runtime rate limiter** for password + personal-password endpoints: the
  in-isolate limiter is a documented speed bump; a durable one is a separate initiative.
