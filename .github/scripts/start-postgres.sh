#!/usr/bin/env bash
# Start the job-private Postgres container that the Postgres-backed suites (`test-db`) and the
# Playwright e2e lane both need.
#
# Run in the BACKGROUND by its caller, so the image pull hides behind setup + build instead of
# running serially before the job's first step (which is why this is not a `services:` block).
# `wait-postgres.sh` is what gates the test step.
#
# The pull is RETRIED, which is the whole reason this is a script rather than one inline
# `docker run`. `docker run` pulls implicitly, so a transient registry failure — a
# `registry-1.docker.io` connect timeout is the observed one — left no container behind at all,
# and the only symptom was the readiness loop spending its full 90s budget and then blaming
# Postgres for a failure that happened in Docker Hub. Retrying costs nothing when the pull
# succeeds first time, which is the normal case.
#
# On terminal failure it leaves a marker file rather than just exiting non-zero: nothing waits on
# this process, so the exit code has no reader. The marker is how the wait step tells "the image
# never arrived" from "the server is still starting" — two failures with completely different
# fixes, and one of them is not ours to fix.
set -uo pipefail

IMAGE="${POSTGRES_IMAGE:-postgres:18}"
CONTAINER="${POSTGRES_CONTAINER:-ci-postgres}"
FAILED_MARKER="${RUNNER_TEMP:-/tmp}/postgres-start.failed"
ATTEMPTS="${POSTGRES_PULL_ATTEMPTS:-4}"

rm -f "$FAILED_MARKER"

# Pull explicitly (rather than letting `docker run` do it implicitly) so a failure is
# attributable and retryable on its own. Backoff is linear and short: the failure mode is a
# connect timeout that has already cost ~90s, so the budget is better spent on another attempt
# than on waiting politely.
pulled=false
for attempt in $(seq 1 "$ATTEMPTS"); do
  if docker pull "$IMAGE"; then
    pulled=true
    break
  fi
  echo "docker pull $IMAGE failed (attempt $attempt/$ATTEMPTS)"
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep $((attempt * 5))
done

if [ "$pulled" != true ]; then
  echo "giving up: could not pull $IMAGE after $ATTEMPTS attempts"
  touch "$FAILED_MARKER"
  exit 1
fi

# The image is local now, so this cannot fail on the registry. A name collision cannot happen
# either: each shard is its own runner VM.
if ! docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cat_factory_test \
  -p 5432:5432 "$IMAGE"; then
  echo "giving up: docker run failed for $IMAGE"
  touch "$FAILED_MARKER"
  exit 1
fi
