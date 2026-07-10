# Security hardening — round 2

## Goal & rationale

A second cross-cutting security review (authn/authz + multi-tenancy, crypto/secrets,
SSRF/outbound, injection, and the HTTP/webhook layer) was run over the whole backend. As in
[round 1](./security-hardening.md), the codebase is **already well defended** — parameterized
queries everywhere, argv-only process execution (no shell), authenticated-encryption at rest
with per-store HKDF domain separation, a central default-deny auth gate, audience-pinned +
per-audience-keyed tokens, and (from round 1) per-hop redirect-revalidating SSRF fetch, CORS
default-deny, webhook fail-closed, and telemetry redaction.

This round found **one High cross-tenant IDOR** and a **High-ish SSRF asymmetry** (the inline
LLM path never picked up the redirect guard round 1 added to the proxy path), plus a set of
Medium/Low residual gaps. This tracker is the durable source of truth for closing them; it is
the round-2 companion to `security-hardening.md` and carries forward that pass's still-open
item 8 (machine-token revocation) as SEC-5.

Every fix lives in a **shared package** (`server`, `agents`, `integrations`, `orchestration`,
`contracts`, `executor-harness`) or a single facade's config, so cross-runtime symmetry is
preserved for free — the one exception is SEC-5, which adds a table and therefore carries the
symmetric D1 ⇄ Drizzle + conformance work (already scoped in round 1's item 8).

## Target pattern

- **Every resource identifier that crosses a trust boundary must be re-authorized at the
  boundary it enters**, not just at the outer gate. The central gate (`http/authGate.ts`)
  authorizes `/workspaces/:workspaceId/*` and `/accounts/:accountId/*` membership; any
  _secondary_ id taken from the body/query (e.g. `viaWorkspaceId`) must be independently
  checked against the gated scope. SEC-1 is the reference fix (`accountOf(id) === :accountId`).
- **Any provider that fetches an org/user-supplied URL must go through the shared
  redirect-revalidating fetch** (`integrations/.../shared/safe-fetch.ts` `safeFetch`, or
  `fetchLocalRunner` for local runners) — never a bare `fetch`/AI-SDK default fetch that
  follows 3xx unchecked. SEC-2 and SEC-7 are both "reuse the shared safe fetch" fixes.
- **Every free-text body persisted to telemetry runs through `redactSecrets`** (kernel
  `shared/redact-secrets.logic.ts`) before storage/fan-out — the `LlmObservabilityService`
  path is the reference; SEC-6 brings the agent-context path into line.

## Status checklist

Priority is fix-order (P0 = do first). Severity is impact-if-exploited.

| ID     | Item                                                               | Severity | Priority | Status  | PR  |
| ------ | ------------------------------------------------------------------ | -------- | -------- | ------- | --- |
| SEC-1  | Cross-tenant doc disclosure via unchecked `viaWorkspaceId`         | High     | P0       | ⏳ todo | —   |
| SEC-2  | Inline model-provider local-runner fetch skips redirect guard      | Med/High | P0       | ⏳ todo | —   |
| SEC-3  | Local-runner allow-list grants full RFC1918 on multi-tenant Node   | Medium   | P1       | ⏳ todo | —   |
| SEC-4  | Password throttle: per-email key fanout + spoofable XFF + per-node | Medium   | P1       | ⏳ todo | —   |
| SEC-5  | Machine-token revocation store (carry-forward round-1 item 8)      | Medium   | P1       | ⏳ todo | —   |
| SEC-6  | `agent_context_snapshots` bodies not run through `redactSecrets`   | Low      | P2       | ⏳ todo | —   |
| SEC-7  | Confluence provider keeps Basic-auth across cross-origin redirect  | Low      | P2       | ⏳ todo | —   |
| SEC-8  | Harness `contextFiles[].path` not re-validated at `writeFile` sink | Low      | P2       | ⏳ todo | —   |
| SEC-9  | Webhook + LLM-proxy bodies buffered with no explicit `bodyLimit`   | Low      | P2       | ⏳ todo | —   |
| SEC-10 | Initiative `slug` has no charset restriction                       | Low      | P2       | ⏳ todo | —   |
| SEC-11 | `safeSegment('..')` preserves a traversal segment                  | Very Low | P3       | ⏳ todo | —   |

Non-blocking notes (no code fix scoped) are listed under "Notes & accepted risks".

---

## P0 — fix first

### SEC-1 (High) — Cross-tenant document disclosure via unchecked `viaWorkspaceId`

**Where.**

- Route: `backend/packages/server/src/modules/fragmentLibrary/FragmentLibraryController.ts:124-143`
  (`createDocumentFragment`) and `:146-164` (`refreshPromptFragment`), account scope
  (mounted at `app.route('/accounts/:accountId', fragmentLibraryController('account'))`,
  `app.ts:124`).
- Guard: `accountGuard` (`FragmentLibraryController.ts:222-233`) checks only
  `accountService.requireMember(:accountId, user.id)`.
- Sink: `FragmentLibraryService.createFromDocument` (`backend/packages/agents/src/fragmentLibrary/FragmentLibraryService.ts:163-172`)
  → `DocumentContentResolverService.fetch(workspaceId, source, ref)`
  (`backend/packages/integrations/src/modules/documents/DocumentContentResolverService.ts:29-59`)
  → `connectionService.requireConnection(workspaceId, source)` loads **that workspace's stored
  connection credentials** with no membership check.

**The gap.** At the account scope, `viaWorkspaceId` comes straight from the request body
(`input.viaWorkspaceId`, line 130) or query (line 151) and is passed unvalidated to the
resolver. Nothing verifies that `viaWorkspaceId` belongs to the addressed `:accountId` (the
one membership was proven for). The workspace-scope variant is safe — it forces
`viaWorkspaceId = param('workspaceId')`, which the global gate already authorized.

**Exploit.** Any authenticated user is a member of their own personal account. Where the
documents integration is configured for another tenant:

1. `POST /accounts/<my-account>/document-fragments` with body
   `{ source: "confluence", ref: "<any page id>", viaWorkspaceId: "ws_victim" }`
   where `ws_victim` belongs to a different tenant's account.
2. `accountGuard` passes (attacker owns `<my-account>`).
3. Resolver loads `ws_victim`'s Confluence/Notion/GitHub credentials and fetches the
   attacker-chosen `ref`, using the victim's stored OAuth/API credentials as a fetch oracle.
4. The fetched body is stored as a fragment and returned via `GET .../prompt-fragments`.

Attacker-controlled `source` + `ref` widen this to arbitrary pages/repos those credentials can
reach — a cross-tenant confidentiality breach.

**Fix.** In both account-scope handlers, before calling the service, require `viaWorkspaceId`
to belong to the gated account:

```ts
const owner = await c.get('container').workspaceService.accountOf(viaWorkspaceId)
if (owner !== param(c, 'accountId')) throw new NotFoundError('Workspace not found')
```

`accountOf` already exists on the workspace repository/service (used by the auth gate itself,
`http/authGate.ts:71`). Account members are entitled to that account's workspace connections,
so equality to the gated `accountId` is sufficient. Add a `server` integration test that a
`viaWorkspaceId` outside the account 404s. Shared-package change — symmetric by construction.

### SEC-2 (Medium/High) — Inline model-provider local-runner path skips the redirect guard

**Where.** `backend/packages/server/src/agents/modelProviderResolver.ts:82-91` builds a local
endpoint resolver via `openAiCompatibleResolver({ name, apiKey, baseURL: ep.baseUrl })`
(`backend/packages/agents/src/providers/resolvers.ts:33-44`) with **no `fetch` override**, so
inline calls use the AI SDK's default fetch, which follows 3xx redirects automatically and
unchecked.

**The gap.** Round 1 hardened the **proxy** path — `LlmProxyController` forwards local-runner
calls through `fetchLocalRunner`, which drives redirects manually and re-runs
`localRunnerUrlError` on every hop. The **inline** LLM path (requirements reviewer,
task-estimator, incorporation companion — all run inline via the scoped model-provider
resolver, keyed by `scope.userId`) never got that guard, and does no fetch-time re-validation
at all (only the write-boundary check in `LocalModelEndpointService.upsert` ran).

**Exploit.** A user registers a local runner at an allowed host they control (e.g.
`http://127.0.0.1:11434/v1`, which passes `localRunnerUrlError` at write). An inline LLM call
POSTs to `…/chat/completions`; the runner replies
`302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`. The AI SDK
follows it silently, returning cloud-instance IAM credentials into the model-response path.
The proxy path blocks exactly this; the inline path does not.

**Fix.** Give `openAiCompatibleResolver` an optional `fetch` param and, at
`modelProviderResolver.ts:85`, pass `(url, init) => fetchLocalRunner(String(url), init)` for
**local endpoints only** (cloud vendors keep the default fetch). This makes the inline path
symmetric with the proxy. `createOpenAICompatible` accepts a `fetch` option, so this is a
narrow thread-through. Add a test asserting a 302-to-metadata from a local endpoint is refused
on the inline path.

---

## P1

### SEC-3 (Medium) — Local-runner allow-list grants the whole RFC1918/loopback range

**Where.** `backend/packages/integrations/src/modules/providers/localModelUrl.ts:17-51` +
`backend/packages/kernel/src/shared/ip-host.logic.ts:12-19` (`isLoopbackOrPrivateHost`).

**The gap.** The allow-list deliberately permits `localhost`, `*.local`, `*.localhost`, and
all of `10/8`, `172.16-31/12`, `192.168/16` (+ IPv6 ULA). On Cloudflare these are unroutable
(inert) and on a single-tenant local/Node box this is the intended design. But the feature
code is shared and runs on **every** Node deployment. On a **multi-tenant** Node deployment,
tenant A can register `http://192.168.0.1/` or `http://10.0.0.5:8500/` and reach internal LAN
services (admin panels, Consul/etcd, other tenants' services) directly — no redirect trick
needed, since the allow-list itself grants the internal network. (The cloud-metadata endpoint
is still blocked first by `isCloudMetadataHost`.)

**Fix.** Gate the local-runner feature to single-tenant deployments behind a config flag, or
narrow the allow-list to loopback-only unless the operator opts into LAN access. At minimum,
document that enabling local runners on a shared Node deployment is an internal-network SSRF
exposure. Decide the intended deployment model first (this is partly a product decision).

### SEC-4 (Medium) — Password throttle is bypassable and doesn't stop credential stuffing

**Where.** `backend/packages/server/src/modules/auth/AuthController.ts:247-273`
(`passwordAttemptLimited`, `clientIp`), used at `:468`, `:511`, `:696`, `:718`.

**Three compounding weaknesses.**

- **Per-node in-memory state.** The limiter is a module-global `Map`. On Cloudflare each
  isolate has its own; on Node each replica does (multi-replica is a supported deployment).
  The effective cap is `MAX_ATTEMPTS × nodes`, not 10 — the code itself calls it "a speed bump."
- **Bucket key defeats credential stuffing.** The key is `clientIp:email` (`:262`). One
  password guessed against thousands of distinct usernames from one IP gets a fresh bucket per
  email, so the cap never triggers. There is no per-IP aggregate cap and no account lockout.
- **Spoofable client IP.** `clientIp` falls back to `x-forwarded-for` (`:254`), which is
  attacker-controlled on a Node deployment not behind a trusted proxy that overwrites it — so
  an attacker rotates XFF for unlimited fresh buckets even against a single account.

PBKDF2 per-attempt cost is the only real backstop today.

**Fix.** Back the limiter with a durable cross-runtime store (D1/Postgres) — the round-1 doc
already deferred this as a "separate initiative", but the per-email fanout + XFF-spoof angle
raises its priority. Add a **per-IP aggregate** counter independent of email, and on Node only
trust `x-forwarded-for` when an explicit trusted-proxy flag is set (else use the socket peer).
Consider a coarse account-lockout / CAPTCHA step after N failures.

### SEC-5 (Medium) — Machine-token revocation store (carry-forward: round-1 item 8)

Still open from `security-hardening.md` item 8. `mintMachineToken` issues a 30-day,
`machine`-audience token for a mothership-mode node (`POST /internal/persistence`); `nodeId`
is minted "for future revocation" but nothing checks it — a leaked token grants account-scoped
persistence RPC for up to 30 days with no kill switch. Full checklist (new
`MachineTokenRevocationRepository` port, `PersistenceController` check, D1 ⇄ Drizzle ⇄ local
sqlite table, retention prune, conformance assertion, revoke endpoint) lives in
`security-hardening.md` under "Item 8". Also consider shortening
`DEFAULT_MACHINE_TOKEN_TTL_MS` (`backend/packages/server/src/auth/machineToken.ts:11`).

---

## P2 — defense-in-depth / low severity

### SEC-6 (Low) — `agent_context_snapshots` bodies not run through `redactSecrets`

`backend/packages/orchestration/src/modules/observability/AgentContextObservabilityService.ts:112-128`
applies only size-clamping (`budget()`) to `systemPrompt`, `userPrompt`, `fragments[].body`,
and `contextFiles[].content` — it never calls `redactSecrets`, unlike the sibling
`LlmObservabilityService.record` on the same telemetry store. `contextFiles[].content` is
materialized from user-linked docs (PRD/RFC) and tracker issues, which frequently contain
pasted keys. With `LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` toggle on (default
on), such a secret is stored verbatim where the LLM-metrics path would have redacted it.

**Fix.** Wrap each body through the shared `redactSecrets` (a `@cat-factory/kernel` export) as
the LLM path does, e.g. `systemPrompt: budget(redactSecrets(input.systemPrompt) ?? '')`, and
the same for `userPrompt`, each `fragments[].body`, and each `contextFiles[].content`. Keep it
O(n) — see the round-1 gotcha about greedy quantifiers before a required literal.

### SEC-7 (Low) — Confluence provider keeps Basic-auth across a cross-origin redirect

`backend/packages/integrations/src/modules/documents/ConfluenceProvider.ts:44-64`'s local
`safeFetch` re-runs `assertSafe` (host must be public/non-private) on each hop but keeps the
Basic-auth header across a redirect to a **different public** host (it never drops the body or
credential headers cross-origin, unlike the shared `safe-fetch.ts`). A compromised/malicious
configured Atlassian site could 302 to an attacker-controlled public host and receive the
workspace's Basic-auth token. Low because the site URL is org-admin-supplied.

**Fix.** Reuse the shared `safeFetch` from `modules/shared/safe-fetch.ts` (which strips
`Authorization`/`cookie` and drops the body on a cross-origin hop) instead of the local copy.

### SEC-8 (Low, defense-in-depth) — Harness `contextFiles[].path` not re-validated at the sink

`backend/internal/executor-harness/src/pi.ts:233` — `writeFile(join(dir, f.path), ...)` in
`materializeContextFiles` trusts `f.path`, a bare `v.string()`
(`backend/packages/contracts/src/observability.ts:185`, despite its "Sanitized basename"
comment). Not currently exploitable: the only producer, `contextFileName`
(`backend/packages/server/src/agents/ContainerAgentExecutor.ts:385-396`), slugifies to
`[a-z0-9-]` (no dots/slashes survive), and the harness `/run` endpoint is shared-secret
authenticated. But a future/alternate producer that skips sanitizing would let
`path: "../../../../etc/whatever"` escape `.cat-context/`.

**Fix.** Re-validate in `materializeContextFiles`: reject any `f.path` that is absolute or
whose `path.relative(dir, resolve(dir, f.path))` starts with `..` (mirror the guard already in
`FilesystemBinaryBlobBackend.pathFor`).

### SEC-9 (Low) — Webhook + LLM-proxy bodies buffered with no explicit `bodyLimit`

`GitHubWebhookController.ts:23` and `VcsWebhookController.ts:46` do `await c.req.arrayBuffer()`
on unauthenticated public routes before HMAC verification (HMAC-over-body inherently needs the
full body, so it can't be verified-first), and `LlmProxyController.ts:120` does
`await c.req.json()` — none wrap `bodyLimit(...)` the way the artifact-upload routes do
(`HarnessArtifactController.ts:39`, `ArtifactController.ts:49`). An anonymous caller can pin
memory up to the platform request limit (CF ~100 MB / Node default).

**Fix.** Add an explicit `bodyLimit` to each — GitHub webhook payloads are bounded (~25 MB); a
proxy limit consistent with the upload routes. Low because platform limits already bound it.

### SEC-10 (Low, within-repo only) — Initiative `slug` has no charset restriction

`backend/packages/contracts/src/initiative.ts:34` — `idField` is length-only (no regex). The
slug feeds `initiativeDocDir(slug)` = `docs/initiatives/<slug>` and the tracker/JSON/version
paths committed via `RepoFiles.commitFiles`
(`backend/packages/agents/src/repo-ops/initiative.ts:281,436,438`). Impact is bounded: `RepoFiles`
is a checkout-free Git-Data API facade, so a `../` in a slug is a git-tree path (can't escape
the repo), and an agent with commit rights can already write anywhere in the repo — a
data-hygiene issue, not a traversal vuln.

**Fix.** Constrain `idField` (or at least the slug) to a kebab grammar like
`/^[a-z0-9][a-z0-9-]*$/`, matching the other slug fields in `contracts/src/primitives.ts:255`.

### SEC-11 (Very Low, not reachable) — `safeSegment('..')` preserves a traversal segment

`backend/internal/executor-harness/src/pi-workspace.ts:81-83` — `safeSegment` allows dots, so
`safeSegment('..')` returns `..` unchanged; used at `:122` in
`join(persistentWorkspaceRoot(), safeSegment(repo.owner), safeSegment(repo.name))`. Not
exploitable: `repo.owner`/`repo.name` are server-resolved from the VCS projection and neither
provider permits an owner/repo literally named `..` (and a single `..` can't escape alone).

**Fix (hardening).** Treat `.`/`..` as reserved: `if (out === '.' || out === '..') return '_'`.

---

## Notes & accepted risks (no code fix scoped)

- **`/vcs` webhooks are unreachable when auth is enabled (functional bug, fails closed).** The
  neutral VCS webhook route is **not** in `PUBLIC_PREFIXES` (`http/authGate.ts:25`), unlike
  `/github`, so on an auth-enabled deployment the session gate 401s GitLab's delivery before
  the controller's own signature check. No security exposure (fails closed), but the receiver
  is effectively dead. Add `/vcs` to `PUBLIC_PREFIXES` — it does its own HMAC/token
  verification, exactly like `/github`. (Worth folding into the SEC batch since it's one line.)
- **Workspace-scoped routes gate on membership, not role.** Sensitive per-workspace actions
  (vendor credentials, workspace API keys, workspace settings) are protected by workspace
  membership but not an admin-role check (contrast account-scoped keys, which `requireAdmin`).
  Likely an intentional "workspace members are trusted" design; confirm against the product's
  role model. Not a confirmed vuln.
- **Per-run subscription activation is single-encrypted for ≤12h** (system key only, password
  layer dropped) so async container steps can lease it —
  `PersonalSubscriptionService.ts:202-222`. By design and bounded (TTL sweep + `clearRun` on
  terminal); the one window where the double-encryption collapses. Accepted.
- **DNS rebinding / `*.local` name-based bypass on the local-runner guard** — both the write
  guard and `fetchLocalRunner` validate the hostname string, not the resolved socket peer IP
  (`ip-host.logic.ts:6-9` says as much); `*.local`/`*.localhost` are accepted unconditionally.
  Requires local-network/DNS control; documented out-of-scope. Revisit if the feature is ever
  exposed multi-tenant (see SEC-3) — then resolve + re-check the peer IP.
- **Loopback post-login redirect** intentionally allows the session token to land on
  `localhost`/`127.x`/`::1` for mothership→local-node flows (`AuthController.ts:104`); implies
  local compromise to abuse. Accepted design.
- **Round-1 deferred items** (master-key rotation / versioned key envelope for
  `WebCryptoSecretCipher`; the durable rate limiter now partly SEC-4) remain as listed in
  `security-hardening.md`.

## Conventions & gotchas carried forward

- **Re-authorize every secondary id from the body/query against the gated scope** (SEC-1). The
  outer gate only proves the `:accountId`/`:workspaceId` in the _path_; a `viaWorkspaceId`,
  target block id, etc. taken from the payload is a fresh trust boundary.
- **Never hand a bare `fetch` (or the AI-SDK default fetch) an org/user-supplied URL.** Route
  it through the shared `safeFetch` / `fetchLocalRunner` so redirects are revalidated per hop
  and credentials are stripped cross-origin (SEC-2, SEC-7). The proxy path being hardened does
  not mean a parallel inline path is.
- **Keep `redactSecrets` on _every_ telemetry body sink** (SEC-6) — a new sink that stores
  prompt/file text must scrub, not just clamp. And keep the rules O(n) (round-1 gotcha).
- **Re-validate filesystem paths at the `writeFile` sink** even when an upstream producer
  sanitizes (SEC-8) — the contract type (`v.string()`) is the real boundary, not a comment.

## Verification

Per touched package: `pnpm exec turbo run typecheck --filter=<pkg>` and `pnpm test:run` (the
Node suite needs the Postgres service; Worker/D1 runs on Linux/macOS). Add a regression test
with each fix (SEC-1: cross-account `viaWorkspaceId` → 404; SEC-2: local-endpoint
302-to-metadata refused inline; SEC-6: a secret in a context-file body is redacted at rest).
Add a changeset for every touched versioned package.
