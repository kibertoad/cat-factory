#!/bin/sh
# Container entrypoint. Starts a rootless Docker daemon in the background — used by
# the Tester's local-mode infra stand-up (`docker compose up` for the service's
# dependencies) — then execs the harness HTTP server. Rootless is mandatory:
# Cloudflare Containers (and most managed runners) run without root or privileged
# mode, so the daemon runs under the unprivileged `harness` user via
# `dockerd-rootless.sh`. Best-effort: if the daemon can't start (e.g. the runtime
# disallows user namespaces), we log and continue — the Tester degrades to running
# whatever tests it can without standing infra up, rather than failing the container.
set -eu

# A self-hosted pool may point the harness at an external/sidecar Docker daemon
# instead of the in-container one: honour DOCKER_HOST and skip the rootless daemon.
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "entrypoint: using external DOCKER_HOST=${DOCKER_HOST}; not starting rootless dockerd" >&2
elif command -v dockerd-rootless.sh >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/harness/.docker/run}"
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
  mkdir -p "${XDG_RUNTIME_DIR}"
  # iptables is unavailable in many sandboxes (Cloudflare Containers); the daemon
  # still works for compose with the host/bridge networking the Tester relies on.
  (dockerd-rootless.sh --iptables=false >/tmp/dockerd.log 2>&1 &) || \
    echo "entrypoint: rootless dockerd failed to start; local infra will be unavailable" >&2
else
  echo "entrypoint: no rootless docker present; local infra will be unavailable" >&2
fi

exec node dist/server.js
