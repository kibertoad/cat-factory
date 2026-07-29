---
'@cat-factory/cli': minor
'@cat-factory/contracts': minor
---

Add `cat-factory supervise` — a self-healing watchdog for local dev, and make it the default `dev`
script for `deploy/local`.

The failure it fixes is a silent one. Every local deployment runs under `node --watch`, which
**parks on crash**: it restarts the entry only on a file change, never on a process exit. A laptop
sleep is the usual trigger — on resume the Postgres connection is gone, the server dies in
`migrate`, and the watcher settles at "Waiting for file changes before restarting". Nothing is left
bound to the port, but the wrapper PID is alive and the ready banner scrolled past long ago, so the
stack _looks_ running. The SPA surfaces it only as a generic "can't reach backend", and it stays
that way indefinitely, because the one event that would restart it (a file change) is the one event
that isn't coming.

`supervise` wraps a dev command and probes the signal that actually distinguishes those states —
the port is listening **and** `/health` answers 200. Both halves are load-bearing: a parked watcher
leaves nothing bound, while a server that booted but lost its DB pool still holds the socket and
fails only the HTTP check. On sustained failure it re-establishes dependencies and restarts the
child; `--compose-service postgres` brings the database back (the example compose files set no
restart policy, so anything that stops the container engine leaves it down) and waits for healthy,
since relaunching against a still-initialising database just crashes again. `--k3s-cluster` does
the same for a stopped k3d/kind cluster, so a resume doesn't leave the Local k3s environment handler
aimed at a dead apiserver.

Two design points worth reviewing:

**Resume detection outranks the failure threshold.** Timers don't fire while a host is suspended, so
a tick arriving three poll intervals late means wall-clock time jumped. That triggers an immediate
repair rather than accumulating the usual three failed probes, and it deliberately overrides an
active boot-grace window too — a resume is precisely when the stack is most likely already dead, and
deferring costs another `failureThreshold * pollMs` of downtime to re-learn what we can already tell.

**One failure is reported, not retried.** A cluster whose restart is blocked by a stale cgroup
(`runc create failed: … cgroup.procs: device or resource busy` — a state a suspend can leave behind)
cannot be repaired from inside a supervisor: clearing it requires restarting the container _engine_,
which would kill every other container, including the database this same supervisor depends on. So
that case throws `OperatorActionRequiredError`, whose message is printed **once** with the actual
fix. Looping on it would reproduce the exact pathology this command exists to end — during the
incident that motivated this work, a k3d load balancer restarted 518 times against a missing
upstream, exiting **0** each time, so `docker ps` showed motion and the cluster sat dead for 36
hours.

The judgement is kept pure in `supervise.ts` (state + observation → next state + action) so every
transition is table-tested without processes, sockets, or an ambient clock; effects live behind
seams in `supervise-runtime.ts` and reach the host through the existing `HostShell`, so the cluster
logic is driven by a scripted fake shell rather than a real cluster. Cluster readiness is judged
from the apiserver's own version — `kubectl` still prints the client half when the control plane is
down, which is the shape that would fool a naive exit-code or first-line check.

`deploy/local`'s `dev` script is now the supervised one and the bare `node --watch` moves to
`dev:raw`. The safe path should be the one you get by default; the escape hatch exists because a
watchdog that restarts the process destroys the parked state you need when you are debugging a
crash. Note `predev` now also builds `@cat-factory/cli`, so running `pnpm dev` directly inside
`deploy/local` (bypassing Turbo's `^build`) still resolves the `cat-factory` bin.

## Wire contract for surfacing this in the UI

A supervisor that only writes to a terminal is a supervisor whose findings get missed — the
incident above sat unnoticed for 36 hours precisely because the only evidence was a log nobody was
tailing. So `@cat-factory/contracts` gains the wire shape the SPA banner needs:

- `infraSetupStatusSchema` gains **`unreachable`** — configured, but a live probe can't reach it.
  It rides the existing setup projection rather than a new "your infra is broken" surface, because
  the consequence is identical to `not_defined` (a class of agents cannot run) and the operator
  surface that fixes it is the same, so the banner, deep-link and i18n are all reused.
  `isInfraSetupHealthStatus` + `INFRA_SETUP_HEALTH_STATUSES` mark it as a HEALTH state, which
  consumers must honour: the other three are stable operator decisions, so the banner offers a
  permanent per-user "don't notify me again" — applying that to an outage would let one click
  silence every future occurrence, so a health state is session-dismissible and must re-nag.
- `WorkspaceEvent` gains **`infraSetup`**, carrying the area, the new status, and optional
  `detail`/`remediation`. The projection is otherwise recomputed only on snapshot load, which is
  fine for operator decisions but useless for `unreachable`: a cluster dying mid-session would stay
  invisible until someone reloaded the app. Publish on TRANSITION only — a reachability watcher
  polling every few seconds would otherwise storm the workspace bus. The optional text is how the
  supervisor's cgroup-wedge diagnosis reaches the banner, since only an attempted START can
  discover it and the server never attempts one.

Both changes are additive: the full backend solution build passes untouched, and the SPA only
re-exports the type, so nothing changes behaviour until the producer and the banner fork land.
