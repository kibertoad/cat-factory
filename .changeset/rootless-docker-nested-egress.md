---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/local-server': patch
---

Give the runner image's nested containers a network again, and measure it before claiming one

The image started its rootless daemon with `--iptables=false` unconditionally. That flag arrived
because the daemon could not start at all without it in a sandbox like Cloudflare Containers, and
it did fix that. What went unnoticed is what it costs once the daemon DOES start: the rule it
drops is the MASQUERADE for the bridge, so traffic from a nested container is never NATed and the
container has no egress whatsoever, no DNS and no raw IP either. The daemon's own `docker pull`
keeps working, which is most of why it stayed hidden, and the cost lands on the thing agents do
constantly. On the run that exposed this, a coder's first `docker build` spent 426s inside
`RUN npm ci` before failing, and from outside it read as a hang: the heartbeat stayed fresh,
`lastActivityAt` moved, and nothing was logged between the job starting and the failure.

The flag is now a fallback rather than a premise. The entrypoint starts the daemon that manages
its own firewall rules and only starts the crippled one when the first one EXITS without serving,
which is the one piece of evidence that is actually about its flags: a sandbox with no iptables
binary and no NAT module does not slow the daemon down, it makes `dockerd` exit at once. A first
arm that is merely slow keeps the rest of the readiness budget, because a clock says nothing about
firewall rules and swapping there would take a capable daemon away from a cold sandbox for the
container's whole life; a first arm that never answers is recorded as undecided and LEFT RUNNING,
so `resolveDockerVerdict`'s live re-probe can still find it, with its NAT. A sandbox that genuinely
cannot do iptables ends up exactly where it was; a privileged Docker or Podman host, which is what
local mode runs on, gets working nested networking.

Each arm gets its OWN rootlesskit state directory, image store and pid file, and the abandon path
waits for the process to be gone after `kill -9` rather than returning the moment the parent is
reaped. Both matter for the same reason: SIGKILL is not propagated, so a launcher that had already
forked the real `dockerd` dies while its child holds a lock on the shared data root and a live pid
file, and the replacement then fails for a reason that has nothing to do with why it was started.
That is the worst outcome available here, since both arms record `failed` and the container ends up
with no daemon at all where before it had a working crippled one. The two arms record different
`reason` words, and the fallback's detail states only what was OBSERVED (the first daemon exited)
rather than naming iptables as the cause, which nothing in the entrypoint measures; the real cause
is the daemon's own log tail, which now rides the stderr line announcing the switch.

The other half is that nothing could see this. The container check runs a container, which is
strictly better than asking the daemon about itself, and it still cannot see a daemon whose
containers have no network, because loading and running a local image needs none: the harness
reported `dockerDaemon: "usable"` on every published image and told each agent, as stated fact, in
a block that also says not to spend turns re-checking it, that `docker build` works there. So a
`usable` verdict now carries what a SECOND container, on the default network, could reach:
`reachable`, `blocked` (with a detail separating no route at all from a route with broken DNS) or
`undetermined`. It rides `GET /health`, the agent's environment inventory and the Tester step's
own `infraSetup.dockerEgress`, so the record a human reads no longer shows the same
undifferentiated `usable` for a daemon whose containers cannot fetch anything. Which commands the
inventory claims now comes FROM that verdict rather than being stated and then retracted one
sentence later, and the `blocked` wording is precise about which break, since the daemon does still
pull base images and only the `RUN` lines that fetch from the public internet fail.

Same asymmetry as the daemon verdict: a busybox without the applet, an unreadable target setting, a
container that printed nothing and a daemon that refused to start the egress container at all are
facts about the platform's own check and are never reported as an absent network, and a name that
resolved while the configured address was refused is undetermined rather than blocked, because a
deployment that filters that address is likelier than one with no route. An undetermined verdict
now says whether asking again could ANSWER differently: a timeout is re-measured, while a rejected
setting, a payload with no `nc` and a filtered address are latched, because re-running two
container starts and an image load per job never converges on a cause that cannot change under a
running container.

The connect probe no longer reads a bare `nc -w` exit status as evidence. busybox documents that
flag as the timeout for connects AND FINAL NET READS, so a connect that SUCCEEDED to a peer which
expects the client to speak first (every TLS port, the default `1.1.1.1:443` included) hits the
alarm and exits non-zero, which is indistinguishable from a refusal. It uses `-z` where the
payload's busybox has it and no `-w` where it does not, and wraps both halves in `busybox timeout`.

New knobs, all optional: `HARNESS_DOCKER_EGRESS_TARGET` / `HARNESS_DOCKER_EGRESS_DNS_NAME` aim the
egress check somewhere a restricted network permits, which is what a deployment with an internal
mirror and no public egress should set. `HARNESS_DOCKER_READY_TIMEOUT_SECONDS` keeps its meaning as
the budget for the WHOLE sequence rather than gaining a per-arm sibling.
