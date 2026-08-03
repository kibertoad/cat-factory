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

**Behaviour break (deliberate).** A capability credential (a tool server's `secretKeys`, a
generative binary integration's `credential.key`) may no longer be LOOKED UP BY an environment
variable the platform itself reads. Such a definition names both the key it wants and the endpoint
that key is sent to, so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a
registration that booted clean and injected the deployment's master sealing key into a
prompt-injectable agent process. It is now refused at declaration (a schema issue for a generative
integration, a `reserved_credential_key` boot error for a tool server) and again at dispatch, where
the capability is reported to the agent as unavailable: a tool server under its own
`reserved_secret` reason, kept apart from `missing_secret` because the two need opposite fixes.

**New `envName`.** The floor binds the LOOKUP key alone. A declaration that needs a specific
variable in the process it configures sets `envName` beside its `key`
(`{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }`), and that name is held
only to the narrower toolchain rule, since it reads nothing. Without the split the reserved
families would make the commonest MCP servers unusable with no workaround open to a deployment,
because `GITHUB_`, `SLACK_` and `AWS_` cover names the platform does not read and a vendor's own
SDK does. A deployment that named a platform variable as its lookup key now fails at boot rather
than silently; a deployment that needs the vendor's name in the process keeps it via `envName`.

**New seam.** `startLocal`, `start` and `createWorker` each take a `createToolSecretResolver`
factory, defaulting to the platform's own chain (the per-workspace credential store in front of
`createEnvToolSecretResolver(env)`). Reaching the port used to mean abandoning the facade and
reassembling the boot sequence, so the per-workspace credential store the port was designed for,
and the `allowKeys` bound its own documentation recommended, were both unreachable. On the Worker
the option registers the resolver process-wide (`registerToolSecretResolverFactory`), because a
Worker builds a container per entry point and container agents are dispatched by the durable
driver, which sees no option held on the app.

Also: the Node executor's default env resolver now reads the injected `env` rather than
`process.env` directly, so an embedded boot or a test that supplies one is no longer bypassed.
