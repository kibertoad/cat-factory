---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/integrations": minor
"@cat-factory/server": minor
"@cat-factory/orchestration": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/local-server": minor
"@cat-factory/app": minor
---

Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

- Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
- New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
- A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.
