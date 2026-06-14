# syntax=docker/dockerfile:1
#
# Implementation container image. Runs the Pi coding agent behind a thin TS
# wrapper that clones a repo, lets Pi implement a block, and opens a PR.
#
# SECURITY: this image carries NO secrets. It has no provider API keys and no
# GitHub credentials baked in. Per job, the Worker passes a short-lived GitHub
# token and an LLM-proxy session token in the POST /run body at runtime; Pi
# reaches models only through the Worker proxy. The build context is just this
# package directory (the tsconfig is self-contained).
#
# Behind a TLS-inspecting (corporate / sandbox) proxy, pass that proxy's CA as a
# build secret so npm trusts the registry — it is used only during the build and
# never persisted in the image:
#   docker build --secret id=extra_ca,src=/path/to/ca.crt -f Dockerfile .
# With no secret the build behaves normally (public registries, default trust).

# ---- build: compile the TypeScript wrapper -------------------------------
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install --no-save typescript@^5.6.0 @types/node@^22.0.0 && npx tsc -p tsconfig.json'

# ---- runtime: git + the Pi CLI + the compiled wrapper --------------------
FROM node:26-trixie-slim AS runtime
ENV NODE_ENV=production
# git for clone/commit/push; the Pi coding-agent CLI (bring-your-own key at
# runtime — none is installed here). --ignore-scripts avoids running untrusted
# install hooks.
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; \
    if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
# This ephemeral container runs as root and only ever operates on repositories we
# hand it (a fresh clone, or a mounted repo in tests). Disable git's
# dubious-ownership guard system-wide so a repo owned by another uid (e.g. a
# bind-mounted host repo) doesn't block clone/push. NB: git only honours
# safe.directory from system/global config, never from env or -c.
RUN git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
