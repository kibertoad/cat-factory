---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Runner image: install the Docker daemon that was never there, stop handing the agent the harness's
`NODE_ENV`, and add the three binaries agents reach for first.

The image installed `docker-ce-rootless-extras` (the wrappers that START a rootless daemon) but
never `docker-ce` (the daemon) or `iproute2` (the `ip` binary rootlesskit builds its network with),
so no container could ever run `docker compose`. `entrypoint.sh` backgrounded the start in a
subshell where its exit status was unobservable, so the Tester's local-infra stand-up silently
became a no-infra run everywhere, and had done since it shipped. Both packages are installed now,
and the entrypoint waits for the daemon on a bounded window (in the background, so it never delays
the container's boot) and RECORDS the verdict: `GET /health` reports it, and the compose stand-up
refuses a decided absence with the cause instead of running compose against nothing.

`infraSetup` gains `dockerAvailable` on the wire (harness → `RunnerInfraSetup` →
`testerInfraSetupSchema`), and the test window says "No Docker daemon in the executor" rather than
"Dependencies failed to start" for that case: a compose stack that failed to come up and an
executor with no daemon are opposite fixes. It is three-valued — absent means the container reached
no verdict (an older image, or the native host transport, which runs the harness with no entrypoint
to probe) and must never be read as `false`.

`ENV NODE_ENV=production` is no longer baked into the image. npm reads it as `omit=dev`, so an
agent's `npm install` in its checkout skipped every devDependency; one measured coder run spent six
of its forty budgeted tool calls discovering and undoing that. The harness process still gets it
(from `entrypoint.sh`), and the new `agentChildEnv` seam drops it from everything the harness spawns
into the checkout — which is what makes the fix hold under the native host transport too, where the
image is not involved at all.

`python3`, `jq` and `ripgrep` join the image for the same reason `procps` is already there: agents
reach for all three by reflex and each `command not found` costs a call.

`entrypoint.sh` is also added to the executor images' source lists, so a change to how the container
boots can no longer republish over a live tag without minting a version.
