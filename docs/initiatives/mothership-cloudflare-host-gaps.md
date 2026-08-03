# Investigation: mothership mode against a CLOUDFLARE mothership

**Status:** investigation complete, no code landed · **Owner:** core · **Started:** 2026-08-03

> Companion to [`mothership-mode.md`](./mothership-mode.md), which is the initiative's durable
> source of truth. That tracker states product decision 1 — "**mothership target: both Node +
> Cloudflare**" — and every `/internal/*` slice has since been landed symmetrically on both
> facades. This document asks the question the symmetry rule does not: with both facades wired,
> what still behaves DIFFERENTLY (or wrongly) when the mothership is a **Cloudflare Worker + D1**
> rather than a Node server + Postgres?
>
> Findings are ordered by severity. Each names the evidence, why it is Cloudflare-shaped, and a
> fix DIRECTION — none of them is implemented here. Two of the five are host-agnostic gaps that
> this investigation surfaced on the way; they are kept because they compound with the
> Cloudflare-specific ones and because the tracker records no decision about either.

## Summary

| #                                                              | Gap                                                                  | Severity | Cloudflare-specific?                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | -------- | ------------------------------------------ |
| [1](#1-the-mothership-cron-sweeper-hijacks-a-satellites-run)   | The mothership's cron sweeper re-drives a run a satellite is driving | High     | No — but Cloudflare makes it unconditional |
| [2](#2-the-satellites-own-stale-run-recovery-is-dead)          | The satellite cannot recover its own dropped runs                    | High     | No                                         |
| [3](#3-d1s-2-mb-row-limit-permanently-stalls-telemetry-ingest) | D1's 2 MB row cap permanently stalls a run's telemetry sync          | High     | **Yes**                                    |
| [4](#4-nothing-tests-a-cloudflare-mothership)                  | No test anywhere exercises a Cloudflare mothership                   | Medium   | **Yes**                                    |
| [5](#5-the-github-delegation-rate-limit-is-per-isolate)        | The mint rate limit is per-isolate, i.e. barely a limit on Workers   | Medium   | **Yes**                                    |

Plus [what was checked and is genuinely fine](#checked-and-fine) and
[Cloudflare ceilings worth knowing](#cloudflare-ceilings-the-machine-api-now-sits-near).

## 1. The mothership cron sweeper hijacks a satellite's run

**What happens.** Every mothership runs a stale-run sweeper over the unified `agent_runs` table,
across all workspaces. On Cloudflare that is `redriveStuckAgentRuns`
(`runtimes/cloudflare/src/index.ts:370`, on the 2-minute cron) driving `sweepStuckRuns`
(`runtimes/cloudflare/src/infrastructure/workflows/sweeper.ts`) with `SWEEP_LEASE_MS = 5 min`. For
each `running` run whose lease is stale it asks `WorkflowsLookup.instanceState(runId)` — "does a
Workflows instance exist for this run?" — and re-creates one when the answer is `missing`.

A satellite-driven run is a normal `agent_runs` row on the mothership (the satellite writes it over
the persistence RPC), and **no Workflows instance for it has ever existed**: the laptop drives it
with its own `SqliteWorkRunner`. So `instanceState` is `missing` by construction, and the sweeper's
verdict is not "this run was dropped" but "this run is not being driven BY ME" — a distinction the
table has no column to record.

**Consequences, once the mothership takes the run:**

- It advances the run on the WRONG infrastructure. The step's `RunnerJobRef` points at a container
  on the developer's machine, and the run's model credentials are laptop-local by design (product
  decision 3 — the agent/model credentials never leave the node). The mothership either fails the
  step or re-dispatches it into its own container transport, duplicating agent work against the
  same branch.
- When the laptop comes back it still holds the run in its own durable queue, so two drivers now
  advance one execution and contend on the `rev` CAS.
- `finalizeOrphan` (a `terminal` instance) calls `executionService.stopRun`, and `failStalled`
  flags the run `stalled` after `SWEEP_HARD_STALL_MS` (1 h) — both against a run the mothership
  never drove.

**Why it isn't already firing constantly.** A healthy satellite refreshes the lease: the container
poll folds `lastActivityAt` on a 20 s throttle (`ACTIVITY_PERSIST_THROTTLE_MS`,
`packages/orchestration/src/modules/execution/job.logic.ts:72`), and that constant is documented as
"chosen well under the stale-run sweeper's 5-minute lease". That reasoning holds for a server. It
does not hold for the deployment shape this initiative exists to serve: a laptop that sleeps, is
closed, or drops off the network for five minutes mid-run is ordinary, not a fault — and that is
exactly the state the sweeper reads as an orphan.

**Not only Cloudflare.** A Node mothership does the same thing: `classifyAdvanceJob`
(`runtimes/node/src/execution/reclaim.ts`) returns `missing` for a satellite run (there is no
pg-boss job on the mothership) and the sweeper re-sends `execution.advance`. Cloudflare is called
out because its classifier has no equivalent of pg-boss's `heartbeat_on` to consult — the Workflows
lookup can only ever answer about ITS OWN instances — so on Cloudflare the misclassification is
unconditional rather than incidental. The same shape applies to `sweepStuckEnvTests`
(`runtimes/cloudflare/src/index.ts:474`) for satellite-driven environment self-tests.

**Fix direction.** `agent_runs` has to record its DRIVER, not just its lease: stamp the machine
token's `nodeId` (or a `driver: 'satellite'` discriminator) at hand-off, mirrored D1 ⇄ Drizzle with
a conformance assertion, and teach both sweepers to treat a satellite-driven run as a THIRD state —
never re-driven onto mothership infrastructure, surfaced instead as "the node driving this run has
been unreachable for N minutes" (the loud-degradation rule: a node offline and a run dropped are
different facts and need different fixes). That column is also what finding 2 needs.

## 2. The satellite's own stale-run recovery is dead

`SqliteWorkRunner.reconcileStorage` (`runtimes/local/src/mothership.ts:628`) is the satellite's half
of pg-boss-style durability: re-enqueue any run storage still reports `running` that has no local
queue row. In mothership mode its `agentRunRepository.listStale` call goes to the remote registry,
where `listStale` is deliberately classified `sweeper` and is NOT allow-listed — so the call throws
`unknown_method` on every tick and the code swallows it, as its own comment says ("the remote
`agentRunRepository` may not yet allow-list `listStale` (mothership gating phase), so a throw is
swallowed").

So the reconciler has never run in mothership mode. Combined with finding 1, run recovery is
inverted: the node that owns the run cannot recover it, while the mothership that cannot drive it
will.

The same shape costs the satellite its container reaping: `buildLocalContainer` reaps per-run
containers left behind by a crashed previous process via
`repos.agentRunRepository.liveRunIds(ids)` (`runtimes/local/src/container.ts:613`), also
sweeper-classified and un-allow-listed, so in mothership mode it always throws into a warning and
orphaned containers accumulate on the developer's machine.

**Fix direction.** Neither method can be allow-listed as-is — both are unscopable, cross-account
reads. Both become scopable the moment finding 1's driver column exists: a node-scoped
`listStaleForNode(nodeId, olderThan)` and a workspace/account-scoped `liveRunIds` binding through
the token's own scope answer the satellite's question without exposing the sweeper's. This is the
same "NARROW THE READ rather than widen the surface" move the tracker records for
`accountSettingsRepository.getConfigByAccount`.

## 3. D1's 2 MB row limit permanently stalls telemetry ingest

**The collision.** An agent-context snapshot is budgeted at
`MAX_AGENT_CONTEXT_TOTAL_CHARS = 4 MiB`
(`packages/orchestration/src/modules/observability/AgentContextObservabilityService.ts:34`) — one
row holding the whole composed prompt plus every injected `.cat-context/*` file, as
`D1AgentContextSnapshotRepository` itself notes ("a single snapshot can be megabytes"). D1's
documented ceiling is **2,000,000 bytes for a string, BLOB or table row**. The capture ceiling is
therefore a Postgres-sized constant applied to a store that cannot hold it.

**Why mothership mode turns that into a stall rather than a loss.** On the mothership's own capture
path the write is best-effort and swallowed, so an oversized snapshot is silently dropped (bad, but
quiet and self-limiting). The ingest path has no such exit:

- The satellite's only size guard is `MAX_TELEMETRY_INGEST_CHARS` (8 M chars) — a 2–4 MB snapshot
  passes it, so it is never classified as the "oversized row, skip and REPORT" case.
- The controller's caps are row COUNT and body CHARS
  (`packages/server/src/modules/telemetry/TelemetryIngestController.ts`); neither knows about D1's
  row ceiling. The `recordMany` throws and the handler correctly returns **500**.
- The sweep's `catch` leaves the run's high-water mark alone and retries next pass
  (`runtimes/local/src/telemetryIngest.ts`), which is right for a transient failure and wrong for a
  permanent one: **the same doomed row is re-posted every 5 minutes forever**, until the local
  retention prune eventually deletes it.
- Because the mark is written only once EVERY sink has drained, the run's metrics and search
  queries — drained before the snapshot that fails — are re-uploaded on every pass and never
  marked. One oversized snapshot costs the whole run's telemetry upstream, permanently.

This is exactly the failure mode the tracker already records for the byte cap ("413 forever, the
same doomed page every sweep") — reintroduced through a limit that belongs to the mothership's
STORE rather than to its wire contract.

**Adjacent, same cause.** An `llm_call_metrics` row carries three `MAX_BODY_CHARS` (512 KiB) bodies
plus a prompt delta; ~1.5 M chars of non-ASCII text exceeds 2,000,000 BYTES, so metric rows can hit
the same wall on multibyte-heavy runs.

**Fix direction.** Two halves, and both are needed:

1. Make the capture ceiling store-aware rather than global — the facade that owns the sink declares
   what one row may hold (D1: comfortably under 2 MB counted in BYTES, not chars), and the
   truncation states what it dropped.
2. Give the ingest a REFUSE-don't-retry disposition for a row the mothership can never store: a
   distinguishable status (413 with a per-row reason, not a bare 500) that the sweep treats like
   its existing oversize case — skip the row, report it by id, and let the rest of the run drain —
   so one row cannot hold a run's telemetry hostage.

## 4. Nothing tests a Cloudflare mothership

Every mothership-mode assertion in the repo runs against a **Node/Postgres** mothership or against
stubs:

- The `[mothership]` conformance config and `runtimes/local/test/mothership-integration.spec.ts`
  boot a real in-process **Node** mothership.
- `runtimes/node/test/mothership-allowlist.spec.ts:770` — the drift guard, including "every
  allow-listed method exists on its repository" — reflects the **Drizzle** classes only.
- `packages/server/test/persistenceRpcSurfaces.spec.ts` drives a **stub** registry.
- The shared cross-runtime suite asserts each `/internal/*` route is MOUNTED and machine-gated on
  both facades — presence, not behaviour.

So the whole class of "the Worker's `container.repositories` does not expose repository X" or "the
D1 repo does not have the method the allow-list names" ships green.

**This is not hypothetical: the two registries have already diverged.** Both facades hand-fold the
repositories that are not part of `CoreDependencies` into the reflected registry, and the lists do
not match — Cloudflare folds `validationConfigRepository`
(`runtimes/cloudflare/src/infrastructure/container-assembly.ts:626`), Node does not
(`runtimes/node/src/container.ts:435`). `validationConfigRepository` IS allow-listed
(`rpc-allowlist.ts:802`), so today a satellite pointed at a **Node** mothership gets
`... is not wired` for its pre-PR validation reads. The drift ran in Cloudflare's favour this time;
nothing would have caught it in either direction.

**Fix direction.** The drift guard should assert REGISTRY MEMBERSHIP per facade — every repo named
in `REMOTE_PERSISTENCE_METHODS` is present on the registry each facade attaches, and every
allow-listed method exists on the D1 class as well as the Drizzle one. A Worker-side round-trip
test (workerd + local D1 serving `/internal/persistence`) would additionally cover D1 ⇄ wire
serialization, which today rests entirely on the general D1 ⇄ Drizzle conformance parity.

## 5. The GitHub delegation rate limit is per-isolate

`githubDelegationController` brakes the installation-token mint with a fixed-window counter in a
module-scope `Map` (`packages/server/src/modules/persistence/GitHubDelegationController.ts:76`),
documented as "PER PROCESS/ISOLATE … a coarse abuse brake, not a distributed quota".

That description is accurate for both hosts and materially different in effect. A Node replica is
one long-lived process, so 30 mints/min/node is roughly what a node gets. A Worker spreads one
node's requests across isolates that are created, reused and evicted continuously and across
colos — so the counter a given request sees is usually empty, and the brake on a compromised or
runaway satellite hammering GitHub's mint API is close to absent on exactly the host where a Worker
deployment is most likely to be the mothership. (Minor, both hosts: `mintWindows` entries are never
evicted.)

**Fix direction.** Back the window with state the Worker actually shares — Cloudflare's Rate
Limiting binding, or a per-node Durable Object — behind the existing seam so Node keeps its
in-process counter.

## Cloudflare ceilings the machine API now sits near

Not defects, but the numbers a future slice should size against (D1 and Workers docs):

- **D1**: 2,000,000-byte string/BLOB/row (finding 3); 100 KB SQL statement text; 100 bound
  parameters per statement (the telemetry `recordMany` chunks at 50 single-row statements, so it is
  clear); 30 s per query; 1,000 queries per Worker invocation; 10 GB per database.
- **Per-call cost of the persistence RPC**: each call is a Worker invocation plus at least two D1
  queries — the scope-binding `accountOf` read and the method's own — and D1 writes route to a
  single primary region. Nothing uses D1 Sessions / read replication (`withSession` appears nowhere
  in the facade), so a satellite far from that region pays the round trip on both. A board load or
  a step settlement is many sequential such calls.
- **Worker memory** (~128 MB per isolate) against an 8 M-char ingest body and a
  `MAX_TELEMETRY_READ_CHARS` (~8.9 M chars) read response, both of which are parsed/serialized
  whole.

## Checked and fine

Recorded so a later reader does not re-derive them:

- All nine `/internal/*` routes are registered in the shared `@cat-factory/server` app, so the
  Worker mounts them by construction; the Worker attaches `repositories` unconditionally and
  `machineEventRelay` / `machineNotificationDelivery` / `githubTokenDelegation` on their own
  capability probes (`container-assembly.ts:577-639`).
- Machine-token minting (`POST /auth/machine-token`) is runtime-neutral — session verify,
  `accountService.listForUser`, narrowing-only `requestedAccountIds`.
- The inbound subscribe leg's Cloudflare-specific hazard is genuinely handled: the
  `WorkspaceEventsHub` DO sets `WebSocketRequestResponsePair('ping', 'pong')` in its constructor, so
  the satellite's app-level heartbeat is answered at the edge without waking the DO, and the node's
  `?cid=` is stored via `serializeAttachment` for echo suppression.
- The relayed-event size cap (1,000,000 chars) is far under the DO's 32 MiB received-message limit.
- The two facades' machine-event relays are symmetric in behaviour, including both swallowing a
  broadcast failure.
