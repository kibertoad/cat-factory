# Per-run container reaping & deletion

How the per-run Cloudflare Container instances that back agent work
(`ExecutionContainer`, bind `EXEC_CONTAINER`) get stopped and reclaimed —
and where that logic currently has gaps that leave **dangling (warm, billed)
instances**. Companion to the execution / bootstrap flow notes in
[`../../CLAUDE.md`](../../CLAUDE.md).

Status (2026-06): reaping is **best-effort across four layers** below. Every
terminal path now reclaims explicitly (success **and** failure, for both flows),
and **Layer 4 is an instance-level cron reaper** that kills a warm instance from
the real live-container inventory — independent of its run record — closing the
two leak modes that previously let an instance stay warm for ~a day. Manual
cleanup should now be rare (see _Manual deletion_ at the end).

## The instance model

Cloudflare Containers map one Durable Object id → one dedicated container. Each
run addresses `EXEC_CONTAINER.get(idFromName(<jobId>))`, so **every execution /
bootstrap job gets its own ephemeral instance**, keyed by the run id. Both flows
share the one container class (`src/infrastructure/containers/ExecutionContainer.ts`).

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

`ExecutionContainer.sleepAfter = '10m'`
(`ExecutionContainer.ts:21`). Cloudflare stops an instance after 10 minutes
with **no inbound requests**.

- While a run is active the durable driver polls it every ~15s, which keeps the
  instance warm; the 10-minute idle window only starts counting **once polling
  stops** (i.e. the job reached a terminal state and the driver stopped polling).
- The success path now also reclaims explicitly (Layer 2), so this idle window is
  a fallback (e.g. when no async container executor is wired), not the primary
  success-path reaper.

## Layer 2 — explicit reclaim (`shutdown()` RPC → SIGKILL)

`ExecutionContainer.shutdown()` (`ExecutionContainer.ts:30`) calls the
base `Container.destroy()` (SIGKILL) — idempotent, swallows "already gone". It is
reached over RPC, keyed by job/execution id. **Both flows now funnel through the
one `RunnerTransport.release` seam** (`CloudflareContainerTransport.release`),
which goes through the `ContainerInstanceRegistry`'s single kill path
(SIGKILL **+** clears the live-inventory row, see Layer 4):

- **Execution:** `transport.release(jobId)` ← port `AsyncAgentExecutor.stopJob`
  (`ContainerAgentExecutor.stopJob`) ← `ExecutionService.stopRunContainer`.
- **Bootstrap:** `ContainerRepoBootstrapper.stopBootstrap` →
  `transport.release(jobId)` (the bootstrapper rides the same transport now,
  rather than hand-rolling its own `EXEC_CONTAINER` call) ←
  `BootstrapService.stopContainer`.

Both wrappers are best-effort/idempotent and never throw, so cleanup can't derail
the failure/teardown handling that calls it.

**When explicit reclaim actually fires:**

| Trigger                          | Execution                                                                | Bootstrap                                            |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Run **fails** (agent fault, etc) | ✅ `failRun` → `stopRunContainer` (single funnel for every failure kind) | ✅ `pollBootstrapJob` failure path → `stopContainer` |
| User **stops/cancels** the run   | ✅ `ExecutionService.stopRun`                                            | ✅ `BootstrapService.stop`                           |
| Pre-flight / dispatch cleanup    | —                                                                        | ✅ pre-flight / dispatch cleanup                     |
| Block-tree **delete / teardown** | ✅ `teardownForBlockTree`                                                | (frame removed with job)                             |
| Job **succeeds**                 | ✅ `recordStepResult` final step → `stopRunContainer`                    | ✅ `pollBootstrapJob` success path → `stopContainer` |

Every terminal path now reclaims explicitly. The success-path reclaim is only safe
on the **final** step (all pipeline steps share one container keyed by the
execution id); the failure reclaim funnels through `failRun` so every failure kind
(driver `job_failed`, spend/decision timeouts, user stop) reclaims once,
idempotently. These calls are no-ops where no async container executor is wired
(e.g. the test `FakeAgentExecutor`).

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
warm instance whose run record still looks healthy/`alive` — that blind spot is
what Layer 4 covers.

## Layer 4 — instance-level reaper (cron backstop, registry-backed)

The load-bearing backstop that keys off the **real container inventory**, not the
run record. A tiny D1 registry, `live_containers` (migration `0022`), records one
row per live container: the Cloudflare transport `register`s a row on dispatch and
`release` clears it (Layer 2), so the row's `started_at` is the container's true
age.

- `ContainerInstanceRegistry` (`src/infrastructure/containers/ContainerInstanceRegistry.ts`)
  owns the `EXEC_CONTAINER` namespace + the `LiveContainerStore`
  (`D1LiveContainerRepository`) + a `Clock`. Its `release(key)` is the **single kill
  path** (SIGKILL via `shutdown` **+** remove the row), shared by Layer 2 and this
  reaper so they can't diverge.
- `reapStaleBefore(now − maxAgeMs)` (`src/index.ts` `scheduled`, the `*/2` cron, in
  `ctx.waitUntil`) lists every row older than the ceiling, kills each through
  `release`, and **warn-logs each kill** (`cron: 'container-reaper'`). With normal
  runs self-reclaiming, a reap is a genuine **leak signal**.
- Ceiling = `CONTAINER_MAX_AGE_MINUTES` (default **90**, hard-clamped to **≥75**),
  sized above the longest legitimate lifetime (harness 60-min max-duration; driver
  ≈70-min polling) so it never kills live work
  (`config/execution.ts` → `ExecutionConfig.containerMaxAgeMs`).
- It covers **every** dispatch kind (`run` / `blueprint` / `bootstrap`) for free,
  because they all dispatch through the one Cloudflare transport where the
  register/release lives.
- Backend = **registry + the existing `EXEC_CONTAINER` binding, no Cloudflare API
  token.** Any container can be killed by job id via
  `EXEC_CONTAINER.get(idFromName(key)).shutdown()` — the same binding that started
  it. The registry's only blind spot is a container we never recorded due to our own
  bug (e.g. a `register` write that failed and was swallowed); the table is the
  source of truth for the reaper.

## Container-side watchdogs

Independent of the above, the harness self-bounds each job (env read inside the
container, `wrangler.toml:171-173`):

- `JOB_MAX_DURATION_MS` — force-fails a job after this long (default
  `3600000` = **60 min**).
- `JOB_INACTIVITY_MS` — kills the agent after a stretch of no progress.

A force-failed job becomes terminal, after which polling stops and Layer 1 (or a
stop on the observed failure) reaps the instance.

## Leak modes and how they're now covered

The two historical leak modes (each defeated a different net; both could survive
~a day):

1. **Terminal run, surviving container.** A `done`/`failed` run drops out of
   `agentRunRepository.listStale` (running-only), so the cron sweeper (Layer 3)
   never revisits it — only `sleepAfter` could reap, and if that didn't fire the
   instance was invisible to every net. **Covered** by per-path reclaim (Layer 2,
   success + failure now reclaim) and, as a backstop, the Layer 4 reaper.
2. **Stuck-`running` run, live workflow.** The driver keeps polling (~15s), keeping
   the container warm so the 10-min idle clock never starts; and the sweeper sees
   the Workflows instance `alive` and skips it. Immune to both `sleepAfter` and the
   sweeper. **Covered** only by the Layer 4 reaper (age from the live-container
   inventory, independent of the run record).

Residual: the **success idle tail** when no async executor is wired (the per-path
reclaim is a no-op there) — a completed run can bill up to ~10 min before
`sleepAfter` stops it. Expected and minor.

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
