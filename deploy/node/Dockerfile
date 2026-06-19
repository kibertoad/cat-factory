# Example production image for the Node.js service facade (@cat-factory/node-server).
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f deploy/node/Dockerfile -t cat-factory-node .
#   docker run --rm -p 8787:8787 --env-file deploy/node/.env cat-factory-node
#
# One stage: install + build the workspace, then re-resolve to PRODUCTION-only
# dependencies in place (drops dev tooling) and prune the pnpm store. No
# `pnpm deploy` (and so no `--legacy`); the entry runs directly via Node 24 type
# stripping. `CI=true` lets pnpm rewrite node_modules non-interactively.

FROM node:24-slim AS runtime
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production
ENV PORT=8787
RUN corepack enable

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
