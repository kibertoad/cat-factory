---
'@cat-factory/executor-harness': minor
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
its own firewall rules and only starts the crippled one on the evidence that the first did not
serve, on a shorter ceiling than the full readiness wait (a sandbox that forbids iptables fails
fast, so only a hung daemon pays it). A sandbox that genuinely cannot do iptables ends up exactly
where it was; a privileged Docker or Podman host, which is what local mode runs on, gets working
nested networking. Each arm gets its own rootlesskit state directory, so an abandoned daemon
cannot leave a lock or a detached network namespace behind that stops its replacement starting,
and the two arms record different `reason` words with a detail naming the consequence.

The other half is that nothing could see this. The container check runs a container, which is
strictly better than asking the daemon about itself, and it still cannot see a daemon whose
containers have no network, because loading and running a local image needs none: the harness
reported `dockerDaemon: "usable"` on every published image and told each agent, as stated fact, in
a block that also says not to spend turns re-checking it, that `docker build` works there. So a
`usable` verdict now carries what a SECOND container, on the default network, could reach:
`reachable`, `blocked` (with a detail separating no route at all from a route with broken DNS) or
`undetermined`. It rides `GET /health` and the agent's environment inventory, whose `blocked`
wording is precise about which commands break, since the daemon does still pull base images and
only the `RUN` lines that fetch anything fail. Same asymmetry as the daemon verdict: a busybox
without the applet, an unreadable target setting or a container that printed nothing are facts
about the platform's own check and are never reported as an absent network, and a name that
resolved while the configured address was refused is undetermined rather than blocked, because a
deployment that filters that address is likelier than one with no route.

Two new knobs, both optional: `HARNESS_DOCKER_IPTABLES_READY_TIMEOUT_SECONDS` bounds the first
arm, and `HARNESS_DOCKER_EGRESS_TARGET` / `HARNESS_DOCKER_EGRESS_DNS_NAME` aim the egress check
somewhere a restricted network permits.
