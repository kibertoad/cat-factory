#!/usr/bin/env bash
#
# Publish the executor-harness (Pi coding-agent) runner image to PUBLIC registries.
#
# Builds a multi-arch (linux/amd64 + linux/arm64) image with buildx and pushes it
# to GHCR and Docker Hub in a single build, tagged with the package version and
# `latest`, so anyone can `docker pull` it without building from source. The image
# carries NO secrets (see the Dockerfile).
#
# This is the manual counterpart to .github/workflows/docker-publish.yml, which
# runs the same publish on every image-affecting push to main. Use this to publish
# on demand, or from a fork to publish under your own namespaces.
#
# Prereqs:
#   - docker with buildx (Docker Desktop / a recent Docker Engine ships it).
#   - You must be logged in to each registry you target:
#       echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
#       echo "$DOCKERHUB_TOKEN" | docker login -u <dockerhub-user> --password-stdin
#
# Config (env vars, all optional):
#   REGISTRIES     space/comma list of: ghcr dockerhub   (default: "ghcr dockerhub")
#   GHCR_OWNER     GHCR namespace                          (default: kibertoad)
#   DOCKERHUB_ORG  Docker Hub namespace                    (default: kibertoad)
#   IMAGE_NAME     repository name                         (default: cat-factory-executor)
#   TAG            primary tag                             (default: package.json version)
#   PUSH_LATEST    also tag :latest ("true"/"false")       (default: true)
#   PLATFORMS      buildx target platforms                 (default: linux/amd64,linux/arm64)
#   EXTRA_CA       path to a corporate proxy CA cert       (optional build secret)
#
# Usage:
#   ./scripts/publish-image.sh                 # publish version + latest to both registries
#   REGISTRIES=ghcr ./scripts/publish-image.sh # GHCR only
#   TAG=0.6.0-rc1 PUSH_LATEST=false ./scripts/publish-image.sh
#
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS_DIR"

REGISTRIES="${REGISTRIES:-ghcr dockerhub}"
GHCR_OWNER="${GHCR_OWNER:-kibertoad}"
DOCKERHUB_ORG="${DOCKERHUB_ORG:-kibertoad}"
IMAGE_NAME="${IMAGE_NAME:-cat-factory-executor}"
TAG="${TAG:-$(node -p "require('./package.json').version")}"
PUSH_LATEST="${PUSH_LATEST:-true}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

# Build the list of `-t <ref>` tag args across the selected registries.
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

# Multi-arch push needs a buildx builder backed by the container driver; the
# default 'docker' driver can't build/push more than one platform. Create a
# dedicated builder once and reuse it.
BUILDER="catfactory-publisher"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

secret_args=()
if [ -n "${EXTRA_CA:-}" ]; then
  secret_args+=(--secret "id=extra_ca,src=${EXTRA_CA}")
fi

echo "Publishing ${IMAGE_NAME}:${TAG} (${PLATFORMS}) to: ${REGISTRIES}"
for arg in "${tag_args[@]}"; do
  [ "$arg" = "-t" ] || echo "  $arg"
done

docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --file Dockerfile \
  "${secret_args[@]}" \
  "${tag_args[@]}" \
  --push \
  .

echo "Done. Pull with e.g.:"
for reg in ${REGISTRIES//,/ }; do
  case "$reg" in
    ghcr)     echo "  docker pull ghcr.io/${GHCR_OWNER}/${IMAGE_NAME}:${TAG}" ;;
    dockerhub) echo "  docker pull docker.io/${DOCKERHUB_ORG}/${IMAGE_NAME}:${TAG}" ;;
  esac
done
