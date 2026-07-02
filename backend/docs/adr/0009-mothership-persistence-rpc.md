# ADR 0009: Mothership mode delegates state through a local-node persistence RPC, not direct frontend-to-mothership calls

- **Status:** Accepted
- **Date:** 2026-07-01
- **Context layer:** local/node facades (`@cat-factory/local-server`, `@cat-factory/node-server`), the `@cat-factory/server` persistence RPC, and the Nuxt SPA
- **Related:** `docs/initiatives/mothership-mode.md` (delivery tracker), ADR 0002 (Cloudflare platform)

## Context

Local mode runs the whole product on a developer's machine. Historically that meant the
Node facade's own Postgres + pg-boss, so a developer's work was **siloed in their laptop
database** — no collaboration on shared org projects and durability resting on a local DB.

**Mothership mode** keeps local mode's fast differentiators (local per-run agent containers,
local execution, the SPA served from localhost) but **delegates all org/durable state to a
hosted "mothership" cat-factory** (Node *or* Cloudflare) over an authenticated
machine-to-machine API. There is no Postgres on the laptop; org data lives on the mothership,
so a local developer participates in the same shared org projects as hosted teammates.

This raises one load-bearing design question: **where does the local↔mothership boundary
sit, and what does the SPA talk to?** Two shapes are possible:

- **(A) The local node is the SPA's single backend**, and org persistence is delegated to
  the mothership *underneath* it, at the repository layer. *(chosen)*
- **(B) The SPA targets the mothership directly for CRUD**, and talks to the local node only
  for execution-specific things.

This ADR records why we chose (A) and what we accept in return.

## Decision

The local node is the SPA's **single backend** (same origin). Org/durable persistence is
delegated to the mothership through a **repository-level machine RPC**, not through the SPA:

