#!/bin/sh
# Container entrypoint. The deploy harness only shells out to kubectl/kustomize/helm
# against a remote apiserver (no local Docker daemon, unlike the executor harness),
# so there is nothing to bootstrap — just exec the HTTP server. Kept as a script so
# the image's ENTRYPOINT matches the executor harness's shape and a future hook
# (e.g. warming a helm cache) has a home.
set -eu

exec node dist/server.js
