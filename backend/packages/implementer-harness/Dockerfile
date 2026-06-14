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

# ---- build: compile the TypeScript wrapper -------------------------------
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@^5.6.0 @types/node@^22.0.0 \
 && npx tsc -p tsconfig.json

# ---- runtime: git + the Pi CLI + the compiled wrapper --------------------
FROM node:26-trixie-slim AS runtime
ENV NODE_ENV=production
# git for clone/commit/push; the Pi coding-agent CLI (bring-your-own key at
# runtime — none is installed here). --ignore-scripts avoids running untrusted
# install hooks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts @earendil-works/pi-coding-agent
WORKDIR /app
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENTRYPOINT ["node", "dist/server.js"]
