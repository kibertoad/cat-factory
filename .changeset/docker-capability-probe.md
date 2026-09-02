---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/app': minor
'@cat-factory/local-server': patch
---

Find out whether the container's Docker daemon can actually run a container, instead of telling
every agent that it can.

The harness appended a line to every agent's system prompt saying `docker build`, `docker run` and
`docker compose up` work here, on the strength of `docker info` exiting zero. Those are different
facts. A rootless daemon nested inside a sandbox serves happily while its snapshotter cannot mount
a single image layer, so a multi-layer `docker pull`, a `docker run` of a single-layer image and
`docker build` all fail on one EINVAL from `mount(2)`. The same block also tells the agent not to
spend turns re-checking what it states, which made the claim maximally expensive: in the reported
run the coder, the reviewer and the tester each disproved it separately, and the tester's
containerised deployment contract went unverified by anyone.

The reachable case is now split by a real workload. The platform assembles a one-layer image in
memory from a statically linked binary already in the image, loads it and runs a container that has
to print a marker, so the check needs no registry, no network and no second image. `usable`,
`unusable` and a daemon that answered while the check could not be carried out are three different
lines to the agent, and only the first claims the commands work. The asymmetry runs the other way
too, deliberately: only the container RUN may produce `unusable`, and only where the DAEMON is what
refused it, so every failure of the platform's own machinery reports that it could not tell rather
than condemning a working daemon. That covers the steps before the run (no payload on this machine,
a daemon whose architecture the payload is not built for, a `docker load` that refuses the archive)
and the halves of a failed run that are ours rather than the daemon's: docker's exit 126/127, a tag
that did not resolve, a payload that cannot exec there. The image is built for the architecture the
DAEMON reports, not this process's, because an external `DOCKER_HOST` need not share one.

The weaker fact still decides one case, and it is the one a stale boot record is read against. A
check that could not be carried out says whether it reached a daemon on the way past, so a
warm-pool container whose sidecar came up after the entrypoint's bounded wait is not latched into
refusing local infra for its whole life: a daemon that merely answered overrules a recorded absence
exactly as the old `docker version` probe did, and only a check that never reached one leaves the
record to decide. The stand-up refuses on the resolved verdict and names the cause, and the Tester
step now carries both facts (`infraSetup.dockerAvailable` and a new `infraSetup.dockerWorkload`)
because the daemon has two ways to stop a stand-up and they are fixed in different places: a
reachable daemon that cannot run a container, reported as an absent one, sends an operator to
restart a daemon that is already up. `GET /health` reports the last measurement beside the boot
record, since `serving` was never the same word as `usable`.

The check is bounded and cancellable, being on the critical path ahead of the clone: one budget for
the whole pass rather than a ceiling per command, the job's signal on every command it makes, and a
measurement cancelled once the last caller waiting on it has gone. It answers rather than throwing,
whatever happens inside it, because the stand-up that consults it is best-effort by design.

The cause is addressed as well as the claim. The rootless daemon is taken off the containerd image
store, whose snapshotter mounts or fails with no fallback; the graphdriver path it returns to probes
overlay2, then `fuse-overlayfs`, then `vfs`, and settles on whichever the sandbox permits. That is
written as a config key rather than a daemon flag, because an unknown key inside `features` is
ignored while an unknown flag takes the daemon down at startup. Whether it worked is not assumed
either way: the platform runs a container and reports what happened.

The image also gains the buildx plugin, without which `docker build` and `docker compose build` fail
before reading a Dockerfile, and a `docker-compose` shim for the spelling half the world's repo
scripts still use.
