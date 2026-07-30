---
'@cat-factory/cli': minor
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

**A hopeless repair is reported, not retried.** Two cases qualify. A cluster whose restart is blocked
by a stale cgroup (`runc create failed: … cgroup.procs: device or resource busy` — a state a suspend
can leave behind) cannot be repaired from inside a supervisor: clearing it requires restarting the
container _engine_, which would kill every other container, including the database this same
supervisor depends on. So that case throws `OperatorActionRequiredError`, whose message is printed
**once** with the actual fix. And a supervised command that never reaches a serving state is capped at
`maxFailedStarts` restarts, then reported with a non-zero exit — restarting cannot fix a command that
is simply broken, and any successful probe resets the count so a long-lived stack is never capped.
Looping on either would reproduce the exact pathology this command exists to end: during the incident
that motivated this work, a k3d load balancer restarted 518 times against a missing upstream, exiting
**0** each time, so `docker ps` showed motion and the cluster sat dead for 36 hours.

**Shutdown belongs to the loop, because the loop owns the child handle.** A signal handler outside it
can only reach the port, which on POSIX kills the inner listener while leaving the package-manager
wrapper and its parked `node --watch` alive — a Ctrl-C that orphans exactly the tree this command
manages. So `SIGINT`/`SIGTERM` abort an `AbortSignal` the loop is sleeping on, and it kills the child
tree and reaps the port on its way out.

Two things the design refuses to do quietly. `--runtime k3s` alongside `--k3s-cluster` is **rejected**
rather than silently supervised as k3d (which would leave the dependency reporting "not ready, will
retry" forever, with nothing naming the real cause), and a missing `lsof` — absent by default on many
Linux images — is **announced**, because it silently turns the port reaper into a no-op and brings
back the `EADDRINUSE` restart loop it exists to prevent. Reaping by port means SIGKILLing a process we
were never handed, so every kill names the pid and the command behind it.

The judgement is kept pure in `supervise.ts` (state + observation → next state + action) so every
transition is table-tested without processes, sockets, or an ambient clock; effects live behind
seams in `supervise-runtime.ts` and reach the host through the existing `HostShell`, so the cluster
logic is driven by a scripted fake shell rather than a real cluster. Cluster readiness is judged
from the apiserver's own version — `kubectl` still prints the client half when the control plane is
down, which is the shape that would fool a naive exit-code or first-line check.

`HostShell.run` gains a `cwd`, which the compose dependency passes on every call: compose resolves its
project file relative to the working directory, so without it `--compose-dir` addressed no project at
all and reported a permanently un-ready database rather than restoring one.

Two timing details are load-bearing and both were wrong in a way that only shows up on the path this
command is FOR. The clock-jump measurement is taken tick-start to tick-start, and `lastTickAt` is
re-based when a child restarts: a repair runs the whole dependency ladder first, whose budgets are 90s
(compose) and 120s (apiserver) against a 30s jump threshold, so measuring across it made a
slow-but-successful recovery read as a suspend — and since resume detection outranks the boot grace,
the supervisor killed the child it had just started.

`deploy/local`'s `dev` script is now the supervised one and the bare `node --watch` moves to
`dev:raw`. The safe path should be the one you get by default; the escape hatch exists because a
watchdog that restarts the process destroys the parked state you need when you are debugging a
crash. Note `predev` now also builds `@cat-factory/cli`, so running `pnpm dev` directly inside
`deploy/local` (bypassing Turbo's `^build`) still resolves the `cat-factory` bin.
