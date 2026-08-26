#!/bin/sh
# Container entrypoint. Starts a rootless Docker daemon — used by the Tester's local-mode
# infra stand-up (`docker compose up` for the service's dependencies) — RECORDS whether it
# actually came up where the harness can read it, and execs the harness HTTP server.
#
# Rootless is mandatory: Cloudflare Containers (and most managed runners) run without root
# or privileged mode, so the daemon runs under the unprivileged `harness` user via
# `dockerd-rootless.sh`.
#
# Best-effort stays best-effort: a runtime that forbids user namespaces has no daemon and
# the container still boots. What is NOT best-effort any more is SAYING SO. The previous
# version backgrounded the daemon in a subshell, so `||` could never observe its exit status
# and nothing downstream learned anything; the image shipped for months with no `dockerd`
# binary at all and every local-infra Tester run quietly became a no-infra run. The status
# file below is that missing answer: the harness refuses a local-compose stand-up it says
# cannot work, and reports it on GET /health, instead of leaving each agent to discover an
# absent daemon for itself.
#
# The readiness WAIT runs in the background and the harness is exec'd immediately, so a
# daemon that hangs costs a Tester its infra and never costs the container its boot window.
set -eu

# Where the verdict is recorded. Mirrors `DOCKER_STATUS_FILE` in src/docker-status.ts — the
# two halves of one contract, so change them together (the acceptance suite reads it).
DOCKER_STATUS_FILE="${HARNESS_DOCKER_STATUS_FILE:-/tmp/harness-docker-status.json}"
# How long a started daemon may take to answer before it counts as unavailable. Only a HUNG
# daemon pays this in full: the wait ends early both when the socket answers and when the
# daemon process is gone, which is what a packaging or sandbox failure looks like.
DOCKER_READY_TIMEOUT_SECONDS="${HARNESS_DOCKER_READY_TIMEOUT_SECONDS:-60}"

# Escape a value for embedding in a JSON string: flatten the control characters a log tail
# carries, escape backslashes then quotes (in that order — the reverse would re-escape its
# own output), and bound the length so a chatty daemon log can't produce an unbounded file.
json_string() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-2000
}

# Record the verdict: available (JSON `true`/`false`/`null`), source, reason, human detail.
# `source` and `reason` are this script's own closed vocabularies (docker-status.ts holds the
# reader's copy), so only `detail` is escaped. Written to a temp file and RENAMED, because
# the harness reads this concurrently and a half-written file would parse as no answer at all.
write_docker_status() {
  printf '{"available":%s,"source":"%s","reason":"%s","detail":"%s"}\n' \
    "$1" "$2" "$3" "$(json_string "${4:-}")" >"${DOCKER_STATUS_FILE}.tmp"
  mv "${DOCKER_STATUS_FILE}.tmp" "$DOCKER_STATUS_FILE"
}

# Whether the daemon at DOCKER_HOST is serving. `docker version` talks to the SERVER (the
# client-only `docker --version` answers even with no daemon at all, which is precisely the
# state this exists to detect).
docker_serving() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

# Wait for the daemon, ending early on either outcome that is already decided. $1 is the pid
# to watch (empty for an external daemon, which this container did not start).
await_docker() {
  waited=0
  while [ "$waited" -lt "$DOCKER_READY_TIMEOUT_SECONDS" ]; do
    if docker_serving; then return 0; fi
    if [ -n "${1:-}" ] && ! kill -0 "$1" 2>/dev/null; then return 1; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# The background half: wait for the daemon named by $1 (a pid, or empty for an external one)
# and overwrite the `probing` status with the verdict. $2 is the source vocabulary word.
probe_docker() {
  if await_docker "$1"; then
    write_docker_status true "$2" serving ''
    echo "entrypoint: docker daemon (${2}) is serving on ${DOCKER_HOST}" >&2
    return 0
  fi
  # The daemon's OWN log tail is the only thing that separates the causes worth separating (a
  # missing binary, a sandbox that forbids user namespaces, a slow start), so it rides into
  # the status file rather than staying in a file nobody reads. An external daemon has no such
  # log here, so it gets the one fact this container actually holds.
  if [ "$2" = external ]; then
    detail="the external daemon at ${DOCKER_HOST} did not answer within ${DOCKER_READY_TIMEOUT_SECONDS}s"
    write_docker_status false external unreachable "$detail"
  else
    detail="$(tail -c 2000 /tmp/dockerd.log 2>/dev/null || true)"
    write_docker_status false rootless failed "$detail"
  fi
  echo "entrypoint: docker daemon (${2}) did not serve within ${DOCKER_READY_TIMEOUT_SECONDS}s;" \
    "local infra is unavailable in this container. detail: ${detail}" >&2
}

# A self-hosted pool may point the harness at an external/sidecar Docker daemon instead of the
# in-container one: honour DOCKER_HOST and skip the rootless daemon. It is still PROBED — a
# wired-but-unreachable sidecar and a working one are opposite facts.
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "entrypoint: using external DOCKER_HOST=${DOCKER_HOST}; not starting rootless dockerd" >&2
  write_docker_status null external probing ''
  probe_docker '' external &
elif command -v dockerd-rootless.sh >/dev/null 2>&1 && command -v dockerd >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/harness/.docker/run}"
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
  mkdir -p "${XDG_RUNTIME_DIR}"
  write_docker_status null rootless probing ''
  # iptables is unavailable in many sandboxes (Cloudflare Containers); the daemon still works
  # for compose with the host/bridge networking the Tester relies on.
  dockerd-rootless.sh --iptables=false >/tmp/dockerd.log 2>&1 &
  probe_docker "$!" rootless &
else
  # Not a runtime failure but a missing PART: this branch is what the image looked like to
  # every job for months, and naming it is the difference between a Tester that says why it
  # ran no infra and one that just didn't.
  write_docker_status false none missing \
    'this image ships no rootless Docker daemon (dockerd / dockerd-rootless.sh not on PATH)'
  echo "entrypoint: no rootless docker present; local infra will be unavailable" >&2
fi

# NODE_ENV belongs to THIS process, not to the image: the harness runs in production mode,
# while the agent's checkout is a different project entirely, and an inherited
# `NODE_ENV=production` makes npm omit devDependencies there. `agentChildEnv` drops it again
# from everything the harness spawns into that checkout, so both halves stay true.
exec env NODE_ENV=production node dist/harness-server.js
