#!/bin/sh
# Container entrypoint. Starts a rootless Docker daemon (used by the Tester's local-mode infra
# stand-up, `docker compose up` for the service's dependencies), RECORDS whether it actually came
# up where the harness can read it, and execs the harness HTTP server.
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
# The daemon START and the readiness WAIT both run in the background and the harness is exec'd
# immediately, so a daemon that hangs costs a Tester its infra and never costs the container its
# boot window. That matters more now than it did: the rootless path picks its daemon on evidence
# and may have to abandon one and start another, which is two bounded waits, not one.
#
# What is recorded here is a BOOT verdict, and it is written once. A container outlives its boot
# (a warm pool serves many jobs from one), so a sidecar that needed longer than the wait allows
# would otherwise stay latched as unavailable for the container's whole life. The refusal is
# therefore not taken off this file alone: `resolveDockerVerdict` in src/docker-status.ts
# re-confirms a recorded absence against a live daemon before anything refuses on it, and reads
# the cause and log tail below only once that confirms. Neither half is redundant: the probe
# knows whether a daemon answers NOW, and only this file knows WHY one never did.
set -eu

# Where the verdict is recorded. Mirrors `DOCKER_STATUS_FILE` in src/docker-status.ts: the
# two halves of one contract, so change them together (the acceptance suite reads it).
DOCKER_STATUS_FILE="${HARNESS_DOCKER_STATUS_FILE:-/tmp/harness-docker-status.json}"
# How long a started daemon may take to answer before it counts as unavailable. Only a HUNG
# daemon pays this in full: the wait ends early both when the socket answers and when the
# daemon process is gone, which is what a packaging or sandbox failure looks like.
DOCKER_READY_TIMEOUT_SECONDS="${HARNESS_DOCKER_READY_TIMEOUT_SECONDS:-60}"
# How long the FIRST rootless arm (the daemon that manages its own firewall rules) may take
# before the `--iptables=false` fallback takes over. Deliberately shorter than the full wait:
# a sandbox that forbids iptables fails FAST, since the daemon exits and the wait below ends on
# the dead process rather than on the clock, so this ceiling is only ever paid by a daemon that
# HANGS. The fallback then gets the full wait, which keeps a slow-but-capable sandbox from being
# charged the same ceiling twice.
DOCKER_IPTABLES_READY_TIMEOUT_SECONDS="${HARNESS_DOCKER_IPTABLES_READY_TIMEOUT_SECONDS:-25}"
# How long an abandoned daemon may take to die before its replacement is started anyway.
DOCKER_STOP_TIMEOUT_SECONDS=10
# The rootless daemon's own log. Named once because BOTH arms below write to it, and the failure
# detail recorded for a total failure is its tail.
DOCKERD_LOG=/tmp/dockerd.log

# Escape a value for embedding in a JSON string: flatten every control character a log tail
# carries, bound the length, and only THEN escape backslashes and quotes (in that order, since
# the reverse would re-escape its own output).
#
# The order is the whole point, and both halves of it were wrong. Truncating AFTER escaping can
# cut a `\"` pair in half and leave a trailing lone backslash; flattening only newlines and tabs
# leaves the ANSI escapes and other C0 bytes a daemon log carries, which JSON forbids unescaped.
# Either one makes the status file unparseable, and an unparseable file reads as NO VERDICT, so
# the stand-up this whole mechanism exists to refuse would run compose against the daemon this
# container has already proved dead. Bound first, escape last, and drop what cannot be quoted.
json_string() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\001-\037\177' | cut -c1-2000 |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Record the verdict: available (JSON `true`/`false`/`null`), source, reason, human detail.
# `source` and `reason` are this script's own closed vocabularies (docker-status.ts holds the
# reader's copy), so only `detail` is escaped. Written to a temp file and RENAMED, because
# the harness reads this concurrently and a half-written file would parse as no answer at all.
#
# Recording is best-effort in exactly the way the daemon is. This runs in the FOREGROUND, before
# the harness is exec'd, so under `set -e` an unwritable path (a `HARNESS_DOCKER_STATUS_FILE`
# pointing at a directory that does not exist) would take the container's boot down with it,
# the opposite of the contract at the top of this file. A write that cannot land says so on
# stderr and returns; the harness then reads this container as having reached no verdict, which
# is the same honest answer it gave before any of this existed.
write_docker_status() {
  if ! {
    printf '{"available":%s,"source":"%s","reason":"%s","detail":"%s"}\n' \
      "$1" "$2" "$3" "$(json_string "${4:-}")" >"${DOCKER_STATUS_FILE}.tmp" &&
      mv "${DOCKER_STATUS_FILE}.tmp" "$DOCKER_STATUS_FILE"
  } 2>/dev/null; then
    echo "entrypoint: could not record the docker verdict at ${DOCKER_STATUS_FILE};" \
      "the harness will read this container as having reached no verdict" >&2
  fi
}

