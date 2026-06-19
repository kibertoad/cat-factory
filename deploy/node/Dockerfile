# Example production image for the Node.js service facade (@cat-factory/node-server).
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f deploy/node/Dockerfile -t cat-factory-node .
#   docker run --rm -p 8787:8787 --env-file deploy/node/.env cat-factory-node
#
# Stage 1 installs the workspace, builds the libraries, and uses `pnpm deploy` to
# emit a self-contained /app (only @cat-factory/deploy-node + its production deps).
# Stage 2 is a slim runtime that runs the entry directly via Node 24 type stripping.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# Copy the whole workspace (a .dockerignore should exclude node_modules/dist/.git).
COPY . .
RUN pnpm install --frozen-lockfile
# Builds every workspace library, including @cat-factory/node-server's dist.
RUN pnpm build
# Prune to a deployable subset: deploy-node's files + its production dependencies.
# `--legacy` deploys without injected workspace packages (pnpm v10+ default-off).
RUN pnpm --filter @cat-factory/deploy-node deploy --prod --legacy /app

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
# Run as the unprivileged user the base image ships.
USER node
COPY --from=build --chown=node:node /app /app
EXPOSE 8787
# Env is injected by the orchestrator; `--env-file-if-exists` also picks up a
# mounted /app/.env without failing when none is present.
CMD ["node", "--env-file-if-exists=.env", "src/main.ts"]
