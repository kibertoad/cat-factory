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
# TODO: pin by @sha256:<digest> (node:26-trixie-slim@sha256:...) instead of the
# mutable tag once the digest can be resolved with registry access.
FROM node:26-trixie-slim AS runtime
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
ARG PI_VERSION=0.79.8
ARG CLAUDE_CODE_VERSION=2.0.30
ARG CODEX_VERSION=0.47.0
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; \
    if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"; \
    claude --version; codex --version; \
    git config --system --add safe.directory "*"'

WORKDIR /app
# Copy the compiled wrapper owned by the unprivileged user (no recursive chown
# layer). Done before USER so the build artifact lands owned correctly.
COPY --chown=harness:harness --from=build /app/dist ./dist
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

EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