# Whether the daemon at DOCKER_HOST is serving. `docker version` talks to the SERVER (the
# client-only `docker --version` answers even with no daemon at all, which is precisely the
# state this exists to detect).
docker_serving() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

# Whether process $1 is still RUNNING, as opposed to merely still holding a pid.
#
# `kill -0` cannot answer that here. The daemon is a background child of THIS shell, which then
# `exec`s node in place, and node, as PID 1, reaps nothing. A daemon that dies at startup
# therefore lingers as a ZOMBIE, which `kill -0` reports as perfectly present. On `kill -0` the
# early exit below never fires at all: every packaging or sandbox failure costs the full
# readiness timeout, and each job dispatched inside that window reads the verdict as still
# undecided and attempts compose against a daemon that is already known to be dead.
#
# /proc's state field is what separates the two. The signal probe stays as the fallback for a
# runtime with no /proc, where it is still the best answer available.
process_alive() {
  if [ -r "/proc/$1/stat" ]; then
    # The comm field is parenthesised and may itself contain spaces, so the state is the first
    # field after the FINAL ')'.
    state="$(sed -e 's/.*) //' -e 's/ .*//' "/proc/$1/stat" 2>/dev/null || true)"
    [ -n "$state" ] && [ "$state" != Z ]
  else
    kill -0 "$1" 2>/dev/null
  fi
}

