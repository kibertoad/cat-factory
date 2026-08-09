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

That re-read is split by what the operation USES, which is the difference between a loud refusal
and an environment nobody can reclaim. Standing one up parses the whole config; tearing one down
parses only the connection (`kubernetesConnectionConfigSchema` / `eksConnectionConfigSchema` /
`cloudflareConnectionConfigSchema`), so a `manifestSource`, `url` or `workersSubdomain` that
stopped matching the contract still fails a provision and can never strand a live namespace or
preview. The fields the reclaim itself reads stay validated: there is no safe default for which
cluster to delete from, and none for a GitHub Enterprise API root whose fallback is the public one.

Behaviour changes worth knowing about:

- The Worker's bindings are read through `envVar` / `envVars`, which filter by `typeof`. A binding
  that is not a string (a D1 database, a queue, a Durable Object namespace) now reads as absent
  where the previous assertion handed it on as a string.
- `SlackApiClient.chatPostMessage` takes the rendered `SlackMessageBody` instead of an arbitrary
  `Record<string, unknown>`. `SlackMessageBody` and `DeployJobSpec` are type aliases rather than
  interfaces so they keep the implicit index signature their JSON sinks need.
- The workspace-RBAC mount tag is read through a shape guard; an unrelated object stored under the
  same symbol no longer reads as a permission gate.

- `EksEnvironmentProvider` parses its own superset config. It inherited the Kubernetes parse, and
  a valibot object drops entries it does not declare, so `region` / `clusterName` / `stsHost` were
  read off a config that no longer had them: every EKS call was presigning its apiserver token
  against `sts.undefined.amazonaws.com`.
- The Kubernetes engine form narrows a stored `url.source` through `isKubernetesUrlSource`, a guard
  derived from the contract variant's own members. The discriminant is a closed vocabulary that is
  nonetheless persisted, so a config naming a source this build does not define now falls back to
  the form's default rather than reaching an exhaustive `switch` with no branch for it.

Everything else is type-level only: typed `queryAll` / `queryOne` helpers behind the local
`node:sqlite` stores (the row shape is now checked to be one SQLite could produce), a `BadgeColor`
derived from `UBadge`'s own prop type so the SPA's chip maps agree with the component, and the
Kubernetes engine form building its config as the contract's discriminated union.
