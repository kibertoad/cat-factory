---
'@cat-factory/contracts': minor
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/eks': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

A typing pass that removes the casts a better type, a generic or a guard could carry.

New in `@cat-factory/contracts`: `parseStoredProviderConfig(schema, raw, label)`, the one place a
native environment backend re-reads its own config off a stored manifest's `providerConfig`. The
Kubernetes, Cloudflare and EKS backends used to assert that value; a config written before a schema
change (or edited in the database) therefore flowed on as a fake-valid object and misbehaved deep
inside a provision instead of being named at the boundary. Those three now THROW on an off-contract
stored config where they previously carried on.

Behaviour changes worth knowing about:

- The Worker's bindings are read through `envVar` / `envVars`, which filter by `typeof`. A binding
  that is not a string (a D1 database, a queue, a Durable Object namespace) now reads as absent
  where the previous assertion handed it on as a string.
- `SlackApiClient.chatPostMessage` takes the rendered `SlackMessageBody` instead of an arbitrary
  `Record<string, unknown>`. `SlackMessageBody` and `DeployJobSpec` are type aliases rather than
  interfaces so they keep the implicit index signature their JSON sinks need.
- The workspace-RBAC mount tag is read through a shape guard; an unrelated object stored under the
  same symbol no longer reads as a permission gate.

Everything else is type-level only: typed `queryAll` / `queryOne` helpers behind the local
`node:sqlite` stores (the row shape is now checked to be one SQLite could produce), a `BadgeColor`
derived from `UBadge`'s own prop type so the SPA's chip maps agree with the component, and the
Kubernetes engine form building its config as the contract's discriminated union.
