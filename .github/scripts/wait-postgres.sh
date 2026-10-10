#!/usr/bin/env bash
# Gate the test step on the background Postgres (see `start-postgres.sh`) actually serving.
#
# Probe over TCP (-h 127.0.0.1) rather than the default unix socket: postgres's init sequence
# runs a temporary socket-only server, so a socket probe reports ready DURING init and races the
# real server's restart. TCP only answers once the final server is up. `docker exec` simply fails
# while the image is still pulling — the loop tolerates that.
#
# Three outcomes, never one, because they need different fixes and only one of them is a bug in
# this repo:
#   - ready                        → exit 0
#   - the image never arrived      → the registry failed; say so, and do not call it a Postgres
#                                    problem (which is what sent a reader looking at the database
#                                    for a `registry-1.docker.io` timeout)
#   - the container exists but the server never answered → a real startup failure, with its logs
set -uo pipefail

CONTAINER="${POSTGRES_CONTAINER:-ci-postgres}"
FAILED_MARKER="${RUNNER_TEMP:-/tmp}/postgres-start.failed"
START_LOG="${RUNNER_TEMP:-/tmp}/postgres-start.log"
TIMEOUT_SECONDS="${POSTGRES_WAIT_SECONDS:-90}"

fail_with_start_log() {
  cat "$START_LOG" 2>/dev/null || true
  echo "::error::$1"
  exit 1
}

for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    exit 0
  fi
  # Checked every iteration rather than only after the timeout: once the starter has given up
  # there is nothing left to wait for, and burning the remaining budget only delays a failure
  # whose cause is already known.
  if [ -f "$FAILED_MARKER" ]; then
    fail_with_start_log \
      "Could not pull the Postgres image (container registry unreachable) — this is infrastructure, not a test failure"
  fi
  sleep 1
done

# Timed out. Which of the two remaining causes it is, is worth stating: an absent container means
# the pull was still in flight when the budget ran out (a slow registry rather than a dead one),
# while a present container means the server itself never came up.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  fail_with_start_log \
    "Postgres container was never created within ${TIMEOUT_SECONDS}s — the image pull did not finish"
fi

cat "$START_LOG" 2>/dev/null || true
docker logs "$CONTAINER" || true
echo "::error::Postgres did not become ready within ${TIMEOUT_SECONDS}s"
exit 1
