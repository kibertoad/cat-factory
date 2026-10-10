#!/usr/bin/env bash
#
# Build the UI-tester image and BOOT it, then run scripts/ui-image-checks.sh inside.
#
# Why a boot test rather than a build: everything this image exists for is runtime behaviour.
# `docker build` succeeding proves the layers ran, not that Chromium launches, that the harness
# user can write its own npm cache, or that the WireMock jar is a jar. Each of those has a
# failure mode that is invisible until a real `tester-ui` job is minutes into a run, and reports
# back as an `abort` that names none of them.
#
# CI runs this on any change to the image's sources (.github/workflows/ui-image-smoketest.yml);
# it is the same command locally, and the only prerequisite is a working Docker daemon.
#
# Config (env vars, all optional):
#   BASE_IMAGE   the executor image to layer on. Default: built from ./Dockerfile in this run, so
#                the smoketest covers the pair as they will actually ship. Point it at a
#                published tag (e.g. ghcr.io/kibertoad/cat-factory-executor:latest) to skip that
#                build when iterating on the UI layer alone.
#   UI_IMAGE     tag for the image built here          (default: cat-factory-executor-ui:smoketest)
#   KEEP         "true" leaves the container running for poking at (default: false)
#
# Usage:
#   ./scripts/smoketest-ui-image.sh
#   BASE_IMAGE=ghcr.io/kibertoad/cat-factory-executor:latest ./scripts/smoketest-ui-image.sh
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS_DIR"

UI_IMAGE="${UI_IMAGE:-cat-factory-executor-ui:smoketest}"
KEEP="${KEEP:-false}"
CONTAINER="cat-factory-ui-smoketest-$$"

# The port the harness binds, read from its own source for the same reason as the versions below.
HARNESS_PORT="$(sed -n 's/.*DEFAULT_HARNESS_PORT = \([0-9]*\).*/\1/p' src/harness-port.ts | head -1)"
[ -n "${HARNESS_PORT}" ] || { echo "Could not read DEFAULT_HARNESS_PORT from src/harness-port.ts" >&2; exit 1; }

# The versions the checks assert, read from the Dockerfile itself rather than restated here: a
# copy would pass while the image shipped something else, which is the drift the checks exist to
# catch in the first place.
EXPECT_PNPM="$(sed -n 's/.*npm install -g pnpm@\([^ ]*\) .*/\1/p' Dockerfile.ui | head -1)"
EXPECT_YARN="$(sed -n 's/.*@yarnpkg\/cli-dist@\([^ ]*\).*/\1/p' Dockerfile.ui | head -1)"
[ -n "${EXPECT_PNPM}" ] || { echo "Could not read the pinned pnpm version from Dockerfile.ui" >&2; exit 1; }
[ -n "${EXPECT_YARN}" ] || { echo "Could not read the pinned yarn version from Dockerfile.ui" >&2; exit 1; }
echo "Pinned in Dockerfile.ui: pnpm ${EXPECT_PNPM}, yarn ${EXPECT_YARN}"

if [ -z "${BASE_IMAGE:-}" ]; then
  BASE_IMAGE="cat-factory-executor:smoketest"
  echo "== building the base executor image (${BASE_IMAGE}) =="
  docker build --file Dockerfile --tag "${BASE_IMAGE}" .
fi

echo "== building the UI image (${UI_IMAGE}) on ${BASE_IMAGE} =="
docker build --file Dockerfile.ui --build-arg "BASE_IMAGE=${BASE_IMAGE}" --tag "${UI_IMAGE}" .

cleanup() {
  if [ "${KEEP}" = "true" ]; then
    echo "KEEP=true: leaving ${CONTAINER} running (docker rm -f ${CONTAINER} when done)"
    return
  fi
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== booting ${CONTAINER} =="
# The same inbound-auth secret the transports inject, so the boot path under test is the one a
# real dispatch takes rather than the unauthenticated variant.
docker run -d --name "${CONTAINER}" -e HARNESS_SHARED_SECRET=smoketest-secret "${UI_IMAGE}" >/dev/null

# The harness HTTP server is the image's contract with every transport: if it does not come up,
# nothing else about the image matters.
echo "== waiting for the harness to serve /health =="
healthy=false
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" curl -fsS http://127.0.0.1:${HARNESS_PORT}/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
if [ "${healthy}" != "true" ]; then
  echo "The harness never answered /health. Container logs:" >&2
  docker logs "${CONTAINER}" >&2 || true
  exit 1
fi
echo "  ok: /health answered"

# The version the harness reports IS what a mismatched-image dispatch is failed on, so it has to
# match the package this image was built from.
expected_version="$(node -p "require('./package.json').version")"
reported="$(docker exec "${CONTAINER}" curl -fsS http://127.0.0.1:${HARNESS_PORT}/health)"
echo "  health: ${reported}"
case "${reported}" in
  *"${expected_version}"*) echo "  ok: reports harness version ${expected_version}" ;;
  *) echo "The harness reports a version that is not ${expected_version}: ${reported}" >&2; exit 1 ;;
esac

echo "== running the in-container checks =="
docker cp scripts/ui-image-checks.sh "${CONTAINER}:/tmp/ui-image-checks.sh"
# As the harness user, which is who every job actually runs as. Running these as root would pass
# over exactly the permission defects they are here to find.
docker exec --user harness \
  -e "EXPECT_PNPM=${EXPECT_PNPM}" \
  -e "EXPECT_YARN=${EXPECT_YARN}" \
  "${CONTAINER}" bash /tmp/ui-image-checks.sh

echo "UI image smoketest PASSED (${UI_IMAGE})"
