# Example production image for the Node.js service facade (@cat-factory/node-server).
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f deploy/node/Dockerfile -t cat-factory-node .
#   docker run --rm -p 8787:8787 --env-file deploy/node/.env cat-factory-node
#
# One stage: install + build the workspace, then re-resolve to PRODUCTION-only
# dependencies in place (drops dev tooling) and prune the pnpm store. No
# `pnpm deploy` (and so no `--legacy`); the entry runs directly via Node 24 type
# stripping. `CI=true` lets pnpm rewrite node_modules non-interactively. The service
# runs on any supported Node (>=20, e.g. Node 24 LTS); only the test suite pins Node 26
# (so undici's MockAgent matches the runtime's bundled undici).

FROM node:24-slim AS runtime
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
ENV PORT=8787

# pnpm straight from the registry, NOT via corepack: corepack runs every pnpm call through
# an extra Node wrapper of its own. Not `@pnpm/exe` either — the self-contained build links
# libatomic.so.1, which the slim base does not carry, and it would bundle a second Node
# beside the one this image already runs on. The version is read out of the workspace's own
# `packageManager` field (copied ahead of the tree so the layer caches independently of a
# source change), so the image can never install a pnpm that did not write the lockfile it
# installs from.
COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@').pop().split('+')[0]")"

# A .dockerignore (deploy/node/Dockerfile.dockerignore) keeps node_modules/dist/.git
# out of the context so the install is reproducible from the lockfile.
COPY . .

# Install everything, build every workspace library (incl. @cat-factory/node-server's
# dist), then prune to production deps only and shrink the store. `--offline` reuses
# the store populated by the first install; `--ignore-scripts` skips other packages'
# postinstall (e.g. the frontend's nuxt prepare), which the service doesn't need.
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm install --prod --frozen-lockfile --offline --ignore-scripts \
  && pnpm store prune

USER node
WORKDIR /app/deploy/node
EXPOSE 8787
# Env is injected by the orchestrator; `--env-file-if-exists` also picks up a
# mounted /app/deploy/node/.env without failing when none is present.
CMD ["node", "--env-file-if-exists=.env", "src/main.ts"]
