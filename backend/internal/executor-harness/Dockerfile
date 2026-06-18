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
# Only tsconfig + src are needed to compile. The package.json is deliberately NOT
# copied: the image's runtime uses only Node built-ins + the global Pi CLI, and
# the package's dev/test deps (incl. pnpm `workspace:*` entries npm can't parse)
# are irrelevant here. typescript/@types/node are installed standalone.
# TODO: pin by @sha256:<digest> (node:26-trixie-slim@sha256:...) instead of the
# mutable tag once the digest can be resolved with registry access.
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install --no-save --no-package-lock typescript@^5.6.0 @types/node@^22.0.0 && npx tsc -p tsconfig.json'

# ---- runtime: git + the Pi CLI + the compiled wrapper --------------------
# TODO: pin by @sha256:<digest> (node:26-trixie-slim@sha256:...) instead of the
# mutable tag once the digest can be resolved with registry access.
FROM node:26-trixie-slim AS runtime
ENV NODE_ENV=production

# Defense-in-depth: run as an unprivileged user, not root. Created before the Pi
# installs so HOME points at this user's home and the extension/config land in a
# location it owns and can read+write at runtime. The work checkout lives in an
# os.tmpdir() mkdtemp dir, owned by this user, so clone/commit/push stay writable.
RUN groupadd --system harness \
    && useradd --system --gid harness --create-home --home-dir /home/harness harness
ENV HOME=/home/harness
# git for clone/commit/push; the Pi coding-agent CLI (bring-your-own key at
# runtime — none is installed here). --ignore-scripts avoids running untrusted
# install hooks.
# Pi is pinned to an exact version so the image is reproducible and a bad
# upstream release can't silently break a build — bump deliberately. node:26 is
# well past Pi's `legacy-node20` floor, so the default `latest` line applies.
ARG PI_VERSION=0.79.7
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; \
    if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"'

# Install the rpiv-todo extension globally so Pi exposes a `todo` tool the model
# can use to plan multi-step work. We don't read its TUI overlay (headless json
# mode no-ops the widget); we tap the structured `tool_result` events it emits so
# the harness can report subtask progress (e.g. "3/8 done") back to the Worker.
# Pinned for the same reproducibility reason as Pi itself. HOME (set above to the
# unprivileged user's home) is where `pi install` writes the extension + settings;
# the final chown hands ownership to that user so it can read them at runtime.
ARG PI_TODO_EXTENSION_VERSION=1.20.0
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    pi install "npm:@juicesharp/rpiv-todo@${PI_TODO_EXTENSION_VERSION}"'
# This ephemeral container only ever operates on repositories we hand it (a fresh
# clone, or a mounted repo in tests). Disable git's dubious-ownership guard
# system-wide so a repo owned by another uid (e.g. a bind-mounted host repo)
# doesn't block clone/push. NB: git only honours safe.directory from
# system/global config, never from env or -c.
RUN git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/dist ./dist
# Hand the app dir and the user's home (Pi config/extension) to the unprivileged
# user, then drop privileges for the running process.
RUN chown -R harness:harness /app /home/harness
USER harness
EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
