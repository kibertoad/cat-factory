---
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': patch
---

Run container agent steps on the Node service via a self-hosted runner pool, so the
Node facade no longer silently degrades repo-operating kinds (coder, mocker,
playwright, blueprints, ci-fixer, conflict-resolver, merger) to useless one-shot LLM
calls.

The container-execution machinery is now shared, not Worker-only:

- `@cat-factory/server` hosts the runtime-neutral `CompositeAgentExecutor`,
  `ContainerAgentExecutor` and `RunnerJobClient`, plus the Web-Crypto
  `WebCryptoSecretCipher` and GitHub-App auth (`GitHubAppAuth` / `GitHubAppRegistry`).
- `@cat-factory/integrations` hosts the manifest-driven runner-pool transport
  (`HttpRunnerPoolProvider` / `RunnerPoolTransport`).
- `@cat-factory/server` also hosts the runtime-neutral `buildResolveRepoTarget` (the
  security-sensitive block→service→repo ancestry walk, with its no-"first-repo"-fallback
  policy), so the Worker and Node service single-source it instead of keeping two
  hand-copied resolvers that could drift. Each facade just binds its own repositories.
- `@cat-factory/worker` keeps thin re-export shims at the old paths (no API change).

`@cat-factory/node-server` wires a `CompositeAgentExecutor` (inline + container) whose
container executor dispatches to a workspace's registered runner pool
(`RunnerPoolTransport`), resolving the run's repo + minting a short-lived GitHub
installation token exactly as the Worker does. New Postgres tables
(`runner_pool_connections`, `github_installations`, `github_repos`) mirror the D1
schema. It activates when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`,
`AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are configured; otherwise inline
kinds still work and container kinds fail loudly rather than faking success.
