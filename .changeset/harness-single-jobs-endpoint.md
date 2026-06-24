---
'@cat-factory/executor-harness': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
---

Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
agent kind carried in the request body, instead of one route per kind (`/run`,
`/bootstrap`, `/merge`, …).

Breaking wire change between the runtime transports and the harness image (acceptable
pre-1.0: the two ship together, no external consumers). The old per-kind-route image
is incompatible with the new transports, so the runner image MUST be republished and
deployed.

- Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
  a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
  registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
  entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
  image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
- Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
  it no longer collides with the reserved dispatch discriminator `kind`.
- Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
  body now sends `label` for its agent-kind label).
- Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
  `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
  forwards `kind` in the spec, so it needs no code change — only the manifest docs
  (kernel/contracts/integrations) are updated to note the harness routes by the body's
  `kind`.
