---
'@cat-factory/executor-harness': minor
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
too, deliberately: only the container RUN may produce `unusable`, so a failure of the platform's own
machinery (no payload on this machine, an architecture it has no image for, a `docker load` that
refuses the archive) reports that it could not tell rather than condemning a working daemon. The
compose stand-up refuses on the same verdict and names the cause, and `GET /health` reports the last
measurement beside the boot record, since `serving` was never the same word as `usable`.

The cause is addressed as well as the claim. The rootless daemon is taken off the containerd image
store, whose snapshotter mounts or fails with no fallback; the graphdriver path it returns to probes
overlay2, then `fuse-overlayfs`, then `vfs`, and settles on whichever the sandbox permits. That is
written as a config key rather than a daemon flag, because an unknown key inside `features` is
ignored while an unknown flag takes the daemon down at startup. Whether it worked is not assumed
either way: the platform runs a container and reports what happened.

The image also gains the buildx plugin, without which `docker build` and `docker compose build` fail
before reading a Dockerfile, and a `docker-compose` shim for the spelling half the world's repo
scripts still use.