| Concern | Mothership mode mechanism |
| --- | --- |
| SPA → backend | One origin: the SPA only ever calls its **local node** (`NUXT_PUBLIC_API_BASE` = localhost). No knowledge of the mothership URL in the request path. |
| Org/durable persistence | `POST /internal/persistence` — a machine-authed RPC in `@cat-factory/server` that reflects over the mothership's real repository registry. Body `{ repo, method, args }` → `{ result }`. |
| Local composition | `composeMothership` builds `createRemoteRepositoryRegistry(client)` — a `Proxy`-backed full-surface `CoreRepositories` where every entry forwards to the RPC — and `buildLocalContainer` threads it into `buildNodeContainer` with `db: undefined`. Credentials stay local (`node:sqlite`). |
| Security gate | Default-deny per-repo method **allow-list** (`REMOTE_PERSISTENCE_METHODS`) + **account scope binding** (resolve the arg's owning account, reject out-of-scope as 404) + a `machine` token audience. Admin-gated mutations and global sweeper reads are excluded. |
| Auth/login | The **only** direct SPA↔mothership interaction is the OAuth login round-trip. The SPA captures the mothership session from the redirect fragment and hands it to its **own** node (`POST /local/mothership/connect`, same origin, no CORS), which exchanges it for a cached opaque machine token and mints a **local** session for the SPA. |
| Durable execution | Runs execute **locally** in this process via `SqliteWorkRunner` → `driveExecution` (the no-Postgres pg-boss analogue), reading/writing org state over the same remote `CoreRepositories`. |

The SPA never issues a CRUD call to the mothership. Persistence is delegated one layer below
the SPA — at the repository port — so the SPA, the HTTP controllers, and the local engine all
operate against one composed `CoreRepositories`.

## Rationale

### 1. The engine is the primary consumer, and it lives at the repository layer

The decisive fact: the RPC's main consumer is **not the SPA** — it's the local orchestration
engine. Agent runs execute in local containers here, and `driveExecution` advances a run *in
this process*, reading and writing blocks, executions, notifications, and requirement reviews
against `CoreRepositories` as it goes. That local↔mothership persistence path **must exist
regardless of what the SPA does.** So the repository RPC isn't overhead added for the SPA — it
is the engine's substrate, and routing SPA CRUD through the same controllers/repositories is
nearly free. Design (B) would not remove this path; it would add a *second, parallel* one.

### 2. One origin for the SPA

The SPA talks to exactly one backend: its own local node, same origin, one session token,
no CORS. Design (B) forces the browser to hold **two** auth contexts (a mothership session
*and* a local session), requires the mothership to open CORS to arbitrary `localhost`
origins, and pushes per-call host routing into the client. That is split-brain in the SPA
for no product gain.

### 3. One real-time stream

The local node merges upstream org events (the mothership fan-out) and local run events into
a **single** WebSocket to the SPA, over the unchanged wire protocol. Design (B) would need
two WS connections (mothership for org activity, local for run activity), client-side event
merge, and cross-origin WS-ticket auth.

### 4. Writes are entangled with local side effects

Much of what looks like "CRUD" is not pure. Creating or reparenting a block, starting a run,
and settling a decision all kick the **local** work queue, emit **local** events, and drive
the **local** engine. If the SPA wrote those straight to the mothership, the local engine
would never observe them and the local runner would never be kicked. The boundary does not
cleanly fall between "CRUD" and "execution", so (B)'s partition is a footgun: any endpoint
with a subtle local side effect, if routed remotely, silently desyncs the local engine.

### 5. A narrow, hardened, default-deny machine boundary

`/internal/persistence` is a deliberately small, auditable surface: a machine-token audience,
a per-repo-method allow-list, per-call account scoping that fails closed on any unknown rule,
and own-property-only table lookup so an attacker-supplied `__proto__`/`constructor` can't
reach a non-spec member. The machine token scopes **accounts, not roles**, which is exactly
why admin-gated mutations are excluded. Design (B) instead exposes the mothership's *full
public HTTP API* to a browser-held session cross-origin — a far larger, harder-to-reason-about
attack surface.

### 6. Drift-proof, uniform composition

`createRemoteRepositoryRegistry` is a single `Proxy` that lazily forwards the *entire*
`CoreRepositories` surface to one RPC, so there is nothing per-repo to hand-maintain on the
client; the server allow-list is the only gate. The cross-runtime conformance suite runs its
execution assertions against a real mothership-mode node (the `[mothership]` config), so a
mis-scoped or non-serializing repository method fails an existing test rather than shipping.
A facade cannot silently diverge.

## Alternatives considered

- **(B) Frontend targets the mothership directly for CRUD** — the alternative that prompted
  this ADR. Its one genuine advantage is real: it would let pure, side-effect-free CRUD hit
  the mothership's existing **session-authed public controllers**, getting service-layer
  validation for free and side-stepping the per-method `REMOTE_PERSISTENCE_METHODS`
  allow-list (the bulk of the Phase-3 grind). But it does **not** remove the repository RPC
  (the local engine still needs org-state access — Rationale 1), so it is additive, not a
  replacement; and it imposes CORS + dual sessions + dual WebSockets + a fragile
  CRUD/execution partition (Rationale 2–4). Net: more moving parts and a new class of
  desync bug, to save allow-list toil on a subset of endpoints. Rejected as the primary
  design.

- **HTTP/controller-level passthrough** — a middle path: keep the SPA on one origin, but have
  the local node forward *whole authed requests* to the mothership for a designated set of
  pure-CRUD controllers, collapsing the gate from per-method to per-controller. This is the
  most promising way to cut allow-list toil **without** the dual-backend costs. It is not
  adopted now because the mothership would need the **caller's role** to authorize a
  forwarded request, but the machine token deliberately scopes accounts, not roles (the same
  reason admin mutations are off the RPC today). Adopting it requires first adding a
  role/identity dimension to the machine token. Recorded as a viable future optimization if
  the allow-list maintenance becomes painful.

- **Keep a local Postgres (status quo before mothership mode).** Rejected: it is the exact
  problem mothership mode exists to solve — siloed per-laptop state, no cross-developer
  collaboration on shared org projects, and durability resting on a laptop database.

## Consequences

- **The per-method allow-list is ongoing maintenance.** Every new board-load/run repository
  method must be allow-listed with a correct scope rule (the Phase-3 slice work). We accept
  this cost; a static drift guard (`runtimes/node/test/mothership-allowlist.spec.ts`) forces
  every Drizzle method to be either allow-listed or explicitly classified, and conformance
  keeps behaviour honest. The controller-passthrough alternative above is the escape hatch if
  the toil outgrows its value.
- **`db: undefined` routing is a standing correctness hazard.** Repos that `buildNodeContainer`
  would build directly from `db` must route to the remote surface in mothership mode via the
  `pickRepoSource` seam; a missed one throws only when *called* on a board load or run. Guarded
  by `mothership-repo-source.spec.ts` and the fake-mothership integration test.
- **The `/internal/persistence` surface is the highest-risk new code** and is treated as such:
  default-deny, account-scoped, fail-closed.
- **Two encryption domains.** The mothership's `ENCRYPTION_KEY` never reaches the laptop; local
  secrets use a separate local key, and the RPC never carries the mothership key.
- **Cross-cutting concerns need explicit delegation channels, not repo proxies.** Keeping the
  SPA on one backend means real-time (`RpcEventPublisher` / `UpstreamEventSubscriber`), email
  (`RemoteEmailSender`), Slack, and telemetry ingest are delegated over their own `/internal/*`
  endpoints rather than falling out of the persistence proxy.
