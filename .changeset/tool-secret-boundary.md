---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Close the tool-secret boundary, and give `ToolSecretResolver` a facade seam.

**Behaviour break (deliberate).** A capability credential — a tool server's `secretKeys`, a
generative binary integration's `credential.key` — may no longer name an environment variable the
platform itself reads. Such a definition names both the key it wants and the endpoint that key is
sent to, so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a registration
that booted clean and injected the deployment's master sealing key into a prompt-injectable agent
process. It is now refused at declaration (a schema issue for a generative integration, a
`reserved_credential_key` boot error for a tool server) and again at dispatch, where the capability
is reported to the agent as unavailable — a tool server under its own `reserved_secret` reason,
kept apart from `missing_secret` because the two need opposite fixes. A deployment that named a
platform variable must give the integration a variable of its own; the population is expected to be
empty, but this fails at boot rather than silently.

**New seam.** `startLocal`, `start` and `createWorker` each take a `createToolSecretResolver`
factory, defaulting to today's `createEnvToolSecretResolver(env)`. Reaching the port used to mean
abandoning the facade and reassembling the boot sequence, so the per-workspace credential store the
port was designed for — and the `allowKeys` bound its own documentation recommended — were both
unreachable.