# Wait for the daemon, ending early on either outcome that is already decided. $1 is the pid
# to watch (empty for an external daemon, which this container did not start); $2 is how many
# seconds it may take. The ceiling is a PARAMETER because the rootless path below spends it
# twice, on two different daemons, and the first of them is deliberately given less.
await_docker() {
  waited=0
  while [ "$waited" -lt "$2" ]; do
    if docker_serving; then return 0; fi
    if [ -n "${1:-}" ] && ! process_alive "$1"; then
      # A launcher that forks the real daemon and exits looks identical to one that died, so
      # the socket gets the last word rather than the pid.
      if docker_serving; then return 0; fi
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# The background half for a daemon this container did NOT start: wait for it, and overwrite the
# `probing` status with the verdict.
probe_external_docker() {
  if await_docker '' "$DOCKER_READY_TIMEOUT_SECONDS"; then
    write_docker_status true external serving ''
    echo "entrypoint: docker daemon (external) is serving on ${DOCKER_HOST}" >&2
    return 0
  fi
  # An external daemon leaves no log in this container, so the detail is the one fact this
  # container actually holds.
  detail="the external daemon at ${DOCKER_HOST} did not answer within ${DOCKER_READY_TIMEOUT_SECONDS}s"
  write_docker_status false external unreachable "$detail"
  echo "entrypoint: docker daemon (external) did not serve within ${DOCKER_READY_TIMEOUT_SECONDS}s;" \
    "local infra is unavailable in this container. detail: ${detail}" >&2
}

# Start `dockerd-rootless.sh` in the background with the flags given, and record its pid in
# ROOTLESS_DAEMON_PID. $1 names the ARM, and becomes rootlesskit's own state directory: the two
# arms below get one each, so a daemon that had to be killed cannot leave a lock or a detached
# network namespace behind that stops its replacement from ever starting.
#
# The log is shared and APPENDED to, never truncated per arm. A total failure's tail is then the
# last arm's, which is the one whose failure is being explained, while a human reading the whole
# file still sees why the first arm was abandoned.
start_rootless_daemon() {
  arm="$1"
  shift
  DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR="${XDG_RUNTIME_DIR}/dockerd-rootless-${arm}" \
    dockerd-rootless.sh "$@" >>"$DOCKERD_LOG" 2>&1 &
  ROOTLESS_DAEMON_PID=$!
}

# Stop a daemon that did not serve, and WAIT for it to be gone before another takes its place.
# Not a formality: the replacement binds the same socket path, so a predecessor still tearing
# down would have its successor fail for a reason that has nothing to do with why it was started.
stop_rootless_daemon() {
  kill "$1" 2>/dev/null || true
  waited=0
  while [ "$waited" -lt "$DOCKER_STOP_TIMEOUT_SECONDS" ] && process_alive "$1"; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$1" 2>/dev/null || true
  rm -f "${XDG_RUNTIME_DIR}/docker.sock" 2>/dev/null || true
}

# Start the rootless daemon, preferring the one whose NESTED containers have a network.
#
# `--iptables=false` arrived when the daemon could not start at all without it, and it does fix
# that: a sandbox like Cloudflare Containers gives the daemon no way to install its firewall
# rules, and a daemon that cannot install them refuses to start. What went unnoticed is what the
# flag costs once the daemon DOES start. The rule it drops is the MASQUERADE for the bridge, so
# traffic from a nested container on 172.17.0.0/16 is never NATed onto the daemon's own
# interface: a nested container gets no egress whatsoever, no DNS and no raw IP either. The
# daemon's own `docker pull` keeps working, which is most of why this stayed hidden, and the cost
# lands on the one thing agents do constantly. A `docker build` whose `RUN npm ci` cannot reach
# the registry spends about seven minutes inside npm's retry backoff before failing, and from
# outside that reads as a hang rather than as a network that was never there (issue #2173).
#
# So the flag is a FALLBACK and not a premise. Try the daemon that manages its own rules, and
# start the crippled one only on the EVIDENCE that the first did not serve. A sandbox that
# genuinely cannot do iptables ends up exactly where it was; a privileged Docker or Podman host,
# which is what local mode runs on, gets working nested networking.
#
# Both arms record the same `available: true`, because both serve. What separates them is the
# `reason` word and the detail, and that is the half no measurement can supply: "this daemon
# installs no NAT rule" is a CAUSE, while the harness's own probe (src/docker-capability.ts)
# measures the consequence from inside a nested container without ever learning why.
start_rootless_docker() {
  : >"$DOCKERD_LOG" 2>/dev/null || true
  start_rootless_daemon iptables
  if await_docker "$ROOTLESS_DAEMON_PID" "$DOCKER_IPTABLES_READY_TIMEOUT_SECONDS"; then
    write_docker_status true rootless serving \
      'the daemon manages its own firewall rules, so nested containers are NATed and have egress'
    echo "entrypoint: docker daemon (rootless, with iptables) is serving on ${DOCKER_HOST}" >&2
    return 0
  fi
  echo "entrypoint: the rootless daemon did not serve within" \
    "${DOCKER_IPTABLES_READY_TIMEOUT_SECONDS}s with its own firewall rules; retrying with" \
    "--iptables=false, which leaves nested containers with no egress" >&2
  stop_rootless_daemon "$ROOTLESS_DAEMON_PID"
  start_rootless_daemon no-iptables --iptables=false
  if await_docker "$ROOTLESS_DAEMON_PID" "$DOCKER_READY_TIMEOUT_SECONDS"; then
    write_docker_status true rootless serving-without-nat \
      'iptables is unavailable here, so the daemon runs with --iptables=false: it installs no MASQUERADE rule for its bridge, and a NESTED container therefore has no egress at all'
    echo "entrypoint: docker daemon (rootless, --iptables=false) is serving on ${DOCKER_HOST};" \
      "nested containers have NO egress" >&2
    return 0
  fi
  # The daemon's OWN log tail is the only thing that separates the causes worth separating (a
  # missing binary, a sandbox that forbids user namespaces, a slow start), so it rides into
  # the status file rather than staying in a file nobody reads.
  detail="$(tail -c 2000 "$DOCKERD_LOG" 2>/dev/null || true)"
  write_docker_status false rootless failed "$detail"
  echo "entrypoint: docker daemon (rootless) did not serve on either arm;" \
    "local infra is unavailable in this container. detail: ${detail}" >&2
}

# A self-hosted pool may point the harness at an external/sidecar Docker daemon instead of the
# in-container one: honour DOCKER_HOST and skip the rootless daemon. It is still PROBED, because
# a wired-but-unreachable sidecar and a working one are opposite facts.
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "entrypoint: using external DOCKER_HOST=${DOCKER_HOST}; not starting rootless dockerd" >&2
  write_docker_status null external probing ''
  probe_external_docker &
elif command -v dockerd-rootless.sh >/dev/null 2>&1 && command -v dockerd >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/harness/.docker/run}"
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
  mkdir -p "${XDG_RUNTIME_DIR}"
  write_docker_status null rootless probing ''
  # Started INSIDE the background half, unlike the version before it, because the daemon this
  # container ends up with is now a choice made on evidence rather than a single fixed command
  # line: `start_rootless_docker` may have to abandon one daemon and start another, and none of
  # that may sit between this script and the `exec` below.
  start_rootless_docker &
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
