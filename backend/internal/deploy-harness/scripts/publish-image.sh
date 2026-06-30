#!/usr/bin/env bash
#
# Publish the deploy-harness (Kubernetes render/apply) image to PUBLIC registries.
#
# Builds a multi-arch (linux/amd64 + linux/arm64) image with buildx and pushes it to
# GHCR and Docker Hub in a single build, tagged with the package version and `latest`.
# The image carries NO secrets (see the Dockerfile).
#
# This is the manual counterpart to the deploy-image job in
# .github/workflows/docker-publish.yml. Use it to publish on demand, or from a fork.
#
# Prereqs: docker with buildx; be logged in to each registry you target.
#
# Config (env vars, all optional):
#   REGISTRIES     space/comma list of: ghcr dockerhub   (default: "ghcr dockerhub")
#   GHCR_OWNER     GHCR namespace                          (default: kibertoad)
#   DOCKERHUB_ORG  Docker Hub namespace                    (default: kibertoad)
#   IMAGE_NAME     repository name                         (default: cat-factory-deploy)
#   TAG            primary tag                             (default: package.json version)
#   PUSH_LATEST    also tag :latest ("true"/"false")       (default: true)
#   PLATFORMS      buildx target platforms                 (default: linux/amd64,linux/arm64)
#   EXTRA_CA       path to a corporate proxy CA cert       (optional build secret)
#
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS_DIR"

REGISTRIES="${REGISTRIES:-ghcr dockerhub}"
GHCR_OWNER="${GHCR_OWNER:-kibertoad}"
DOCKERHUB_ORG="${DOCKERHUB_ORG:-kibertoad}"
IMAGE_NAME="${IMAGE_NAME:-cat-factory-deploy}"
TAG="${TAG:-$(node -p "require('./package.json').version")}"
PUSH_LATEST="${PUSH_LATEST:-true}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

tag_args=()
add_ref() {
  tag_args+=(-t "$1:$TAG")
  if [ "$PUSH_LATEST" = "true" ]; then
    tag_args+=(-t "$1:latest")
  fi
}
for reg in ${REGISTRIES//,/ }; do
  case "$reg" in
    ghcr)     add_ref "ghcr.io/${GHCR_OWNER}/${IMAGE_NAME}" ;;
    dockerhub) add_ref "docker.io/${DOCKERHUB_ORG}/${IMAGE_NAME}" ;;
    *) echo "Unknown registry '$reg' (expected: ghcr | dockerhub)" >&2; exit 1 ;;
  esac
done
if [ "${#tag_args[@]}" -eq 0 ]; then
  echo "No registries selected (set REGISTRIES=ghcr and/or dockerhub)." >&2
  exit 1
fi

BUILDER="catfactory-publisher"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

secret_args=()
if [ -n "${EXTRA_CA:-}" ]; then
  secret_args+=(--secret "id=extra_ca,src=${EXTRA_CA}")
fi

echo "Publishing ${IMAGE_NAME}:${TAG} (${PLATFORMS}) to: ${REGISTRIES}"
docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --file Dockerfile \
  "${secret_args[@]}" \
  "${tag_args[@]}" \
  --push \
  .

echo "Done."
