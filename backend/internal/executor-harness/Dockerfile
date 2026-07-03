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
# Pinned by digest (the multi-arch index digest, valid for amd64 + arm64 via buildx)
# so two builds of this Dockerfile always pull the identical base — the mutable
# `node:26-trixie-slim` tag is kept in the line only for human readability. To bump:
# `docker buildx imagetools inspect node:26-trixie-slim` and update BOTH stages.
FROM node:26-trixie-slim@sha256:a1d9d671994fc2d26e297ac56b4b1522a8bc7fa71c43b14cd1b1fe6c5116f7dc AS build
WORKDIR /app
# Install the TS toolchain BEFORE copying src so editing harness source doesn't
# reinvalidate the dependency layer (helps local rebuilds; CI builds --no-cache).
COPY tsconfig.json ./
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install --no-save --no-package-lock typescript@^5.6.0 @types/node@^22.0.0'
COPY src ./src
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npx tsc -p tsconfig.json'

# ---- runtime: git + the Pi CLI + the compiled wrapper --------------------
# Pinned to the SAME digest as the build stage above (see that note to bump).
FROM node:26-trixie-slim@sha256:a1d9d671994fc2d26e297ac56b4b1522a8bc7fa71c43b14cd1b1fe6c5116f7dc AS runtime
ENV NODE_ENV=production

# Defense-in-depth: run as an unprivileged user, not root. Created up front so the
# extension installs below run as it and the config lands in a home it owns and can
# read+write at runtime. The work checkout lives in an os.tmpdir() mkdtemp dir,
# owned by this user, so clone/commit/push stay writable. HOME is set only AFTER the
# root setup below: with HOME=/home/harness during the root `npm install -g`, npm
# would seed a root-owned cache in /home/harness/.npm that the later as-harness
# `pi install` could not write (EACCES).
RUN groupadd --system harness \
    && useradd --system --gid harness --create-home --home-dir /home/harness harness
# Map a subuid/subgid range for the harness user so rootless Docker can run (the
# Tester's local-mode infra stand-up runs `docker compose up` for the service's
# dependencies). Required before the rootless daemon can create user namespaces.
RUN echo 'harness:100000:65536' > /etc/subuid \
    && echo 'harness:100000:65536' > /etc/subgid
# Root-only setup in one layer: git for clone/commit/push, the Pi coding-agent
# CLI (bring-your-own key at runtime — none is installed here; --ignore-scripts
# avoids running untrusted install hooks), and git's dubious-ownership guard
# disabled system-wide. This ephemeral container only ever operates on
# repositories we hand it (a fresh clone, or a mounted repo in tests), so a repo
# owned by another uid (e.g. a bind-mounted host repo) must not block clone/push;
# git only honours safe.directory from system/global config, never from env or -c.
# Pi is pinned to an exact version so the image is reproducible and a bad upstream
# release can't silently break a build — bump deliberately. node:26 is well past
# Pi's `legacy-node20` floor, so the default `latest` line applies.
# In addition to Pi, the image bundles the two SUBSCRIPTION harnesses — Claude
# Code and Codex — selected per job by the `harness` field of the job body. They
# carry no credentials either: a leased subscription OAuth token (Claude) /
# auth.json bundle (Codex) is handed over per job and the CLI talks DIRECT to the
# vendor (no proxy). All three pinned to exact versions for reproducibility — bump
# deliberately, and bump the image tag (see CONTRIBUTING / CLAUDE.md) when you do.
#
# Pi is pure JS, so it installs with `--ignore-scripts` (no untrusted install
# hooks). Claude Code and Codex, however, rely on their install scripts to place
# the right platform binary (Codex in particular ships a native binary), so they
# must be installed WITHOUT `--ignore-scripts` — otherwise the `claude` / `codex`
# CLI is missing or non-functional at runtime. We then assert both CLIs actually
# run so a broken install fails the build instead of every subscription job.
ARG PI_VERSION=0.80.3
ARG CLAUDE_CODE_VERSION=2.1.199
ARG CODEX_VERSION=0.142.5
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*; \
    if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"; \
    claude --version; codex --version; \
    git config --system --add safe.directory "*"'

# Rootless Docker + the compose plugin, for the Tester's local-mode infra stand-up.
# Cloudflare Containers (and most managed runners) run unprivileged, so we install
# the rootless extras and run the daemon as the `harness` user at runtime (see
# entrypoint.sh) — no privileged mode, no host docker socket. uidmap provides the
# newuidmap/newgidmap helpers user namespaces need; fuse-overlayfs is the rootless
# storage driver. Best-effort at runtime: if the sandbox forbids user namespaces the
# daemon simply won't start and the Tester degrades to no-infra (it never blocks the
# container from booting). Installed from Docker's official apt repo, pinned to the
# Debian release the base image uses (trixie).
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; export CURL_CA_BUNDLE=/tmp/extra_ca.crt; fi; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-ce-rootless-extras uidmap fuse-overlayfs && rm -rf /var/lib/apt/lists/*'

WORKDIR /app
# Copy the compiled wrapper owned by the unprivileged user (no recursive chown
# layer). Done before USER so the build artifact lands owned correctly.
COPY --chown=harness:harness --from=build /app/dist ./dist
# The entrypoint that starts rootless dockerd (best-effort) then the server.
COPY --chown=harness:harness entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
# Drop privileges before the Pi extension installs so they write to this user's
# HOME already owned by it — no post-install chown of the extension tree needed.
# HOME is set here (not before the root steps) so the as-harness npm cache is clean.
ENV HOME=/home/harness
USER harness

# Install Pi extensions (as the harness user, into its own HOME). rpiv-todo gives
# Pi a `todo` tool to plan multi-step work: we don't read its TUI overlay (headless
# json mode no-ops the widget); we tap the structured `tool_result` events it emits
# so the harness can report subtask progress (e.g. "3/8 done") to the Worker.
# rpiv-web-tools (same lockstep monorepo / version) gives Pi `web_search` +
# `web_fetch`, inert unless a deployment configures a provider in the container env
# (e.g. BRAVE_SEARCH_API_KEY / TAVILY_API_KEY, or SEARXNG_URL); the harness then
# auto-detects it, writes the config and nudges the agent to use the tools
# (WEB_SEARCH_PROVIDER pins the active provider). No key is baked into the image.
# Both pinned for the same reproducibility reason as Pi itself.
ARG PI_TODO_EXTENSION_VERSION=1.20.0
ARG PI_WEB_TOOLS_EXTENSION_VERSION=1.20.0
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    pi install "npm:@juicesharp/rpiv-todo@${PI_TODO_EXTENSION_VERSION}"; \
    pi install "npm:@juicesharp/rpiv-web-tools@${PI_WEB_TOOLS_EXTENSION_VERSION}"'

# Rootless Docker runtime config for the harness user (consumed by entrypoint.sh).
ENV XDG_RUNTIME_DIR=/home/harness/.docker/run \
    DOCKER_HOST=
EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
