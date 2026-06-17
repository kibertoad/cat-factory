# Per-run container reaping & deletion

How the per-run Cloudflare Container instances that back agent work
(`ImplementationContainer`, bind `IMPL_CONTAINER`) get stopped and reclaimed —
and where that logic currently has gaps that leave **dangling (warm, billed)
instances**. Companion to the execution / bootstrap flow notes in
[`../../CLAUDE.md`](../../CLAUDE.md).

Status (2026-06): reaping is **best-effort across three layers** below. There is
**no scheduled reaper that kills a warm instance independently of its run
record**, and the success path does not explicitly reclaim — so a long-lived or
stuck run can leave an instance warm past its idle timer. Manual cleanup is
sometimes required (see _Manual deletion_ at the end). Improving the autoreaping
is a known follow-up.

## The instance model

Cloudflare Containers map one Durable Object id → one dedicated container. Each
run addresses `IMPL_CONTAINER.get(idFromName(<jobId>))`, so **every execution /
bootstrap job gets its own ephemeral instance**, keyed by the run id. Both flows
share the one container class (`src/infrastructure/containers/ImplementationContainer.ts`).

Inspect live state with wrangler (read-only):

```
wrangler containers list                 # app-level: LIVE INSTANCES count
wrangler containers info <APP_ID>        # health breakdown (active/healthy/…)
wrangler containers instances <APP_ID>   # per-instance: running | active | inactive
```

`inactive` instances are **already stopped and not billed** — Cloudflare keeps
the record but reclaims them. Only `running`/`active` instances cost money. (The
bootstrap instances show up named `boot_<…>`.)

## Layer 1 — idle auto-sleep (`sleepAfter`)

`ImplementationContainer.sleepAfter = '10m'`
(`ImplementationContainer.ts:21`). Cloudflare stops an instance after 10 minutes
with **no inbound requests**.

- While a run is active the durable driver polls it every ~15s, which keeps the
  instance warm; the 10-minute idle window only starts counting **once polling
  stops** (i.e. the job reached a terminal state and the driver stopped polling).
- This is the **only** reaper on the **success path** — see Layer 2. A
  successfully-completed run is simply left to idle out, so it can bill up to
  ~10 min of idle compute after finishing. Normally acceptable.

## Layer 2 — explicit reclaim (`shutdown()` RPC → SIGKILL)

`ImplementationContainer.shutdown()` (`ImplementationContainer.ts:30`) calls the
base `Container.destroy()` (SIGKILL) — idempotent, swallows "already gone". It is
reached over RPC, keyed by job/execution id, through:

- **Execution:** `CloudflareContainerTransport.release(jobId)`
  (`CloudflareContainerTransport.ts:63`) ← port `AsyncAgentExecutor.stopJob`
  (`ContainerAgentExecutor.stopJob`, `ContainerAgentExecutor.ts:126`) ←
  `ExecutionService.stopRunContainer` (`ExecutionService.ts:901`).
- **Bootstrap:** `ContainerRepoBootstrapper.stopBootstrap`
  (`ContainerRepoBootstrapper.ts:289`) ← `BootstrapService.stopContainer`
  (`BootstrapService.ts:611`).

Both wrappers are best-effort/idempotent and never throw, so cleanup can't derail
the failure/teardown handling that calls it.

**When explicit reclaim actually fires:**

| Trigger                          | Execution                                                                | Bootstrap                                                                                |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Poll observes the job **failed** | (via stop on fault)                                                      | `pollBootstrapJob` → `BootstrapService.ts:466`                                           |
| User **stops/cancels** the run   | `ExecutionService.stopRun`                                               | `BootstrapService.stop` → `BootstrapService.ts:531`                                      |
| Pre-flight / dispatch cleanup    | —                                                                        | `BootstrapService.ts:275`, `:378`                                                        |
| Block-tree **delete / teardown** | `teardownForBlockTree` → `ExecutionService.ts:889` (also `:828`, `:863`) | (frame removed with job)                                                                 |
| Job **succeeds**                 | ❌ **not reclaimed** — relies on Layer 1                                 | ❌ **not reclaimed** (success path `BootstrapService.ts:477-505` has no `stopContainer`) |

The success-path omission is deliberate (sleepAfter handles it) but is the main
reason a healthy run still bills ~10 min of idle compute after finishing.

## Layer 3 — orphan sweeper (cron backstop)

`sweepStuckRuns` (`src/infrastructure/workflows/sweeper.ts`), wired in
`src/index.ts` `scheduled`, cron `*/2 * * * *` (every 2 min,
`wrangler.toml:133`), staleness lease `SWEEP_LEASE_MS = 5 min`
(`index.ts:43`). It targets runs still `running` in D1 whose backing **Workflows
instance** is no longer driving them, across **both** kinds:

- `missing` (instance lost: eviction / missed event) → **re-drive** (recreate the
  durable driver).
- `terminal` (instance completed/terminated, can't be recreated under the same
  id) → **`finalizeOrphan`** → calls the same user-facing stop path
  (`bootstrap.service.stop` / `executionService.stopRun`, `index.ts:116-133`),
  which **reclaims the leftover container** via Layer 2.
- `alive` → leave it.

So the sweeper reclaims a container **only as a side effect of finalizing a
terminal orphan**. It does **not** look at containers directly and will not kill a
warm instance whose run record still looks healthy/`alive`.

## Container-side watchdogs

Independent of the above, the harness self-bounds each job (env read inside the
container, `wrangler.toml:171-173`):

- `JOB_MAX_DURATION_MS` — force-fails a job after this long (default
  `3600000` = **60 min**).
- `JOB_INACTIVITY_MS` — kills the agent after a stretch of no progress.

A force-failed job becomes terminal, after which polling stops and Layer 1 (or a
stop on the observed failure) reaps the instance.

## Where dangling instances come from (the gap)

1. **Success idle tail** — a completed run bills up to ~10 min before sleepAfter
   stops it (no explicit reclaim on success). Expected, minor.
2. **Long / stuck running jobs** — while a driver keeps polling, the idle timer
   never starts, so an instance can stay warm well past `sleepAfter` (observed: a
   bootstrap instance ~39 min old, under the 60-min watchdog — either still doing
   real work, or a workflow still polling a job that won't terminate). The sweeper
   won't touch it because its run still classifies as `alive`.
3. **No instance-level reaper** — nothing kills a warm instance based on the
   instance's own age/idleness; reclamation is always routed through the run
   record. If the run record and the real instance state diverge, an instance can
   leak until the next event that happens to reclaim it.

## Manual deletion (current stop-gap)

There is **no per-instance kill in `wrangler`** — `wrangler containers delete
<APP_ID>` operates on the **whole application** (removes the container app /
binding; destructive, breaks prod until redeploy). Do **not** use it just to free
a few instances.

To reclaim a single live instance without nuking the app, either:

- **Use the app's own stop path** — `POST /workspaces/:ws/agent-runs/:id/stop`
  (the same button the UI uses), which invokes the Layer-2 `shutdown()` RPC for
  that run id; or
- **Delete the specific instance via the Cloudflare API** (account container
  instances endpoint) with an API token — surgical, leaves the app intact.

`inactive` instances need no action (already stopped/unbilled).
